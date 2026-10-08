import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    env: {
      // Keep tests away from the real ~/.config/tg-cli/blocked-chats.txt:
      // point the read-access blocklist at a file that does not exist.
      TG_BLOCKLIST: join(tmpdir(), 'tg-cli-tests-no-blocklist', 'blocked-chats.txt'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'tests/', 'dist/'],
    },
  },
});
