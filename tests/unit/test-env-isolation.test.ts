import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// blocklist.ts falls back to ~/.config/tg-cli/blocked-chats.txt. Any test that
// reaches resolveEntity / chat list / search without mocking it would read the
// developer's real blocklist — leaking local state into results and making the
// suite machine-dependent. The vitest config points TG_BLOCKLIST at an absent file.
describe('test environment isolation', () => {
  it('never reads the real blocklist under the home directory', () => {
    const path = process.env.TG_BLOCKLIST;
    expect(path).toBeTruthy();
    expect(resolve(path!).startsWith(resolve(homedir(), '.config'))).toBe(false);
    expect(existsSync(path!)).toBe(false);
  });
});
