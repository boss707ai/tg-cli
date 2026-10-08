import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api } from 'telegram';
import bigInt from 'big-integer';

// Fork: comments on a channel post live in the linked discussion supergroup, and
// messages.GetReplies returns them from there. The channel passes resolveEntity,
// so the replies themselves must be checked: a blocked discussion group's
// messages never reach stdout, and total drops by the number hidden.
// Real blocklist.ts (temporary file), real replies handler and serializer.

const mockOutputSuccess = vi.fn();
const mockOutputError = vi.fn();
vi.mock('../../src/lib/output.js', () => ({
  outputSuccess: (...args: any[]) => mockOutputSuccess(...args),
  outputError: (...args: any[]) => mockOutputError(...args),
  logStatus: vi.fn(),
}));

const { client } = vi.hoisted(() => ({
  client: { getEntity: vi.fn(), invoke: vi.fn(), iterDialogs: vi.fn() } as any,
}));
vi.mock('../../src/lib/with-auth.js', () => ({
  withAuth: async (_opts: any, fn: any) => fn(client),
}));

const photo = new Api.ChatPhotoEmpty();
const channel = new Api.Channel({ id: bigInt(1234567890), accessHash: bigInt(1), title: 'Open channel', username: 'open_chan', photo, date: 1_700_000_000, broadcast: true });
const secretGroup = new Api.Channel({ id: bigInt(777), accessHash: bigInt(2), title: 'Secret discussion', photo, date: 1_700_000_000, megagroup: true });
const namedGroup = new Api.Channel({ id: bigInt(779), accessHash: bigInt(4), title: 'Named discussion', username: 'secret_talk', photo, date: 1_700_000_000, megagroup: true });
const openGroup = new Api.Channel({ id: bigInt(778), accessHash: bigInt(3), title: 'Open discussion', photo, date: 1_700_000_000, megagroup: true });
const author = new Api.User({ id: bigInt(9), accessHash: bigInt(5), firstName: 'Commenter' });

function comment(id: number, text: string, group: Api.Channel): Api.Message {
  return new Api.Message({
    id, date: 1_700_000_000 + id, message: text,
    peerId: new Api.PeerChannel({ channelId: group.id }),
    fromId: new Api.PeerUser({ userId: author.id }),
  });
}

function replies(messages: Api.Message[], count: number) {
  return { className: 'messages.ChannelMessages', messages, chats: [channel, secretGroup, namedGroup, openGroup], users: [author], count };
}

let dir: string;
const originalBlocklist = process.env.TG_BLOCKLIST;
let messageRepliesAction: typeof import('../../src/commands/message/replies.js').messageRepliesAction;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-replies-blocklist-'));
  writeFileSync(join(dir, 'blocked-chats.txt'), ['# synthetic', '-100777', '@secret_talk'].join('\n'));
  process.env.TG_BLOCKLIST = join(dir, 'blocked-chats.txt');
  vi.resetModules(); // blocklist.ts reads and caches its file once per process
  ({ messageRepliesAction } = await import('../../src/commands/message/replies.js'));
});

afterAll(() => {
  if (originalBlocklist === undefined) delete process.env.TG_BLOCKLIST;
  else process.env.TG_BLOCKLIST = originalBlocklist;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ optsWithGlobals: () => ({ profile: 'default', limit: '50', offset: '0' }) }) as any;
const output = () => mockOutputSuccess.mock.calls[0][0];

describe('message replies: blocked discussion group (direct path)', () => {
  const originalExitCode = process.exitCode;
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = originalExitCode;
    client.getEntity.mockResolvedValue(channel);
  });

  it('drops comments from a discussion group blocked by id and lowers total', async () => {
    client.invoke.mockResolvedValueOnce(replies([comment(1, 'secret comment one', secretGroup), comment(2, 'secret comment two', secretGroup)], 2));
    await messageRepliesAction.call(ctx(), '@open_chan', '42');
    expect(mockOutputError).not.toHaveBeenCalled();
    expect(output()).toMatchObject({ messages: [], total: 0, postId: 42 });
    expect(JSON.stringify(output())).not.toMatch(/secret comment/);
  });

  it('drops comments from a discussion group blocked by @username (via the response entity)', async () => {
    client.invoke.mockResolvedValueOnce(replies([comment(3, 'named secret', namedGroup)], 1));
    await messageRepliesAction.call(ctx(), '@open_chan', '42');
    expect(output()).toMatchObject({ messages: [], total: 0 });
  });

  it('keeps comments from an open discussion group; total drops only by the hidden ones', async () => {
    client.invoke.mockResolvedValueOnce(replies([comment(4, 'open comment', openGroup), comment(1, 'secret comment one', secretGroup)], 7));
    await messageRepliesAction.call(ctx(), '@open_chan', '42');
    expect(output().messages.map((m: any) => m.text)).toEqual(['open comment']);
    expect(output().total).toBe(6);
  });

  it('filters every post in batch mode and keeps exit code 0', async () => {
    client.invoke
      .mockResolvedValueOnce(replies([comment(1, 'secret comment one', secretGroup)], 1))
      .mockResolvedValueOnce(replies([comment(4, 'open comment', openGroup)], 1));
    await messageRepliesAction.call(ctx(), '@open_chan', '10,20');
    expect(output().posts).toEqual([
      expect.objectContaining({ postId: 10, messages: [], total: 0 }),
      expect.objectContaining({ postId: 20, total: 1, messages: [expect.objectContaining({ text: 'open comment' })] }),
    ]);
    expect(output().partial).toBe(false);
    expect(JSON.stringify(output())).not.toMatch(/secret comment/);
    expect(process.exitCode).toBe(originalExitCode);
  });
});
