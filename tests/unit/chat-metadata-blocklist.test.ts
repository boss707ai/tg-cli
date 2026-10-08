import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api } from 'telegram';
import bigInt from 'big-integer';

// Fork: commands that reveal chat metadata without resolveEntity also honour the
// read-access blocklist:
// - chat invite-info: a blocked chat entity returned by CheckChatInvite -> CHAT_BLOCKED;
// - chat join <invite>: CheckChatInvite first; a known blocked chat -> CHAT_BLOCKED
//   BEFORE ImportChatInvite;
// - chat similar / chat search: blocked channels are dropped from the list.
// Real blocklist.ts with a temporary file; Telegram is a synthetic stub.

const state = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../src/lib/output.js', () => ({ outputSuccess: state.success, outputError: state.error, logStatus: vi.fn() }));

const { client } = vi.hoisted(() => ({
  client: { invoke: vi.fn(), getEntity: vi.fn(), getInputEntity: vi.fn(), iterDialogs: vi.fn() } as any,
}));
// Like the real withAuth: a thrown TgError becomes an error envelope with its code.
vi.mock('../../src/lib/with-auth.js', () => ({
  withAuth: async (_opts: unknown, fn: any) => {
    try {
      await fn(client);
    } catch (err: any) {
      state.error(err.message, err.code ?? err.errorMessage);
    }
  },
}));

const photo = new Api.ChatPhotoEmpty();
const channel = (id: number, title: string, username?: string) => new Api.Channel({
  id: bigInt(id), accessHash: bigInt(id + 1), title, username, photo, date: 1_700_000_000, broadcast: true, participantsCount: 10,
});
const open = channel(1234567890, 'Open channel', 'open_chan');
const secret = channel(555, 'Secret channel'); // blocked by id
const named = channel(556, 'Named secret', 'secret_chan'); // blocked by @username
const secretGroup = new Api.Chat({ id: bigInt(557), title: 'Secret basic group', photo, participantsCount: 3, date: 1_700_000_000, version: 1 });

let dir: string;
const originalBlocklist = process.env.TG_BLOCKLIST;
let chatInviteInfoAction: typeof import('../../src/commands/chat/invite-info.js').chatInviteInfoAction;
let chatJoinAction: typeof import('../../src/commands/chat/join.js').chatJoinAction;
let chatSimilarAction: typeof import('../../src/commands/chat/similar.js').chatSimilarAction;
let chatSearchAction: typeof import('../../src/commands/chat/search.js').chatSearchAction;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-chat-metadata-blocklist-'));
  writeFileSync(join(dir, 'blocked-chats.txt'), ['# synthetic', '-100555', '@secret_chan', '557'].join('\n'));
  process.env.TG_BLOCKLIST = join(dir, 'blocked-chats.txt');
  vi.resetModules(); // blocklist.ts reads and caches its file once per process
  ({ chatInviteInfoAction } = await import('../../src/commands/chat/invite-info.js'));
  ({ chatJoinAction } = await import('../../src/commands/chat/join.js'));
  ({ chatSimilarAction } = await import('../../src/commands/chat/similar.js'));
  ({ chatSearchAction } = await import('../../src/commands/chat/search.js'));
});

afterAll(() => {
  if (originalBlocklist === undefined) delete process.env.TG_BLOCKLIST;
  else process.env.TG_BLOCKLIST = originalBlocklist;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (opts: Record<string, unknown> = {}) => ({ optsWithGlobals: () => ({ profile: 'default', ...opts }) }) as any;
const output = () => state.success.mock.calls[0][0];
const requests = () => client.invoke.mock.calls.map(([request]: any[]) => request.className);
const LINK = 'https://t.me/+AbCdEf123';

describe('chat invite-info / join: blocked chat behind an invite link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.invoke.mockReset(); // drop queued responses a failed case left behind
  });

  it.each([
    ['ChatInviteAlready (by id)', () => new Api.ChatInviteAlready({ chat: secret })],
    ['ChatInvitePeek (by @username)', () => new Api.ChatInvitePeek({ chat: named, expires: 1_700_000_100 })],
    ['ChatInviteAlready (basic group by id)', () => new Api.ChatInviteAlready({ chat: secretGroup })],
  ])('invite-info refuses %s with CHAT_BLOCKED', async (_name, invite) => {
    client.invoke.mockResolvedValueOnce(invite());
    await chatInviteInfoAction.call(ctx(), LINK);
    expect(state.success).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith(expect.stringContaining('blocked'), 'CHAT_BLOCKED');
  });

  it('invite-info still describes an open chat', async () => {
    client.invoke.mockResolvedValueOnce(new Api.ChatInviteAlready({ chat: open }));
    await chatInviteInfoAction.call(ctx(), LINK);
    expect(output()).toMatchObject({ alreadyMember: true, chat: { title: 'Open channel' } });
  });

  it('join by invite refuses a known blocked chat before ImportChatInvite', async () => {
    client.invoke.mockResolvedValueOnce(new Api.ChatInvitePeek({ chat: secret, expires: 1_700_000_100 }));
    await chatJoinAction.call(ctx(), LINK);
    expect(state.error).toHaveBeenCalledWith(expect.stringContaining('blocked'), 'CHAT_BLOCKED');
    expect(requests()).toEqual(['messages.CheckChatInvite']);
    expect(state.success).not.toHaveBeenCalled();
  });

  it('join by invite proceeds when the chat is unknown (ChatInvite) or open', async () => {
    client.invoke
      .mockResolvedValueOnce(new Api.ChatInvite({ title: 'Some group', participantsCount: 5, photo: new Api.PhotoEmpty({ id: bigInt(0) }), color: 0 }))
      .mockResolvedValueOnce({ chats: [open] });
    await chatJoinAction.call(ctx(), LINK);
    expect(requests()).toEqual(['messages.CheckChatInvite', 'messages.ImportChatInvite']);
    expect(output()).toMatchObject({ joined: true, chat: { title: 'Open channel' } });
  });

  it('join by username is refused by resolveEntity before any request', async () => {
    await chatJoinAction.call(ctx(), '@secret_chan');
    expect(state.error).toHaveBeenCalledWith(expect.stringContaining('blocked'), 'CHAT_BLOCKED');
    expect(client.invoke).not.toHaveBeenCalled();
    expect(client.getEntity).not.toHaveBeenCalled();
  });
});

describe('chat similar / chat search: blocked channels are dropped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.invoke.mockReset(); // drop queued responses a failed case left behind
  });

  it('chat similar drops blocked channels and lowers totalAvailable by the number hidden', async () => {
    client.invoke.mockResolvedValueOnce(new Api.messages.ChatsSlice({ count: 40, chats: [open, secret, named] }));
    await chatSimilarAction.call(ctx(), undefined);
    expect(output().chats.map((c: any) => c.title)).toEqual(['Open channel']);
    expect(output()).toMatchObject({ total: 1, totalAvailable: 38 });
    expect(JSON.stringify(output())).not.toMatch(/Secret|secret_chan/);
  });

  it('chat similar without a count reports the visible list size', async () => {
    client.invoke.mockResolvedValueOnce(new Api.messages.Chats({ chats: [secret, open] }));
    await chatSimilarAction.call(ctx(), undefined);
    expect(output()).toMatchObject({ chats: [{ title: 'Open channel' }], total: 1, totalAvailable: 1 });
  });

  it('chat search drops blocked channels and groups', async () => {
    client.invoke.mockResolvedValueOnce(new Api.contacts.Found({ myResults: [], results: [], users: [], chats: [secret, open, named, secretGroup] }));
    await chatSearchAction.call(ctx({ limit: '20' }), 'secret');
    expect(output()).toEqual({ chats: [expect.objectContaining({ title: 'Open channel' })], total: 1 });
  });
});
