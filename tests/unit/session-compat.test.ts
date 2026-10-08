import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';

// A session written by the fork before the merge (tg 0.2.0 layout:
// <configDir>/sessions/<profile>.session, plain StringSession text, default
// umask modes, profile config { phone, created } and global apiId/apiHash)
// must be used by the merged code as-is: no re-login, no rewrite, no migration.

const { mockWithClient } = vi.hoisted(() => ({ mockWithClient: vi.fn() }));
vi.mock('../../src/lib/client.js', () => ({ withClient: (...args: any[]) => mockWithClient(...args) }));
const mockOutputError = vi.fn();
vi.mock('../../src/lib/output.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/output.js')>('../../src/lib/output.js');
  return { ...actual, outputError: (...args: any[]) => mockOutputError(...args) };
});

import { SessionStore } from '../../src/lib/session-store.js';
import { withAuth } from '../../src/lib/with-auth.js';

// Synthetic, StringSession-looking value (never a real session).
const LEGACY_SESSION = '1BAAOMTQ5LjE1NC4xNjcuNTEAUFsynthetic+legacy/session==';
const posix = process.platform !== 'win32';

describe('pre-merge session compatibility', () => {
  let configDir: string;
  let sessionFile: string;
  let configFile: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Credentials come from the old config file, not from the environment.
    vi.stubEnv('TG_API_ID', undefined);
    vi.stubEnv('TG_API_HASH', undefined);
    configDir = mkdtempSync(join(tmpdir(), 'tg-session-compat-'));
    mkdirSync(join(configDir, 'sessions'));
    chmodSync(join(configDir, 'sessions'), 0o755);
    sessionFile = join(configDir, 'sessions', 'default.session');
    // Old SessionStore wrote the raw string (sometimes with a trailing newline by hand).
    writeFileSync(sessionFile, `${LEGACY_SESSION}\n`);
    chmodSync(sessionFile, 0o644);
    configFile = join(configDir, 'config.json');
    writeFileSync(configFile, JSON.stringify({
      profiles: { default: { phone: '+10000000000', created: '2026-01-01T00:00:00.000Z' } },
      apiId: 12345,
      apiHash: 'synthetic-api-hash',
    }));
    mockWithClient.mockImplementation(async (_opts: any, fn: any) => fn({ synthetic: true }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('SessionStore reads the old file unchanged and only tightens permissions', async () => {
    const before = readFileSync(sessionFile);
    const store = new SessionStore(configDir);
    const seen = await store.withLock('default', async (session) => session);
    expect(seen).toBe(LEGACY_SESSION);
    expect(await store.load('default')).toBe(LEGACY_SESSION);
    expect(readFileSync(sessionFile).equals(before)).toBe(true); // content never rewritten
    if (posix) {
      expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(configDir, 'sessions')).mode & 0o777).toBe(0o700);
    }
    // The lock is released and nothing else is left next to the session.
    expect(readdirSync(join(configDir, 'sessions'))).toEqual(['default.session']);
  });

  it('withAuth runs the command on the old session without asking to log in again', async () => {
    const ran = vi.fn();
    await withAuth({ profile: 'default', config: configFile }, async (client) => { ran(client); });

    expect(mockOutputError).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalledWith({ synthetic: true });
    expect(mockWithClient).toHaveBeenCalledWith(
      { apiId: 12345, apiHash: 'synthetic-api-hash', sessionString: LEGACY_SESSION, transport: 'tcp' },
      expect.any(Function),
      expect.objectContaining({ holdUntil: expect.any(Function) }),
    );
    expect(readFileSync(sessionFile, 'utf8')).toBe(`${LEGACY_SESSION}\n`);
    // Old profile metadata is not migrated or rewritten by an ordinary command.
    expect(JSON.parse(readFileSync(configFile, 'utf8')).profiles.default).toEqual({
      phone: '+10000000000', created: '2026-01-01T00:00:00.000Z',
    });
  });

  it('an old binary holding the session lock still excludes the merged code (same lock file)', async () => {
    // tg 0.2.0 locked the session file itself: proper-lockfile -> <file>.lock
    const release = await lock(sessionFile, { retries: 0 });
    try {
      await expect(new SessionStore(configDir).withLock('default', async () => 'never')).rejects.toMatchObject({ code: 'ELOCKED' });
    } finally {
      await release();
    }
    expect(existsSync(`${sessionFile}.lock`)).toBe(false);
  });
});

describe('default config location is unchanged', () => {
  it('createConfig() keeps projectName telegram-cli / config.json (no directory move)', async () => {
    const captured: any[] = [];
    vi.resetModules();
    vi.doMock('conf', () => ({
      default: class {
        path = '/synthetic/telegram-cli-nodejs/config.json';
        constructor(options: unknown) { captured.push(options); }
      },
    }));
    try {
      const { createConfig } = await import('../../src/lib/config.js');
      createConfig();
      expect(captured[0]).toMatchObject({ projectName: 'telegram-cli', configName: 'config' });
      expect(captured[0]).not.toHaveProperty('cwd');
    } finally {
      vi.doUnmock('conf');
      vi.resetModules();
    }
  });
});
