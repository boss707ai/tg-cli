import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Api } from 'telegram';
import bigInt from 'big-integer';

// Fork feature: inline keyboards — `tg message click` (--text / --data / --row --col)
// and the `buttons` field in message serialization (`--fields ...,buttons`).
// Uses the real gramjs Api classes so `instanceof` checks in extractButtons run.

const mockOutputSuccess = vi.fn();
const mockOutputError = vi.fn();
vi.mock('../../src/lib/output.js', () => ({
  outputSuccess: (...args: any[]) => mockOutputSuccess(...args),
  outputError: (...args: any[]) => mockOutputError(...args),
  logStatus: vi.fn(),
}));

const mockGetMessages = vi.fn();
const mockInvoke = vi.fn();
const mockClient = { getMessages: mockGetMessages, invoke: mockInvoke } as any;
vi.mock('../../src/lib/with-auth.js', () => ({
  withAuth: async (_opts: any, fn: any) => fn(mockClient),
}));

const mockResolveEntity = vi.fn();
vi.mock('../../src/lib/peer.js', () => ({
  resolveEntity: (...args: any[]) => mockResolveEntity(...args),
}));

import { messageClickAction } from '../../src/commands/message/click.js';
import { serializeMessage, extractButtons } from '../../src/lib/serialize.js';
import { applyFieldSelection } from '../../src/lib/fields.js';

const bot = new Api.User({ id: bigInt(777), accessHash: bigInt(1), firstName: 'Bot', bot: true });

const keyboard = () => new Api.ReplyInlineMarkup({
  rows: [
    new Api.KeyboardButtonRow({
      buttons: [
        new Api.KeyboardButtonCallback({ text: 'Yes', data: Buffer.from('answer:yes') }),
        new Api.KeyboardButtonCallback({ text: 'No thanks', data: Buffer.from('answer:no') }),
      ],
    }),
    new Api.KeyboardButtonRow({
      buttons: [
        new Api.KeyboardButtonUrl({ text: 'Open site', url: 'https://example.org/x' }),
        new Api.KeyboardButtonSwitchInline({ text: 'Share', query: '' }),
      ],
    }),
  ],
});

const botMessage = (replyMarkup?: any) => new Api.Message({
  id: 42,
  date: 1_700_000_000,
  message: 'Pick one',
  peerId: new Api.PeerUser({ userId: bigInt(777) }),
  replyMarkup,
});

const ctx = (opts: Record<string, any> = {}) => ({ optsWithGlobals: () => ({ profile: 'default', ...opts }) }) as any;

describe('extractButtons / serialization', () => {
  it('serializes inline keyboards as rows of buttons with callback data and urls', () => {
    const item = serializeMessage(botMessage(keyboard()) as any);
    expect(item.buttons).toEqual([
      [
        { text: 'Yes', type: 'callback', data: 'answer:yes' },
        { text: 'No thanks', type: 'callback', data: 'answer:no' },
      ],
      [
        { text: 'Open site', type: 'url', url: 'https://example.org/x' },
        { text: 'Share', type: 'switch_inline' },
      ],
    ]);
  });

  it('omits buttons for messages without a keyboard', () => {
    expect(serializeMessage(botMessage() as any)).not.toHaveProperty('buttons');
    expect(extractButtons(undefined)).toEqual([]);
  });

  it('keeps buttons under --fields id,buttons (message get output shape)', () => {
    const item = serializeMessage(botMessage(keyboard()) as any);
    const picked = applyFieldSelection({ messages: [item], notFound: [] }, ['id', 'buttons']) as any;
    expect(picked.messages[0]).toEqual({ id: 42, buttons: item.buttons });
  });
});

describe('message click', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveEntity.mockResolvedValue(bot);
    mockGetMessages.mockResolvedValue([botMessage(keyboard())]);
    mockInvoke.mockResolvedValue({ message: 'Thanks!', alert: false });
  });

  it('--text presses a callback button (exact label) via GetBotCallbackAnswer', async () => {
    await messageClickAction.call(ctx({ text: 'yes' }), '@bot', '42');
    expect(mockResolveEntity).toHaveBeenCalledWith(mockClient, '@bot');
    expect(mockGetMessages).toHaveBeenCalledWith(bot, { ids: [42] });
    const request = mockInvoke.mock.calls[0][0];
    expect(request).toBeInstanceOf(Api.messages.GetBotCallbackAnswer);
    expect(request.msgId).toBe(42);
    expect(Buffer.from(request.data).toString('utf8')).toBe('answer:yes');
    expect(mockOutputSuccess).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 42,
      chatId: '777',
      button: 'Yes',
      position: { row: 1, col: 1 },
      clicked: true,
      botAnswer: 'Thanks!',
      alert: false,
    }));
  });

  it('--text falls back to a substring match', async () => {
    await messageClickAction.call(ctx({ text: 'thanks' }), '@bot', '42');
    expect(Buffer.from(mockInvoke.mock.calls[0][0].data).toString('utf8')).toBe('answer:no');
  });

  it('--data selects by callback_data', async () => {
    await messageClickAction.call(ctx({ data: 'answer:no' }), '@bot', '42');
    expect(mockOutputSuccess).toHaveBeenCalledWith(expect.objectContaining({ button: 'No thanks', position: { row: 1, col: 2 } }));
  });

  it('--row/--col on a URL button returns the url without contacting the bot', async () => {
    await messageClickAction.call(ctx({ row: '2', col: '1' }), '@bot', '42');
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockOutputSuccess).toHaveBeenCalledWith(expect.objectContaining({
      clicked: false,
      type: 'url',
      url: 'https://example.org/x',
    }));
  });

  it('rejects non-callback, non-url buttons with NOT_CLICKABLE', async () => {
    await messageClickAction.call(ctx({ row: '2', col: '2' }), '@bot', '42');
    expect(mockOutputError).toHaveBeenCalledWith(expect.any(String), 'NOT_CLICKABLE');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('requires a selector before connecting', async () => {
    await messageClickAction.call(ctx(), '@bot', '42');
    expect(mockOutputError).toHaveBeenCalledWith(expect.any(String), 'NO_BUTTON_SELECTOR');
    expect(mockResolveEntity).not.toHaveBeenCalled();
  });

  it('reports BUTTON_NOT_FOUND with the available labels', async () => {
    await messageClickAction.call(ctx({ text: 'maybe' }), '@bot', '42');
    expect(mockOutputError).toHaveBeenCalledWith(expect.stringContaining('"Yes"'), 'BUTTON_NOT_FOUND');
  });

  it('reports NO_BUTTONS and MESSAGE_NOT_FOUND', async () => {
    mockGetMessages.mockResolvedValueOnce([botMessage()]);
    await messageClickAction.call(ctx({ text: 'yes' }), '@bot', '42');
    expect(mockOutputError).toHaveBeenLastCalledWith(expect.any(String), 'NO_BUTTONS');
    mockGetMessages.mockResolvedValueOnce([]);
    await messageClickAction.call(ctx({ text: 'yes' }), '@bot', '42');
    expect(mockOutputError).toHaveBeenLastCalledWith(expect.any(String), 'MESSAGE_NOT_FOUND');
  });

  it('a blocked chat stops the click at resolveEntity', async () => {
    mockResolveEntity.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'CHAT_BLOCKED' }));
    await expect(messageClickAction.call(ctx({ text: 'yes' }), '@blocked', '42')).rejects.toMatchObject({ code: 'CHAT_BLOCKED' });
    expect(mockGetMessages).not.toHaveBeenCalled();
  });
});
