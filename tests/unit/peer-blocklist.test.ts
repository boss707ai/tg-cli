import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fork feature: the read-access blocklist guard inside resolveEntity — raw input
// is rejected BEFORE any network lookup, the resolved entity AFTER it — layered
// over upstream's throwResolutionError / NOT_A_MEMBER handling.

vi.mock('telegram', () => ({
  Api: {
    messages: {
      CheckChatInvite: vi.fn().mockImplementation((args: any) => ({ hash: args.hash, className: 'messages.CheckChatInvite' })),
    },
  },
}));

const originalBlocklist = process.env.TG_BLOCKLIST;
let dir: string;

/** blocklist.ts caches its file per process: write a file, re-import peer.ts. */
async function peerWith(lines: string[]) {
  writeFileSync(join(dir, 'blocked-chats.txt'), lines.join('\n'));
  process.env.TG_BLOCKLIST = join(dir, 'blocked-chats.txt');
  vi.resetModules();
  return import('../../src/lib/peer.js');
}

function client(overrides: Record<string, any> = {}) {
  return {
    getEntity: vi.fn().mockResolvedValue({ id: BigInt(123), className: 'Channel' }),
    invoke: vi.fn().mockResolvedValue({ chat: { id: BigInt(456), className: 'Channel' } }),
    iterDialogs: vi.fn(async function* () {}),
    ...overrides,
  } as any;
}

describe('resolveEntity: read-access blocklist guard', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-peer-blocklist-'));
  });
  afterEach(() => {
    if (originalBlocklist === undefined) delete process.env.TG_BLOCKLIST;
    else process.env.TG_BLOCKLIST = originalBlocklist;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['bare id', '1234567890', '1234567890'],
    ['-100 marked id', '-1001234567890', '1234567890'],
    ['bare id listed as marked', '1234567890', '-1001234567890'],
    ['@username', '@secret_chan', '@secret_chan'],
    ['username without @', 'Secret_Chan', '@secret_chan'],
  ])('rejects blocked raw input (%s) with CHAT_BLOCKED before any network call', async (_name, input, entry) => {
    const { resolveEntity } = await peerWith([entry]);
    const c = client();
    await expect(resolveEntity(c, input)).rejects.toMatchObject({ code: 'CHAT_BLOCKED' });
    expect(c.getEntity).not.toHaveBeenCalled();
    expect(c.iterDialogs).not.toHaveBeenCalled();
  });

  it('rejects a username that resolves to a blocked id (checked after resolve)', async () => {
    const { resolveEntity } = await peerWith(['-1009876543210']);
    const c = client({ getEntity: vi.fn().mockResolvedValue({ id: BigInt('9876543210'), className: 'Channel', username: 'renamed' }) });
    await expect(resolveEntity(c, '@renamed')).rejects.toMatchObject({ code: 'CHAT_BLOCKED' });
    expect(c.getEntity).toHaveBeenCalledWith('renamed');
  });

  it('rejects a numeric id whose resolved entity has a blocked username', async () => {
    const { resolveEntity } = await peerWith(['@secret_chan']);
    const c = client({ getEntity: vi.fn().mockResolvedValue({ id: BigInt(77), className: 'Channel', username: 'Secret_Chan' }) });
    await expect(resolveEntity(c, '77')).rejects.toMatchObject({ code: 'CHAT_BLOCKED' });
  });

  it('type:private blocks a resolved user but lets channels through', async () => {
    const { resolveEntity } = await peerWith(['type:private']);
    const user = client({ getEntity: vi.fn().mockResolvedValue({ id: BigInt(5), className: 'User' }) });
    await expect(resolveEntity(user, '@someone')).rejects.toMatchObject({ code: 'CHAT_BLOCKED' });
    const phone = client({ getEntity: vi.fn().mockResolvedValue({ id: BigInt(5), className: 'User' }) });
    await expect(resolveEntity(phone, '+15551234567')).rejects.toMatchObject({ code: 'CHAT_BLOCKED' });
    const channel = client();
    await expect(resolveEntity(channel, '@news')).resolves.toMatchObject({ className: 'Channel' });
  });

  it('rejects an invite link whose chat is blocked', async () => {
    const { resolveEntity } = await peerWith(['456']);
    const c = client();
    await expect(resolveEntity(c, 'https://t.me/+abcdef')).rejects.toMatchObject({ code: 'CHAT_BLOCKED' });
  });

  it('keeps upstream NOT_A_MEMBER for invite previews without a chat', async () => {
    const { resolveEntity } = await peerWith(['999']);
    const c = client({ invoke: vi.fn().mockResolvedValue({ className: 'ChatInvite' }) });
    await expect(resolveEntity(c, 'https://t.me/+preview')).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  it('lets unlisted chats through unchanged', async () => {
    const { resolveEntity } = await peerWith(['111', '@other']);
    const entity = { id: BigInt(123), className: 'Channel', username: 'open' };
    const c = client({ getEntity: vi.fn().mockResolvedValue(entity) });
    await expect(resolveEntity(c, '@open')).resolves.toBe(entity);
  });
});

describe('resolveEntity: numeric id cache warm-up (fork) over upstream error handling', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-peer-blocklist-'));
  });
  afterEach(() => {
    if (originalBlocklist === undefined) delete process.env.TG_BLOCKLIST;
    else process.env.TG_BLOCKLIST = originalBlocklist;
    rmSync(dir, { recursive: true, force: true });
  });

  const notCached = () => new Error('Could not find the input entity for {"userId":"42","className":"PeerUser"}');

  it('warms the entity cache via iterDialogs when the id is not cached', async () => {
    const { resolveEntity } = await peerWith([]);
    const entity = { id: BigInt(42), className: 'User' };
    const c = client({
      getEntity: vi.fn().mockRejectedValue(notCached()),
      iterDialogs: vi.fn(async function* () {
        yield { entity: { id: BigInt(1), className: 'Channel' } };
        yield { entity };
      }),
    });
    await expect(resolveEntity(c, '42')).resolves.toBe(entity);
    expect(c.iterDialogs).toHaveBeenCalledWith({ limit: 400 });
  });

  it('retries getEntity once after the warm-up (marked ids resolve from the warmed cache)', async () => {
    const { resolveEntity } = await peerWith([]);
    const entity = { id: BigInt(1234567890), className: 'Channel' };
    const c = client({
      getEntity: vi.fn().mockRejectedValueOnce(notCached()).mockResolvedValueOnce(entity),
    });
    await expect(resolveEntity(c, '-1001234567890')).resolves.toBe(entity);
    expect(c.getEntity).toHaveBeenCalledTimes(2);
  });

  it('applies the blocklist to the entity found during warm-up', async () => {
    const { resolveEntity } = await peerWith(['type:private']);
    const c = client({
      getEntity: vi.fn().mockRejectedValue(notCached()),
      iterDialogs: vi.fn(async function* () {
        yield { entity: { id: BigInt(42), className: 'User' } };
      }),
    });
    await expect(resolveEntity(c, '42')).rejects.toMatchObject({ code: 'CHAT_BLOCKED' });
  });

  it('maps a still-missing id to PEER_NOT_FOUND after the warm-up', async () => {
    const { resolveEntity } = await peerWith([]);
    const c = client({ getEntity: vi.fn().mockRejectedValue(notCached()) });
    await expect(resolveEntity(c, '42')).rejects.toMatchObject({ code: 'PEER_NOT_FOUND' });
    expect(c.iterDialogs).toHaveBeenCalledOnce();
  });

  it('does not warm up (or mask) transport failures', async () => {
    const { resolveEntity } = await peerWith([]);
    const error = new Error('connection reset');
    const c = client({ getEntity: vi.fn().mockRejectedValue(error) });
    await expect(resolveEntity(c, '42')).rejects.toBe(error);
    expect(c.iterDialogs).not.toHaveBeenCalled();
  });
});
