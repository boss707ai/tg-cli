import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fork features of `tg chat list` on top of upstream's validatePagination and
// paged dialog fetching: --archived, --folder, and the read-access blocklist on
// every path (plain, --type, --folder, --archived), applied BEFORE pagination.

const mockOutputSuccess = vi.fn();
const mockOutputError = vi.fn();
vi.mock('../../src/lib/output.js', () => ({
  outputSuccess: (...args: any[]) => mockOutputSuccess(...args),
  outputError: (...args: any[]) => mockOutputError(...args),
  logStatus: vi.fn(),
}));

const { mockGetDialogs } = vi.hoisted(() => ({ mockGetDialogs: vi.fn().mockResolvedValue([]) }));
const mockClientInstance = { getDialogs: mockGetDialogs };

vi.mock('telegram', () => ({ Api: {} }));
vi.mock('../../src/lib/with-auth.js', () => ({
  withAuth: async (_opts: any, fn: any) => fn(mockClientInstance),
}));

// Blocklist: ids in `blocked` are hidden; normalizeId stays real.
const blocked = new Set<string>();
vi.mock('../../src/lib/blocklist.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/blocklist.js')>('../../src/lib/blocklist.js');
  return {
    ...actual,
    // `blocked` holds normalized (bare) ids, like the real blocklist does
    isBlockedDialog: (c: { id?: string }) => c.id != null && blocked.has(actual.normalizeId(c.id)),
  };
});

// Folders: getFolders is the network call; findFolder stays real.
const mockGetFolders = vi.fn();
vi.mock('../../src/lib/folders.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/folders.js')>('../../src/lib/folders.js');
  return { ...actual, getFolders: (...args: any[]) => mockGetFolders(...args) };
});

function dialog(n: number, overrides: Record<string, any> = {}) {
  // gramjs Dialog.id is the marked peer id (-100… for channels)
  const id = overrides.id ?? BigInt(n);
  return {
    id,
    title: `Chat ${n}`,
    name: `Chat ${n}`,
    isUser: false,
    isChannel: false,
    isGroup: true,
    unreadCount: 0,
    date: 1_700_000_000 + n,
    message: { id: n, date: 1_700_000_000 + n },
    inputEntity: { className: 'InputPeerChat', chatId: id },
    entity: { username: null, megagroup: false },
    ...overrides,
  };
}
const channel = (n: number) => dialog(n, {
  id: BigInt(`-100${n}`),
  isChannel: true,
  isGroup: false,
  entity: { username: null, megagroup: false },
});

import { chatListAction } from '../../src/commands/chat/list.js';

function ctx(opts: Record<string, any> = {}) {
  return { optsWithGlobals: () => ({ profile: 'default', offset: '0', ...opts }) } as any;
}
const output = () => mockOutputSuccess.mock.calls[0][0];
const titles = () => output().chats.map((c: any) => c.title);

describe('chat list: blocklist on every path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDialogs.mockReset().mockResolvedValue([]);
    blocked.clear();
  });

  it('plain list hides blocked chats and counts only visible ones in total', async () => {
    blocked.add('2');
    mockGetDialogs.mockResolvedValueOnce([dialog(1), dialog(2), dialog(3)]);
    await chatListAction.call(ctx());
    expect(titles()).toEqual(['Chat 1', 'Chat 3']);
    expect(output().total).toBe(2);
    expect(JSON.stringify(output())).not.toContain('Chat 2');
  });

  it('plain list: a hidden chat never shifts or shortens a page (filter before pagination)', async () => {
    blocked.add('2');
    // offset 1, limit 2 -> first request asks for 3 dialogs; one is hidden, so it pages on.
    mockGetDialogs
      .mockResolvedValueOnce([dialog(1), dialog(2), dialog(3)])
      .mockResolvedValueOnce([dialog(4), dialog(5)]);
    await chatListAction.call(ctx({ limit: '2', offset: '1' }));
    expect(mockGetDialogs).toHaveBeenNthCalledWith(1, { limit: 3 });
    expect(mockGetDialogs).toHaveBeenNthCalledWith(2, expect.objectContaining({
      limit: 100,
      offsetId: 3,
      offsetPeer: expect.objectContaining({ chatId: BigInt(3) }),
    }));
    expect(titles()).toEqual(['Chat 3', 'Chat 4']);
  });

  it('plain list without blocked chats keeps the single upstream request', async () => {
    mockGetDialogs.mockResolvedValueOnce([dialog(1), dialog(2)]);
    await chatListAction.call(ctx({ limit: '2' }));
    expect(mockGetDialogs).toHaveBeenCalledOnce();
    expect(mockGetDialogs).toHaveBeenCalledWith({ limit: 2 });
    expect(titles()).toEqual(['Chat 1', 'Chat 2']);
  });

  it('--type hides blocked chats and keeps paging to fill the typed page', async () => {
    blocked.add('2'); // listed as -1002 in the file -> normalized
    const first = [channel(1), channel(2), ...Array.from({ length: 98 }, (_, i) => dialog(10 + i))];
    mockGetDialogs.mockResolvedValueOnce(first).mockResolvedValueOnce([channel(300)]);
    await chatListAction.call(ctx({ type: 'channel', limit: '2' }));
    expect(titles()).toEqual(['Chat 1', 'Chat 300']);
    expect(output().total).toBe(2);
    expect(output().hasMore).toBe(false);
  });
});

describe('chat list --archived (fork)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDialogs.mockReset().mockResolvedValue([]);
    blocked.clear();
  });

  it('reads the Archive folder and returns the whole set without --limit', async () => {
    const dialogs = Array.from({ length: 60 }, (_, i) => dialog(i + 1));
    mockGetDialogs.mockResolvedValueOnce(dialogs);
    await chatListAction.call(ctx({ archived: true }));
    expect(mockGetDialogs).toHaveBeenCalledWith({ limit: 100000, archived: true });
    expect(output().chats).toHaveLength(60);
    expect(output().total).toBe(60);
  });

  it('hides blocked archived chats and honours an explicit --limit/--offset', async () => {
    blocked.add('2');
    mockGetDialogs.mockResolvedValueOnce([dialog(1), dialog(2), dialog(3), dialog(4)]);
    await chatListAction.call(ctx({ archived: true, limit: '2', offset: '1' }));
    expect(titles()).toEqual(['Chat 3', 'Chat 4']);
    expect(output().total).toBe(3);
  });

  it('combines with --type', async () => {
    mockGetDialogs.mockResolvedValueOnce([dialog(1), channel(2), channel(3)]);
    await chatListAction.call(ctx({ archived: true, type: 'channel' }));
    expect(titles()).toEqual(['Chat 2', 'Chat 3']);
  });
});

describe('chat list --folder (fork)', () => {
  const folders = [
    { id: 2, title: 'Work', shareable: false, peerIds: new Set(['1', '3', '4']) },
    { id: 5, title: 'News', shareable: true, peerIds: new Set(['1234567890']) },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDialogs.mockReset().mockResolvedValue([]);
    mockGetFolders.mockReset().mockResolvedValue(folders);
    blocked.clear();
  });

  it('lists only chats in the folder (by title, case-insensitive), whole set by default', async () => {
    mockGetDialogs.mockResolvedValueOnce([dialog(1), dialog(2), dialog(3), dialog(4), dialog(5)]);
    await chatListAction.call(ctx({ folder: 'work' }));
    expect(mockGetDialogs).toHaveBeenCalledWith({ limit: 100000 });
    expect(titles()).toEqual(['Chat 1', 'Chat 3', 'Chat 4']);
    expect(output().total).toBe(3);
  });

  it('matches folder by id and marked channel ids against bare folder peer ids', async () => {
    mockGetDialogs.mockResolvedValueOnce([channel(1234567890), dialog(1)]);
    await chatListAction.call(ctx({ folder: '5' }));
    expect(output().chats.map((c: any) => c.id)).toEqual(['-1001234567890']);
  });

  it('hides blocked chats even when they are in the folder', async () => {
    blocked.add('3');
    mockGetDialogs.mockResolvedValueOnce([dialog(1), dialog(3), dialog(4)]);
    await chatListAction.call(ctx({ folder: 'Work' }));
    expect(titles()).toEqual(['Chat 1', 'Chat 4']);
    expect(output().total).toBe(2);
  });

  it('paginates with an explicit --limit/--offset and combines with --type', async () => {
    mockGetDialogs.mockResolvedValueOnce([dialog(1), channel(3), channel(4)]);
    await chatListAction.call(ctx({ folder: 'Work', type: 'channel', limit: '1', offset: '1' }));
    expect(titles()).toEqual(['Chat 4']);
    expect(output().total).toBe(2);
  });

  it('fails with FOLDER_NOT_FOUND for an unknown folder', async () => {
    mockGetDialogs.mockResolvedValueOnce([dialog(1)]);
    await expect(chatListAction.call(ctx({ folder: 'Nope' }))).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect(mockOutputSuccess).not.toHaveBeenCalled();
  });

  it('validates --limit with upstream validatePagination', async () => {
    await chatListAction.call(ctx({ folder: 'Work', limit: '0' }));
    expect(mockOutputError).toHaveBeenCalledWith(expect.stringContaining('Invalid pagination'), 'INVALID_INPUT');
    expect(mockGetDialogs).not.toHaveBeenCalled();
  });
});
