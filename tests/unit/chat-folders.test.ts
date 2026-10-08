import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fork feature: Telegram chat folders (dialog filters) — lib/folders.ts and
// `tg chat folders`.

const mockOutputSuccess = vi.fn();
vi.mock('../../src/lib/output.js', () => ({
  outputSuccess: (...args: any[]) => mockOutputSuccess(...args),
  outputError: vi.fn(),
  logStatus: vi.fn(),
}));

vi.mock('telegram', () => ({
  Api: {
    messages: {
      GetDialogFilters: vi.fn().mockImplementation(() => ({ className: 'messages.GetDialogFilters' })),
    },
  },
}));

const mockInvoke = vi.fn();
const mockClient = { invoke: mockInvoke } as any;
vi.mock('../../src/lib/with-auth.js', () => ({
  withAuth: async (_opts: any, fn: any) => fn(mockClient),
}));

import { getFolders, findFolder } from '../../src/lib/folders.js';
import { chatFoldersAction } from '../../src/commands/chat/folders.js';

const filters = [
  { className: 'DialogFilterDefault' },
  {
    className: 'DialogFilter',
    id: 2,
    title: 'Work',
    pinnedPeers: [{ className: 'InputPeerChannel', channelId: BigInt(1234567890) }],
    includePeers: [
      { className: 'InputPeerUser', userId: BigInt(7) },
      { className: 'InputPeerChat', chatId: BigInt(55) },
    ],
  },
  {
    className: 'DialogFilterChatlist',
    id: 3,
    // newer layers: title is TextWithEntities
    title: { text: 'Shared News' },
    pinnedPeers: [],
    includePeers: [{ className: 'InputPeerChannel', channelId: BigInt(99) }],
  },
];

describe('getFolders / findFolder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads messages.dialogFilters { filters }, skips the default "All chats" filter', async () => {
    mockInvoke.mockResolvedValueOnce({ filters });
    const folders = await getFolders(mockClient);
    expect(folders.map((f) => f.id)).toEqual([2, 3]);
    expect(folders[0]).toMatchObject({ title: 'Work', shareable: false });
    expect([...folders[0].peerIds].sort()).toEqual(['1234567890', '55', '7']);
    expect(folders[1]).toMatchObject({ title: 'Shared News', shareable: true });
    expect([...folders[1].peerIds]).toEqual(['99']);
  });

  it('accepts the older bare-array response', async () => {
    mockInvoke.mockResolvedValueOnce(filters);
    const folders = await getFolders(mockClient);
    expect(folders).toHaveLength(2);
  });

  it('findFolder matches numeric id or case-insensitive title', async () => {
    mockInvoke.mockResolvedValueOnce({ filters });
    const folders = await getFolders(mockClient);
    expect(findFolder(folders, '3')?.title).toBe('Shared News');
    expect(findFolder(folders, '  work ')?.id).toBe(2);
    expect(findFolder(folders, 'missing')).toBeUndefined();
  });
});

describe('chat folders command', () => {
  beforeEach(() => vi.clearAllMocks());

  it('outputs id, title, explicit chat count and shareable flag', async () => {
    mockInvoke.mockResolvedValueOnce({ filters });
    await chatFoldersAction.call({ optsWithGlobals: () => ({ profile: 'default' }) } as any);
    expect(mockOutputSuccess).toHaveBeenCalledWith({
      folders: [
        { id: 2, title: 'Work', chatCount: 3, shareable: false },
        { id: 3, title: 'Shared News', chatCount: 1, shareable: true },
      ],
    });
  });
});
