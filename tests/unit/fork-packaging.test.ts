import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fork feature: installable straight from GitHub (`npm install -g github:boss707ai/tg-cli`).
// npm runs `prepare` for git dependencies, so dist/ is built on install; upstream's
// `prepack` stays for `npm pack`/publish.

const root = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const readme = readFileSync(join(root, 'README.md'), 'utf8');

describe('fork packaging', () => {
  it('builds on git install via the prepare script and keeps upstream prepack', () => {
    expect(pkg.scripts.prepare).toBe('npm run build');
    expect(pkg.scripts.prepack).toBe('npm run build');
    expect(pkg.bin).toEqual({ tg: './dist/bin/tg.js', 'telegram-cli': './dist/bin/tg.js' });
  });

  it('README documents the fork install, its additions and the blocklist', () => {
    expect(readme).toContain('npm install -g github:boss707ai/tg-cli');
    expect(readme).toContain('fork of [miolamio/tg-cli]');
    for (const feature of ['message click', 'chat similar', 'chat folders', '--archived', '--html', 'senderName', 'waveform']) {
      expect(readme).toContain(feature);
    }
    expect(readme).toContain('blocked-chats.txt');
    expect(readme).toContain('TG_BLOCKLIST');
    expect(readme).toContain('type:private');
  });

  it('README states what the blocklist closes, its known limit and the daemon restart', () => {
    const start = readme.indexOf('### Read-access blocklist');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = readme.slice(start, readme.indexOf('\n## ', start));
    // chats and their messages everywhere, including the daemon
    for (const item of ['CHAT_BLOCKED', 'chat list', 'message search --chat', 'message replies', 'chat invite-info', 'chat similar', '--daemon']) {
      expect(section).toContain(item);
    }
    // explicitly closed people vanish from the contacts directory; type:private does not
    for (const item of ['contact list', 'contact search', 'user blocked']) expect(section).toContain(item);
    expect(section).toMatch(/`type:private` closes only the private conversations, not the contacts\s+directory/);
    // known limit and the restart rule
    expect(section).toContain('nextOffsetPeer');
    expect(section).toContain('restart the daemon');
  });
});
