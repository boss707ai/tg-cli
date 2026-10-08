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
});
