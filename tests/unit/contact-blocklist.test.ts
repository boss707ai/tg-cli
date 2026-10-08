import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api } from 'telegram';
import bigInt from 'big-integer';

// Fork decision: people closed EXPLICITLY in the blocklist (by id or @username)
// disappear from `contact list`, `contact search` (local and --global) and
// `user blocked`; their full profile is never even requested (users.GetFullUser).
// `type:private` does NOT apply to the contacts directory — it only closes the
// conversations — otherwise the contact list would be empty.
// Real blocklist.ts with a temporary file; Telegram is a synthetic stub.

const state = vi.hoisted(() => ({ invoke: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../src/lib/with-auth.js', () => ({ withAuth: async (_opts: unknown, fn: any) => fn({ invoke: state.invoke }) }));
vi.mock('../../src/lib/output.js', () => ({ outputSuccess: state.success, outputError: state.error, logStatus: vi.fn() }));

const user = (id: number, firstName: string, lastName?: string, username?: string) => new Api.User({
  id: bigInt(id), firstName, lastName, username, accessHash: bigInt(id + 1000), phone: `1555000${id}`,
});
const alice = user(100, 'Alice', 'Smith', 'alice_handle');
const bob = user(50, 'Bob');
const friend = user(8, 'Private', 'Friend'); // blocked by id
const hidden = user(300, 'Hidden', 'Person', 'hidden_user'); // blocked by @username
const hidalgo = user(400, 'Hidalgo'); // not a contact, found globally
const peer = (u: Api.User) => new Api.PeerUser({ userId: u.id });

function transport(contacts: Api.User[], remote?: Api.contacts.Found) {
  state.invoke.mockImplementation(async (request: any) => {
    if (request instanceof Api.contacts.GetContacts) {
      return new Api.contacts.Contacts({ users: contacts, savedCount: contacts.length, contacts: contacts.map(u => new Api.Contact({ userId: u.id, mutual: false })) });
    }
    if (request instanceof Api.contacts.Search) return remote ?? new Api.contacts.Found({ users: [], chats: [], myResults: [], results: [] });
    if (request instanceof Api.users.GetFullUser) return { fullUser: { about: `bio of ${request.id.firstName}` }, users: [request.id] };
    if (request instanceof Api.photos.GetUserPhotos) return new Api.photos.Photos({ photos: [], users: [] });
    throw new Error(`Unexpected RPC ${request.className}`);
  });
}

/** Ids of users whose full profile was requested. */
const enriched = () => state.invoke.mock.calls
  .filter(([request]) => request instanceof Api.users.GetFullUser)
  .map(([request]) => String(request.id.id));
const output = () => state.success.mock.calls[0][0];
const ctx = (opts: Record<string, unknown> = {}) => ({ optsWithGlobals: () => ({ profile: 'default', ...opts }) }) as any;

let dir: string;
const originalBlocklist = process.env.TG_BLOCKLIST;
let contactListAction: typeof import('../../src/commands/contact/list.js').contactListAction;
let contactSearchAction: typeof import('../../src/commands/contact/search.js').contactSearchAction;
let userBlockedAction: typeof import('../../src/commands/user/blocked.js').userBlockedAction;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-contact-blocklist-'));
  // type:private is listed on purpose: it must not empty the contacts directory.
  writeFileSync(join(dir, 'blocked-chats.txt'), ['# synthetic', '8', '@Hidden_User', 'type:private'].join('\n'));
  process.env.TG_BLOCKLIST = join(dir, 'blocked-chats.txt');
  vi.resetModules(); // blocklist.ts reads and caches its file once per process
  ({ contactListAction } = await import('../../src/commands/contact/list.js'));
  ({ contactSearchAction } = await import('../../src/commands/contact/search.js'));
  ({ userBlockedAction } = await import('../../src/commands/user/blocked.js'));
});

afterAll(() => {
  if (originalBlocklist === undefined) delete process.env.TG_BLOCKLIST;
  else process.env.TG_BLOCKLIST = originalBlocklist;
  rmSync(dir, { recursive: true, force: true });
});

describe('contacts directory hides explicitly blocked people', () => {
  const exitCode = process.exitCode;
  beforeEach(() => { vi.clearAllMocks(); process.exitCode = 0; });
  afterEach(() => { process.exitCode = exitCode; });

  it('contact list: explicit entries vanish before GetFullUser; type:private keeps everyone else', async () => {
    transport([alice, friend, hidden, bob]);
    await contactListAction.call(ctx());
    expect(output().contacts.map((c: any) => c.id)).toEqual(['100', '50']);
    expect(output()).toMatchObject({ total: 2, partial: false, errors: [] });
    expect(enriched().sort()).toEqual(['100', '50']);
    expect(JSON.stringify(output())).not.toMatch(/Private|Hidden|hidden_user|15550008|155500300/);
  });

  it('contact list: hidden people never shift a page (filter before pagination)', async () => {
    transport([alice, friend, hidden, bob]);
    await contactListAction.call(ctx({ limit: '1', offset: '1' }));
    expect(output().contacts.map((c: any) => c.id)).toEqual(['50']);
    expect(output().total).toBe(2);
    expect(enriched()).toEqual(['50']);
  });

  it('contact search (local): matching blocked contacts are dropped before enrichment', async () => {
    transport([alice, friend, hidden, bob]);
    await contactSearchAction.call(ctx({ limit: '20' }), 'i'); // matches Alice, Private Friend, Hidden
    expect(output().results.map((u: any) => u.id)).toEqual(['100']);
    expect(output()).toMatchObject({ total: 1, partial: false, errors: [] });
    expect(enriched()).toEqual(['100']);
  });

  it('contact search --global: blocked remote users are dropped and do not fill the page', async () => {
    transport([alice, friend, hidden], new Api.contacts.Found({
      users: [hidden, friend, hidalgo], chats: [],
      myResults: [peer(hidden)], results: [peer(friend), peer(hidalgo)],
    }));
    await contactSearchAction.call(ctx({ global: true, limit: '1' }), 'hid'); // local match: only Hidden (blocked)
    expect(state.invoke.mock.calls.some(([request]) => request instanceof Api.contacts.Search)).toBe(true);
    expect(output().results.map((u: any) => u.id)).toEqual(['400']);
    expect(enriched()).toEqual(['400']);
    expect(JSON.stringify(output())).not.toMatch(/Hidden|Private/);
  });

  it('contact search: a blocked @username query finds nothing', async () => {
    transport([alice, hidden]);
    await contactSearchAction.call(ctx(), '@hidden_user');
    expect(output()).toMatchObject({ results: [], total: 0, partial: false });
    expect(enriched()).toEqual([]);
  });

  it('user blocked: explicit entries vanish and total drops by the number hidden', async () => {
    state.invoke.mockResolvedValueOnce(new Api.contacts.BlockedSlice({
      count: 10,
      blocked: [friend, alice, hidden].map(u => new Api.PeerBlocked({ peerId: peer(u), date: 1_700_000_000 })),
      chats: [], users: [friend, alice, hidden],
    }));
    await userBlockedAction.call(ctx());
    expect(output()).toEqual({
      users: [{ id: '100', firstName: 'Alice', lastName: 'Smith', username: 'alice_handle', isBot: false }],
      total: 8,
    });
  });

  it('user blocked: type:private alone does not hide anyone (full list without count)', async () => {
    state.invoke.mockResolvedValueOnce(new Api.contacts.Blocked({
      blocked: [alice, bob].map(u => new Api.PeerBlocked({ peerId: peer(u), date: 1_700_000_000 })),
      chats: [], users: [alice, bob],
    }));
    await userBlockedAction.call(ctx());
    expect(output().users.map((u: any) => u.id)).toEqual(['100', '50']);
    expect(output().total).toBe(2);
  });
});
