import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api } from 'telegram';
import bigInt from 'big-integer';

// The read-access blocklist must hold for commands executed by the daemon:
// execute runs the same handlers, so peers go through the same resolveEntity
// guard, and global search applies the same isBlockedPeer filter.

const photo = new Api.ChatPhotoEmpty();
const open = new Api.Channel({ id: bigInt(1234567890), accessHash: bigInt(10), title: 'Open channel', username: 'open_chan', photo, date: 1_700_000_000, broadcast: true });
const secret = new Api.Channel({ id: bigInt(555), accessHash: bigInt(11), title: 'Secret channel', username: 'secret_chan', photo, date: 1_700_000_000, broadcast: true });
const renamed = new Api.Channel({ id: bigInt(556), accessHash: bigInt(12), title: 'Renamed secret', username: 'new_name', photo, date: 1_700_000_000, broadcast: true });
const friend = new Api.User({ id: bigInt(8), accessHash: bigInt(22), firstName: 'Private', lastName: 'Friend' });

function hit(id: number, text: string, chat: Api.Channel | Api.User): Api.Message {
  const message = new Api.Message({
    id, date: 1_700_000_000 + id, message: text,
    peerId: chat instanceof Api.Channel ? new Api.PeerChannel({ channelId: chat.id }) : new Api.PeerUser({ userId: chat.id }),
  });
  (message as any)._chat = chat;
  return message;
}

let dir: string;
const originalBlocklist = process.env.TG_BLOCKLIST;
let executeDaemonCommand: typeof import('../../src/lib/daemon/execute.js').executeDaemonCommand;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-daemon-blocklist-'));
  writeFileSync(join(dir, 'blocked-chats.txt'), ['# synthetic', '@secret_chan', '-100556', '8'].join('\n'));
  process.env.TG_BLOCKLIST = join(dir, 'blocked-chats.txt');
  vi.resetModules(); // blocklist.ts reads and caches its file once per process
  ({ executeDaemonCommand } = await import('../../src/lib/daemon/execute.js'));
});

afterAll(() => {
  if (originalBlocklist === undefined) delete process.env.TG_BLOCKLIST;
  else process.env.TG_BLOCKLIST = originalBlocklist;
  rmSync(dir, { recursive: true, force: true });
});

describe('blocklist on the daemon execution path', () => {
  let client: any;
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    client = {
      getEntity: vi.fn(async (input: string | number) => {
        const peers: Record<string, any> = { open_chan: open, secret_chan: secret, new_name: renamed, '-1001234567890': open, '-100555': secret };
        const entity = peers[String(input)];
        if (entity) return entity;
        throw Object.assign(new Error('USERNAME_NOT_OCCUPIED'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
      }),
      getMessages: vi.fn().mockResolvedValue(Object.assign([hit(1, 'open history', open)], { total: 1 })),
      getDialogs: vi.fn().mockResolvedValue([]),
      iterMessages: vi.fn((_entity: unknown, options: { limit: number }) => {
        const hits = [hit(11, 'needle open', open), hit(12, 'needle secret', secret), hit(13, 'needle friend', friend), hit(14, 'needle renamed', renamed)];
        return { total: 40, async *[Symbol.asyncIterator]() { yield* hits.slice(0, options.limit); } };
      }),
      invoke: vi.fn(),
      sendMessage: vi.fn(),
    };
  });

  const run = async (argv: string[]) => {
    // Media commands need an absolute caller cwd on the daemon path.
    const extras = argv[0] === 'media' ? { cwd: dir } : {};
    const result = await executeDaemonCommand(client, 'default', { argv, ...extras }, new AbortController().signal);
    expect(process.exitCode).toBe(previousExitCode); // never the daemon's own exit status
    return result;
  };

  it.each([
    [['chat', 'info', '--', '@secret_chan']],
    [['message', 'history', '--', 'secret_chan']],
    [['message', 'history', '--', '-100556']],
    [['message', 'history', '--', '556']],
    [['message', 'get', '--', '556', '1']],
    [['message', 'send', '--', '8', 'hello']],
    [['message', 'click', '--text=Yes', '--', '@secret_chan', '42']],
    [['chat', 'similar', '--', 'secret_chan']],
    [['media', 'download', '--', '@secret_chan', '1']],
  ])('rejects a blocked raw input with CHAT_BLOCKED before any Telegram call: %j', async (argv) => {
    const result = await run(argv);
    expect(result).toMatchObject({ output: { ok: false, code: 'CHAT_BLOCKED' }, exitCode: 1 });
    expect(client.getEntity).not.toHaveBeenCalled();
    expect(client.getMessages).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.invoke).not.toHaveBeenCalled();
  });

  it('rejects a marked id whose resolved entity has a blocked username (checked after resolve)', async () => {
    const result = await run(['message', 'history', '--', '-100555']);
    expect(result).toMatchObject({ output: { ok: false, code: 'CHAT_BLOCKED' }, exitCode: 1 });
    expect(client.getEntity).toHaveBeenCalledWith(-100555);
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it('rejects a username that resolves to a blocked id (checked after resolve)', async () => {
    const result = await run(['message', 'history', '--', '@new_name']);
    expect(result).toMatchObject({ output: { ok: false, code: 'CHAT_BLOCKED' }, exitCode: 1 });
    expect(client.getEntity).toHaveBeenCalledWith('new_name');
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it('serves unblocked chats normally', async () => {
    const result = await run(['message', 'history', '--', '@open_chan']);
    expect(result).toMatchObject({ output: { ok: true, data: { messages: [{ text: 'open history' }] } }, exitCode: 0 });
  });

  it('global message search drops blocked chats and lowers total', async () => {
    const result = await run(['message', 'search', '--query=needle', '--limit=10']);
    expect(result.exitCode).toBe(0);
    const data = (result.output as any).data;
    expect(data.messages.map((m: any) => m.text)).toEqual(['needle open']);
    expect(data.total).toBe(37);
    expect(JSON.stringify(result.output)).not.toMatch(/secret|friend|renamed/i);
  });

  // Owner decision: a blocked chat in a multi-chat search is skipped silently
  // (warning on stderr only) — no partial/errors entry, no exit 1.
  it('multi-chat search silently skips a blocked chat', async () => {
    const result = await run(['message', 'search', '--query=open', '--chat=open_chan,secret_chan']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual({
      ok: true,
      data: { messages: [expect.objectContaining({ text: 'open history' })], total: 1, partial: false, errors: [] },
    });
    expect(JSON.stringify(result.output)).not.toMatch(/secret|CHAT_BLOCKED/);
    expect(client.getMessages).toHaveBeenCalledOnce();
  });

  it('multi-chat search over only blocked chats is an empty success', async () => {
    const result = await run(['message', 'search', '--query=open', '--chat=secret_chan,-100556']);
    expect(result).toEqual({ output: { ok: true, data: { messages: [], total: 0, partial: false, errors: [] } }, exitCode: 0 });
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it('multi-chat search keeps upstream partial semantics for other failures', async () => {
    const result = await run(['message', 'search', '--query=open', '--chat=open_chan,secret_chan,missing_chan']);
    expect(result.exitCode).toBe(1);
    const data = (result.output as any).data;
    expect(data).toMatchObject({ messages: [{ text: 'open history' }], partial: true });
    expect(data.errors).toEqual([expect.objectContaining({ input: 'missing_chan' })]);
    expect(data.errors[0].code).not.toBe('CHAT_BLOCKED');
  });

  it('message replies drops comments from a blocked discussion group of an open channel', async () => {
    const author = new Api.User({ id: bigInt(9), accessHash: bigInt(23), firstName: 'Commenter' });
    const comment = (id: number, text: string, group: Api.Channel) => new Api.Message({
      id, date: 1_700_000_000 + id, message: text,
      peerId: new Api.PeerChannel({ channelId: group.id }), fromId: new Api.PeerUser({ userId: author.id }),
    });
    // `renamed` (-100556) plays the linked discussion group; the channel itself is open.
    client.invoke.mockResolvedValueOnce({
      className: 'messages.ChannelMessages',
      messages: [comment(1, 'comment in blocked group', renamed), comment(2, 'another blocked comment', renamed)],
      chats: [open, renamed], users: [author], count: 2,
    });
    const result = await run(['message', 'replies', '--', 'open_chan', '42']);
    expect(result).toMatchObject({ output: { ok: true, data: { messages: [], total: 0, postId: 42 } }, exitCode: 0 });
    expect(JSON.stringify(result.output)).not.toMatch(/blocked group|blocked comment/);
  });

  it('chat list hides blocked dialogs', async () => {
    const dialog = (entity: Api.Channel | Api.User, id: string) => ({
      id: bigInt(id), title: (entity as any).title ?? 'Private Friend', entity,
      isChannel: entity instanceof Api.Channel, isUser: entity instanceof Api.User, isGroup: false, unreadCount: 0,
    });
    client.getDialogs.mockResolvedValueOnce([dialog(open, '-1001234567890'), dialog(secret, '-100555'), dialog(friend, '8'), dialog(renamed, '-100556')]);
    const result = await run(['chat', 'list']);
    expect((result.output as any).data).toMatchObject({ chats: [{ title: 'Open channel' }], total: 1 });
  });
});
