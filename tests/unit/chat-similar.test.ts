import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fork feature: `tg chat similar [channel]` (channels.getChannelRecommendations).

const mockOutputSuccess = vi.fn();
vi.mock('../../src/lib/output.js', () => ({
  outputSuccess: (...args: any[]) => mockOutputSuccess(...args),
  outputError: vi.fn(),
  logStatus: vi.fn(),
}));

const { MockGetChannelRecommendations } = vi.hoisted(() => ({
  MockGetChannelRecommendations: vi.fn().mockImplementation((args: any) => ({ className: 'channels.GetChannelRecommendations', ...args })),
}));
vi.mock('telegram', () => ({
  Api: { channels: { GetChannelRecommendations: MockGetChannelRecommendations } },
}));

const mockInvoke = vi.fn();
const mockClient = { invoke: mockInvoke } as any;
vi.mock('../../src/lib/with-auth.js', () => ({
  withAuth: async (_opts: any, fn: any) => fn(mockClient),
}));

const mockResolveEntity = vi.fn();
vi.mock('../../src/lib/peer.js', () => ({
  resolveEntity: (...args: any[]) => mockResolveEntity(...args),
}));

import { chatSimilarAction } from '../../src/commands/chat/similar.js';

const ctx = { optsWithGlobals: () => ({ profile: 'default' }) } as any;
const recommendations = {
  className: 'messages.ChatsSlice',
  count: 42,
  chats: [
    { className: 'Channel', id: BigInt(1), title: 'Alpha', username: 'alpha', participantsCount: 1000 },
    { className: 'Channel', id: BigInt(2), title: 'Beta Chat', megagroup: true },
    { className: 'Chat', id: BigInt(3), title: 'Small group' },
    { className: 'ChatForbidden', id: BigInt(4), title: 'Gone' },
  ],
};

describe('chat similar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the channel through resolveEntity (blocklist guard) and asks for recommendations', async () => {
    const entity = { id: BigInt(10), className: 'Channel' };
    mockResolveEntity.mockResolvedValueOnce(entity);
    mockInvoke.mockResolvedValueOnce(recommendations);
    await chatSimilarAction.call(ctx, '@source');
    expect(mockResolveEntity).toHaveBeenCalledWith(mockClient, '@source');
    expect(MockGetChannelRecommendations).toHaveBeenCalledWith({ channel: entity });
    expect(mockOutputSuccess).toHaveBeenCalledWith({
      chats: [
        { id: '1', title: 'Alpha', type: 'channel', username: 'alpha', membersCount: 1000 },
        { id: '2', title: 'Beta Chat', type: 'supergroup', username: null, membersCount: null },
        { id: '3', title: 'Small group', type: 'group', username: null, membersCount: null },
      ],
      total: 3,
      totalAvailable: 42,
    });
  });

  it('without a channel asks for personal recommendations', async () => {
    mockInvoke.mockResolvedValueOnce({ chats: [] });
    await chatSimilarAction.call(ctx, undefined);
    expect(mockResolveEntity).not.toHaveBeenCalled();
    expect(MockGetChannelRecommendations).toHaveBeenCalledWith({ channel: undefined });
    expect(mockOutputSuccess).toHaveBeenCalledWith({ chats: [], total: 0, totalAvailable: 0 });
  });

  it('propagates CHAT_BLOCKED from resolveEntity without calling Telegram', async () => {
    mockResolveEntity.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'CHAT_BLOCKED' }));
    await expect(chatSimilarAction.call(ctx, '@blocked')).rejects.toMatchObject({ code: 'CHAT_BLOCKED' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
