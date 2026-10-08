import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api } from 'telegram';
import bigInt from 'big-integer';

// Owner decision: `message search --chat a,b` where b is on the read-access
// blocklist returns results for a and only warns on stderr (logStatus) — no
// partial/errors entry and no exit 1 for CHAT_BLOCKED. Other failures keep
// upstream's batch semantics. Real blocklist.ts with a temporary file.

const state = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), status: vi.fn() }));
vi.mock('../../src/lib/output.js', () => ({ outputSuccess: state.success, outputError: state.error, logStatus: state.status }));

const { client } = vi.hoisted(() => ({
  client: { getEntity: vi.fn(), getMessages: vi.fn(), iterDialogs: vi.fn() } as any,
}));
vi.mock('../../src/lib/with-auth.js', () => ({ withAuth: async (_opts: unknown, fn: any) => fn(client) }));

const photo = new Api.ChatPhotoEmpty();
const open = new Api.Channel({ id: bigInt(1234567890), accessHash: bigInt(1), title: 'Open channel', username: 'open_chan', photo, date: 1_700_000_000, broadcast: true });
const other = new Api.Channel({ id: bigInt(1234567891), accessHash: bigInt(2), title: 'Other channel', username: 'other_chan', photo, date: 1_700_000_000, broadcast: true });

function hit(id: number, text: string, chat: Api.Channel): Api.Message {
  const message = new Api.Message({ id, date: 1_700_000_000 + id, message: text, peerId: new Api.PeerChannel({ channelId: chat.id }) });
  (message as any)._chat = chat;
  return message;
}

let dir: string;
const originalBlocklist = process.env.TG_BLOCKLIST;
let messageSearchAction: typeof import('../../src/commands/message/search.js').messageSearchAction;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-multi-search-blocklist-'));
  writeFileSync(join(dir, 'blocked-chats.txt'), ['# synthetic', '@secret_chan', '-100556'].join('\n'));
  process.env.TG_BLOCKLIST = join(dir, 'blocked-chats.txt');
  vi.resetModules(); // blocklist.ts reads and caches its file once per process
  ({ messageSearchAction } = await import('../../src/commands/message/search.js'));
});

afterAll(() => {
  if (originalBlocklist === undefined) delete process.env.TG_BLOCKLIST;
  else process.env.TG_BLOCKLIST = originalBlocklist;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (chat: string) => ({ optsWithGlobals: () => ({ profile: 'default', query: 'needle', chat, limit: '50', offset: '0' }) }) as any;
const output = () => state.success.mock.calls[0][0];

describe('multi-chat message search: blocked chats are skipped silently (direct path)', () => {
  const exitCode = process.exitCode;
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    client.getEntity.mockImplementation(async (input: string) => {
      const peers: Record<string, Api.Channel> = { open_chan: open, other_chan: other };
      if (peers[input]) return peers[input];
      throw Object.assign(new Error('USERNAME_NOT_OCCUPIED'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
    });
    client.getMessages.mockImplementation(async (entity: Api.Channel) => [hit(entity === open ? 1 : 2, `needle in ${entity.title}`, entity)]);
  });
  afterEach(() => { process.exitCode = exitCode; });

  it('returns results of the open chat, warns on stderr only, exit code stays 0', async () => {
    await messageSearchAction.call(ctx('open_chan,secret_chan'));
    expect(state.error).not.toHaveBeenCalled();
    expect(output()).toEqual({ messages: [expect.objectContaining({ text: 'needle in Open channel' })], total: 1, partial: false, errors: [] });
    expect(state.status).toHaveBeenCalledWith(expect.stringContaining('secret_chan'), undefined);
    expect(process.exitCode).toBe(0);
    expect(client.getEntity).not.toHaveBeenCalledWith('secret_chan');
  });

  it('only blocked chats listed: successful empty result, exit code 0', async () => {
    await messageSearchAction.call(ctx('secret_chan,-100556'));
    expect(output()).toEqual({ messages: [], total: 0, partial: false, errors: [] });
    expect(state.status).toHaveBeenCalledTimes(2);
    expect(client.getMessages).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('other failures keep upstream partial/errors and exit 1; the blocked chat is not among them', async () => {
    await messageSearchAction.call(ctx('open_chan,secret_chan,missing_chan,other_chan'));
    expect(output().messages.map((m: any) => m.text).sort()).toEqual(['needle in Open channel', 'needle in Other channel']);
    expect(output().partial).toBe(true);
    expect(output().errors).toEqual([expect.objectContaining({ input: 'missing_chan' })]);
    expect(process.exitCode).toBe(1);
  });
});
