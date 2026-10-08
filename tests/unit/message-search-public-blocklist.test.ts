import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fork: the read-access blocklist also covers public hashtag search
// (channels.searchPosts), which returns posts from channels without resolving them.

const mockOutputSuccess = vi.fn();
const mockOutputError = vi.fn();
vi.mock('../../src/lib/output.js', () => ({
  outputSuccess: (...args: any[]) => mockOutputSuccess(...args),
  outputError: (...args: any[]) => mockOutputError(...args),
  logStatus: vi.fn(),
}));

const { mockInvoke, mockGetMessages, mockGetInputEntity } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockGetMessages: vi.fn(),
  mockGetInputEntity: vi.fn(async (entity: unknown) => entity),
}));

const mockClientInstance = {
  connect: vi.fn(),
  destroy: vi.fn(),
  invoke: mockInvoke,
  getMessages: mockGetMessages,
  getInputEntity: mockGetInputEntity,
};

vi.mock('telegram', () => ({
  TelegramClient: vi.fn().mockImplementation(() => mockClientInstance),
  sessions: { StringSession: vi.fn() },
  Api: {
    InputPeerEmpty: class InputPeerEmpty {
      className = 'InputPeerEmpty';
    },
    channels: {
      SearchPosts: class SearchPosts {
        className = 'channels.SearchPosts';
        hashtag: string;
        offsetRate: number;
        offsetPeer: unknown;
        offsetId: number;
        limit: number;
        constructor(args: any) {
          this.hashtag = args.hashtag;
          this.offsetRate = args.offsetRate;
          this.offsetPeer = args.offsetPeer;
          this.offsetId = args.offsetId;
          this.limit = args.limit;
        }
      },
    },
    InputMessagesFilterPhotos: class {},
    InputMessagesFilterVideo: class {},
    InputMessagesFilterPhotoVideo: class {},
    InputMessagesFilterDocument: class {},
    InputMessagesFilterUrl: class {},
    InputMessagesFilterGif: class {},
    InputMessagesFilterVoice: class {},
    InputMessagesFilterMusic: class {},
    InputMessagesFilterRoundVideo: class {},
    InputMessagesFilterRoundVoice: class {},
    InputMessagesFilterChatPhotos: class {},
    InputMessagesFilterPhoneCalls: class {},
    InputMessagesFilterMyMentions: class {},
    InputMessagesFilterGeo: class {},
    InputMessagesFilterContacts: class {},
    InputMessagesFilterPinned: class {},
  },
}));

vi.mock('../../src/lib/config.js', () => ({
  createConfig: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    path: '/tmp/mock-config.json',
  })),
  getCredentialsOrThrow: vi.fn(() => ({ apiId: 12345, apiHash: 'testhash' })),
}));

vi.mock('../../src/lib/session-store.js', () => ({
  SessionStore: vi.fn().mockImplementation(() => ({
    withLock: vi.fn(async (_p: string, fn: (s: string) => Promise<any>) => fn('test-session')),
  })),
}));

vi.mock('../../src/lib/client.js', () => ({
  withClient: vi.fn(async (_opts: any, fn: any) => fn(mockClientInstance)),
}));

const mockResolveEntity = vi.fn();
vi.mock('../../src/lib/peer.js', () => ({
  resolveEntity: (...args: any[]) => mockResolveEntity(...args),
  assertForum: vi.fn(),
}));

// Blocklist: channels whose bare id is in `blocked` are hidden.
const blocked = new Set<string>();
vi.mock('../../src/lib/blocklist.js', () => ({
  isBlockedPeer: (peerId: any, chat?: any) => blocked.has(String(peerId?.channelId ?? chat?.id ?? '')),
}));

import { messageSearchAction } from '../../src/commands/message/search.js';

const ctx = (opts: Record<string, unknown> = {}) => ({
  optsWithGlobals: () => ({ profile: 'default', quiet: true, limit: '50', offset: '0', ...opts }),
}) as any;

const post = (id: number, channelId: number, text: string) => ({
  id, message: text, date: 1_700_000_000 + id, senderId: BigInt(1), entities: [], media: null,
  action: null, replyTo: null, fwdFrom: null, peerId: { channelId: BigInt(channelId) },
});

describe('message search --public: blocklist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blocked.clear();
  });

  it('drops posts from blocked channels and lowers total; the paging cursor is unchanged', async () => {
    blocked.add('300');
    mockInvoke.mockResolvedValueOnce({
      messages: [post(10, 200, 'open #tag'), post(11, 300, 'secret #tag')],
      chats: [
        { id: BigInt(200), className: 'Channel', title: 'Open', username: 'open' },
        { id: BigInt(300), className: 'Channel', title: 'Secret', username: 'secret' },
      ],
      count: 5,
      nextRate: 77,
    });

    await messageSearchAction.call(ctx({ public: true, query: 'tag', limit: '2' }));

    const data = mockOutputSuccess.mock.calls[0][0];
    expect(data.messages.map((m: any) => m.text)).toEqual(['open #tag']);
    expect(data.total).toBe(4);
    expect(JSON.stringify(data.messages)).not.toMatch(/secret/i);
    // Cursor follows the raw page so the next page neither repeats nor skips posts.
    expect(data).toMatchObject({ hasMore: true, nextRate: 77, nextOffsetId: 11, nextOffsetPeer: '-100300' });
  });

  it('without blocked channels returns the upstream result unchanged', async () => {
    mockInvoke.mockResolvedValueOnce({
      messages: [post(10, 200, 'open #tag')],
      chats: [{ id: BigInt(200), className: 'Channel', title: 'Open', username: 'open' }],
      count: 1,
    });
    await messageSearchAction.call(ctx({ public: true, query: 'tag' }));
    const data = mockOutputSuccess.mock.calls[0][0];
    expect(data.messages).toHaveLength(1);
    expect(data.total).toBe(1);
  });
});
