import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// blocklist.ts reads $TG_BLOCKLIST once at import and caches it,
// so every test writes its own file and re-imports the module.
let dir: string;

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
    delete process.env.TG_BLOCKLIST;
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
