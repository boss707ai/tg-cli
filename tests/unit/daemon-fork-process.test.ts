import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../../src/lib/session-store.js';
import { DaemonPaths } from '../../src/lib/daemon/pid.js';
import { DaemonClient } from '../../src/lib/daemon/client.js';

const require = createRequire(import.meta.url);
interface ProcessResult { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }
interface JournalEvent { event: string; pid: number; [key: string]: unknown }

/**
 * Fork commands through a real daemon: real CLI children, a detached daemon
 * process and Unix sockets; the Telegram boundary is tests/fixtures/daemon-fork-telegram.ts.
 * Config, session and blocklist live in a temporary directory (HOME too).
 */
describe('fork commands across real daemon processes', () => {
  let dir: string;
  let cliEntry: string;
  let config: string;
  /** Profile p: empty blocklist (fork commands); profile q: synthetic blocklist (privacy guard). */
  const profiles: Record<string, { journal: string; blocklist: string; paths: DaemonPaths; pid: number }> = {} as any;
  const children = new Set<ChildProcess>();

  const journalOf = (profile: string): JournalEvent[] => (existsSync(profiles[profile].journal)
    ? readFileSync(profiles[profile].journal, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []);
  const journal = () => journalOf('p');

  function cli(args: string[], profile = 'p'): Promise<ProcessResult> {
    const child = spawn(process.execPath, [cliEntry, '--config', config, '--profile', profile, '--quiet', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Synthetic credentials and an isolated HOME/blocklist only. Never a real account.
      // The daemon inherits TG_BLOCKLIST from the `daemon start` invocation.
      env: {
        PATH: process.env.PATH, HOME: dir, TG_API_ID: '1', TG_API_HASH: 'synthetic-api-hash',
        TG_DAEMON_API_TEST_JOURNAL: profiles[profile].journal, TG_BLOCKLIST: profiles[profile].blocklist,
      },
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdin!.end('');
    return new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI did not exit: ${JSON.stringify(args)}; ${stdout}; ${stderr}`)); }, 10_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timeout); children.delete(child); resolveResult({ stdout, stderr, code, signal }); });
    });
  }

  function envelope(result: ProcessResult, code = 0): any {
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(code);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
  }

  async function rpc(method: string, params: Record<string, unknown> = {}, profile = 'p'): Promise<any> {
    const client = new DaemonClient(profiles[profile].paths.socketPath);
    try { return await client.call(method, params, { timeoutMs: 3000 }); } finally { client.close(); }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tgf-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0-offline' }));
    const configDir = join(dir, 'c');
    mkdirSync(configDir);
    config = join(configDir, 'config.json');
    writeFileSync(config, '{"profiles":{}}');
    const blocklists: Record<string, string[]> = {
      p: ['# synthetic, nothing blocked'],
      q: ['# synthetic blocklist for the daemon process', '@secret_chan', '8'],
    };
    for (const [profile, lines] of Object.entries(blocklists)) {
      await new SessionStore(configDir).save(profile, 'synthetic-session');
      const blocklist = join(dir, `blocked-${profile}.txt`);
      writeFileSync(blocklist, lines.join('\n') + '\n');
      profiles[profile] = { journal: join(dir, `events-${profile}.jsonl`), blocklist, paths: new DaemonPaths(configDir, profile), pid: 0 };
    }
    cliEntry = join(dir, 'bin', 'tg.mjs');
    const plugin: Plugin = { name: 'offline-fork-daemon', setup(builder) {
      builder.onResolve({ filter: /^telegram$/ }, () => ({ path: resolve('tests/fixtures/daemon-fork-telegram.ts') }));
      builder.onResolve({ filter: /^[^./]/ }, (args) => ({
        path: args.path.startsWith('node:') ? args.path : require.resolve(args.path), external: true,
      }));
    } };
    const options = { bundle: true, platform: 'node' as const, format: 'esm' as const, target: 'node20', logLevel: 'silent' as const, plugins: [plugin] };
    await Promise.all([
      build({ ...options, entryPoints: [resolve('src/bin/tg.ts')], outfile: cliEntry }),
      build({ ...options, entryPoints: [resolve('src/lib/daemon/entry.ts')], outfile: join(dir, 'lib', 'daemon', 'entry.js') }),
    ]);
    for (const profile of Object.keys(profiles)) {
      const started = envelope(await cli(['daemon', 'start', '--idle-timeout', '0'], profile));
      expect(started).toMatchObject({ ok: true, data: { profile } });
      profiles[profile].pid = started.data.pid;
      expect(await rpc('ping', {}, profile)).toBe('pong');
    }
  }, 30_000);

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    for (const [profile, { paths, pid }] of Object.entries(profiles)) {
      if (!paths.socketExists()) continue;
      try { await rpc('shutdown', {}, profile); } catch { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} } }
      await vi.waitFor(() => expect(paths.socketExists()).toBe(false), { timeout: 3000 });
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('tg --daemon chat folders runs on the daemon', async () => {
    expect(envelope(await cli(['--daemon', 'chat', 'folders']))).toEqual({
      ok: true, data: { folders: [{ id: 2, title: 'Work', chatCount: 2, shareable: false }] },
    });
    expect(journal().filter((e) => e.request === 'messages.GetDialogFilters').map((e) => e.pid)).toEqual([profiles.p.pid]);
  });

  it('tg --daemon chat similar <channel> runs on the daemon', async () => {
    expect(envelope(await cli(['--daemon', 'chat', 'similar', '@source']))).toMatchObject({
      ok: true, data: { chats: [{ id: '4242', title: 'Similar channel', type: 'channel', username: 'similar' }], total: 1 },
    });
  });

  it('tg --daemon message click presses the button on the daemon', async () => {
    expect(envelope(await cli(['--daemon', 'message', 'click', '@fixturebot', '42', '--text', 'yes']))).toMatchObject({
      ok: true, data: { messageId: 42, chatId: '777', button: 'Yes', clicked: true, botAnswer: 'Thanks from the fixture bot' },
    });
    expect(envelope(await cli(['--daemon', 'message', 'click', '@fixturebot', '42', '--row', '1', '--col', '2']))).toMatchObject({
      ok: true, data: { clicked: false, url: 'https://example.org/fixture' },
    });
    expect(journal().filter((e) => e.request === 'messages.GetBotCallbackAnswer').map((e) => e.pid)).toEqual([profiles.p.pid]);
  });

  it('tg --daemon keeps fork flags: chat list --archived/--folder, message send --html', async () => {
    expect(envelope(await cli(['--daemon', 'chat', 'list', '--archived']))).toMatchObject({
      ok: true, data: { chats: [{ title: 'Archived channel' }], total: 1 },
    });
    expect(envelope(await cli(['--daemon', 'chat', 'list', '--folder', 'work']))).toMatchObject({
      ok: true, data: { chats: [{ title: 'Open source channel' }, { title: 'Secret channel' }], total: 2 },
    });
    expect(envelope(await cli(['--daemon', 'message', 'send', '@fixture', '<b>bold</b>', '--html']))).toMatchObject({
      ok: true, data: { text: '<b>bold</b>' },
    });
    expect(journal().filter((e) => e.event === 'sendMessage').at(-1)).toMatchObject({ pid: profiles.p.pid, parseMode: 'html' });
  });

  it('direct fork commands are refused while the daemon owns the profile', async () => {
    const constructors = journal().filter((e) => e.event === 'constructor').length;
    for (const args of [['chat', 'folders'], ['chat', 'similar'], ['message', 'click', '@fixturebot', '42', '--text', 'Yes']]) {
      expect(envelope(await cli(args), 1)).toMatchObject({ ok: false, code: 'DAEMON_ALREADY_RUNNING' });
    }
    expect(journal().filter((e) => e.event === 'constructor')).toHaveLength(constructors);
  });

  it('every request ran on the single daemon connection', () => {
    expect(journal().filter((e) => e.event === 'constructor')).toEqual([{ event: 'constructor', pid: profiles.p.pid }]);
    expect(journal().filter((e) => e.event === 'connect')).toEqual([{ event: 'connect', pid: profiles.p.pid }]);
    expect(new Set(journal().map((e) => e.pid))).toEqual(new Set([profiles.p.pid]));
  });
  describe('read-access blocklist inside the daemon (profile q)', () => {
    const q = (args: string[]) => cli(args, 'q');
    const qEvents = (event: string) => journalOf('q').filter((e) => e.event === event);

    it('blocked raw input is refused with CHAT_BLOCKED before the daemon touches Telegram', async () => {
      const lookups = qEvents('getEntity').length;
      expect(envelope(await q(['--daemon', 'chat', 'info', '@secret_chan']), 1)).toMatchObject({ ok: false, code: 'CHAT_BLOCKED' });
      expect(envelope(await q(['--daemon', 'message', 'history', '8']), 1)).toMatchObject({ ok: false, code: 'CHAT_BLOCKED' });
      expect(qEvents('getEntity')).toHaveLength(lookups);
      expect(await rpc('execute', { argv: ['message', 'history', '--', 'secret_chan'] }, 'q')).toMatchObject({
        output: { ok: false, code: 'CHAT_BLOCKED' }, exitCode: 1,
      });
    });

    it('a resolved entity on the blocklist is refused too (fork commands included)', async () => {
      const reads = qEvents('getMessages').length;
      const rpcs = qEvents('invoke').length;
      expect(envelope(await q(['--daemon', 'message', 'history', '-100555']), 1)).toMatchObject({ ok: false, code: 'CHAT_BLOCKED' });
      expect(envelope(await q(['--daemon', 'message', 'click', '@friend', '42', '--text', 'Yes']), 1)).toMatchObject({ ok: false, code: 'CHAT_BLOCKED' });
      expect(qEvents('getMessages')).toHaveLength(reads);
      expect(qEvents('invoke')).toHaveLength(rpcs);
    });

    it('global message search through the daemon drops blocked chats and lowers total', async () => {
      const result = envelope(await q(['--daemon', 'message', 'search', '--query', 'needle']));
      expect(result.data.messages.map((m: any) => m.text)).toEqual(['needle in saved messages', 'needle in the open channel']);
      expect(result.data.total).toBe(2);
      expect(JSON.stringify(result)).not.toMatch(/secret|friend/i);
      expect(qEvents('iterMessages').map((e) => e.pid)).toEqual([profiles.q.pid]);
    });

    it('chat list (plain and --folder) through the daemon hides blocked chats', async () => {
      const plain = envelope(await q(['--daemon', 'chat', 'list']));
      expect(plain.data.chats.map((c: any) => c.title)).toEqual(['Saved Messages', 'Fixture Bot', 'Open source channel']);
      expect(plain.data.total).toBe(3);
      const folder = envelope(await q(['--daemon', 'chat', 'list', '--folder', 'Work']));
      expect(folder.data.chats.map((c: any) => c.title)).toEqual(['Open source channel']);
    });

    it('message watch (daemon subscribe) refuses a blocked chat', async () => {
      const subscriptions = qEvents('subscribe').length;
      const result = await q(['message', 'watch', '@secret_chan']);
      expect(result.code).toBe(1);
      // The daemon refuses the subscription through resolveEntity's guard; watch
      // reports the daemon's application code (data.tgCode), not a connection failure.
      expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({
        ok: false, code: 'CHAT_BLOCKED', error: expect.stringContaining('blocked by local read-access policy'),
      });
      expect(qEvents('subscribe')).toHaveLength(subscriptions);
    });

    it('the same chats stay readable on a daemon without that blocklist (profile p)', async () => {
      expect(envelope(await cli(['--daemon', 'message', 'history', 'secret_chan']))).toMatchObject({
        ok: true, data: { messages: [{ text: 'history of 555' }] },
      });
    });
  });
});
