import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// blocklist.ts reads $TG_BLOCKLIST once at import and caches it,
// so every test writes its own file and re-imports the module.
let dir: string;
// Restore (not delete) TG_BLOCKLIST: the vitest config points it at an absent
// file so no test ever falls back to the real ~/.config/tg-cli/blocked-chats.txt.
const originalBlocklist = process.env.TG_BLOCKLIST;

async function loadWith(lines: string[]) {
  writeFileSync(join(dir, 'blocked-chats.txt'), lines.join('\n'));
  process.env.TG_BLOCKLIST = join(dir, 'blocked-chats.txt');
  vi.resetModules();
  return import('../../src/lib/blocklist.js');
}

describe('blocklist: isBlockedPeer (global search results)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-blocklist-'));
  });
  afterEach(() => {
    if (originalBlocklist === undefined) delete process.env.TG_BLOCKLIST;
    else process.env.TG_BLOCKLIST = originalBlocklist;
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks a channel listed by marked id', async () => {
    const { isBlockedPeer } = await loadWith(['-1001234567890']);
    expect(isBlockedPeer({ channelId: BigInt('1234567890'), chatId: null, userId: null })).toBe(true);
  });

  it('blocks a basic group listed by bare id', async () => {
    const { isBlockedPeer } = await loadWith(['# comment', '', '555']);
    expect(isBlockedPeer({ channelId: null, chatId: BigInt(555), userId: null })).toBe(true);
  });

  it('blocks by chat entity username', async () => {
    const { isBlockedPeer } = await loadWith(['@secret_chan']);
    expect(
      isBlockedPeer({ channelId: BigInt(42) }, { id: BigInt(42), username: 'Secret_Chan', className: 'Channel' }),
    ).toBe(true);
  });

  it('type:private blocks private chats but not groups or channels', async () => {
    const { isBlockedPeer } = await loadWith(['type:private']);
    expect(isBlockedPeer({ channelId: null, chatId: null, userId: BigInt(7) })).toBe(true);
    expect(isBlockedPeer({ channelId: null, chatId: BigInt(8), userId: null })).toBe(false);
    expect(isBlockedPeer({ channelId: BigInt(9), chatId: null, userId: null })).toBe(false);
  });

  it('lets through chats that are not listed', async () => {
    const { isBlockedPeer } = await loadWith(['-1001234567890', '@secret_chan']);
    expect(isBlockedPeer({ channelId: BigInt(200), chatId: null, userId: null }, { title: 'Open' })).toBe(false);
  });

  it('missing peer and entity is not blocked', async () => {
    const { isBlockedPeer } = await loadWith(['type:private']);
    expect(isBlockedPeer(undefined)).toBe(false);
  });
});

describe('blocklist: file formats and location', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-blocklist-'));
  });
  afterEach(() => {
    if (originalBlocklist === undefined) delete process.env.TG_BLOCKLIST;
    else process.env.TG_BLOCKLIST = originalBlocklist;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('isBlockedInput: bare and -100-marked ids match each other', async () => {
    const { isBlockedInput } = await loadWith(['1234567890']);
    expect(isBlockedInput('1234567890')).toBe(true);
    expect(isBlockedInput('-1001234567890')).toBe(true);
    expect(isBlockedInput('-1234567890')).toBe(true);
    expect(isBlockedInput('999')).toBe(false);
  });

  it('isBlockedInput: marked entry blocks the bare id too', async () => {
    const { isBlockedInput } = await loadWith(['-1001234567890']);
    expect(isBlockedInput('1234567890')).toBe(true);
  });

  it('isBlockedInput: @username and bare username, case-insensitive', async () => {
    const { isBlockedInput } = await loadWith(['@Secret_Chan', 'other_chan']);
    expect(isBlockedInput('@secret_chan')).toBe(true);
    expect(isBlockedInput('SECRET_CHAN')).toBe(true);
    expect(isBlockedInput('@other_chan')).toBe(true);
    expect(isBlockedInput('@open_chan')).toBe(false);
  });

  it('ignores # comments and blank lines', async () => {
    const { loadBlocklist } = await loadWith(['# 111', '', '   ', '222  ', '  # @hidden']);
    const bl = loadBlocklist();
    expect([...bl.ids]).toEqual(['222']);
    expect(bl.usernames.size).toBe(0);
    expect(bl.blockAllPrivate).toBe(false);
  });

  it('isBlockedEntity: by id, by username, and type:private only for users', async () => {
    const { isBlockedEntity } = await loadWith(['555', '@named', 'type:private']);
    expect(isBlockedEntity({ id: BigInt(555), className: 'Channel' })).toBe(true);
    expect(isBlockedEntity({ id: BigInt(1), username: 'Named', className: 'Channel' })).toBe(true);
    expect(isBlockedEntity({ id: BigInt(2), className: 'User' })).toBe(true);
    expect(isBlockedEntity({ id: BigInt(3), className: 'Channel' })).toBe(false);
    expect(isBlockedEntity({ id: BigInt(4), className: 'Chat' })).toBe(false);
  });

  it('isExplicitlyBlockedEntity: id and username entries only, type:private ignored', async () => {
    const { isExplicitlyBlockedEntity } = await loadWith(['555', '@named', 'type:private']);
    expect(isExplicitlyBlockedEntity({ id: BigInt(555), className: 'User' })).toBe(true);
    expect(isExplicitlyBlockedEntity({ id: '555' })).toBe(true);
    expect(isExplicitlyBlockedEntity({ id: BigInt(1), username: 'NAMED', className: 'User' })).toBe(true);
    expect(isExplicitlyBlockedEntity({ id: BigInt(2), className: 'User' })).toBe(false);
    expect(isExplicitlyBlockedEntity(undefined)).toBe(false);
  });

  it('type:user is an alias of type:private', async () => {
    const { isBlockedEntity } = await loadWith(['TYPE:USER']);
    expect(isBlockedEntity({ id: BigInt(2), className: 'User' })).toBe(true);
  });

  it('isBlockedDialog: serialized chat list items (id, username, type)', async () => {
    const { isBlockedDialog } = await loadWith(['-1001234567890', '@named', 'type:private']);
    expect(isBlockedDialog({ id: '-1001234567890', type: 'channel', username: null })).toBe(true);
    expect(isBlockedDialog({ id: '1234567890', type: 'channel', username: null })).toBe(true);
    expect(isBlockedDialog({ id: '42', type: 'supergroup', username: 'NAMED' })).toBe(true);
    expect(isBlockedDialog({ id: '7', type: 'user', username: null })).toBe(true);
    expect(isBlockedDialog({ id: '8', type: 'group', username: null })).toBe(false);
  });

  it('$TG_BLOCKLIST wins over the default location', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tg-blocklist-home-'));
    try {
      mkdirSync(join(home, '.config', 'tg-cli'), { recursive: true });
      writeFileSync(join(home, '.config', 'tg-cli', 'blocked-chats.txt'), '111\n');
      vi.stubEnv('HOME', home);
      const { isBlockedInput } = await loadWith(['222']);
      expect(isBlockedInput('222')).toBe(true);
      expect(isBlockedInput('111')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('without $TG_BLOCKLIST reads ~/.config/tg-cli/blocked-chats.txt (temp HOME)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tg-blocklist-home-'));
    try {
      mkdirSync(join(home, '.config', 'tg-cli'), { recursive: true });
      writeFileSync(join(home, '.config', 'tg-cli', 'blocked-chats.txt'), '@from_home\n');
      vi.stubEnv('HOME', home);
      delete process.env.TG_BLOCKLIST;
      vi.resetModules();
      const { isBlockedInput } = await import('../../src/lib/blocklist.js');
      expect(isBlockedInput('@from_home')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a missing file blocks nothing', async () => {
    process.env.TG_BLOCKLIST = join(dir, 'absent.txt');
    vi.resetModules();
    const { isBlockedInput, isBlockedEntity } = await import('../../src/lib/blocklist.js');
    expect(isBlockedInput('123')).toBe(false);
    expect(isBlockedEntity({ id: BigInt(1), className: 'User' })).toBe(false);
  });
});
