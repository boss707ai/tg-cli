import { appendFileSync } from 'node:fs';
import bigInt from 'big-integer';
import { Api } from 'telegram/tl/api.js';

export { Api };

/**
 * Offline MTProto boundary for the fork's daemon process tests: commands, IPC,
 * output, blocklist and process lifetime are real; only TelegramClient is fake.
 * All peers and texts are synthetic.
 */
function record(event: string, details: Record<string, unknown> = {}): void {
  const path = process.env.TG_DAEMON_API_TEST_JOURNAL;
  if (!path) throw new Error('Offline daemon fixture requires its isolated journal');
  appendFileSync(path, JSON.stringify({ event, pid: process.pid, ...details }) + '\n');
}

export const sessions = {
  StringSession: class {
    constructor(private readonly value: string) {}
    save(): string { return this.value; }
  },
};

const photo = new Api.ChatPhotoEmpty();
const me = new Api.User({ id: bigInt(7), accessHash: bigInt(20), self: true, firstName: 'Offline', lastName: 'Fixture', username: 'fixture' });
const bot = new Api.User({ id: bigInt(777), accessHash: bigInt(21), bot: true, firstName: 'Fixture', lastName: 'Bot', username: 'fixturebot' });
const friend = new Api.User({ id: bigInt(8), accessHash: bigInt(22), firstName: 'Private', lastName: 'Friend', username: 'friend' });
const source = new Api.Channel({ id: bigInt(1234567890), accessHash: bigInt(10), title: 'Open source channel', username: 'source', photo, date: 1_700_000_000, broadcast: true });
const secret = new Api.Channel({ id: bigInt(555), accessHash: bigInt(11), title: 'Secret channel', username: 'secret_chan', photo, date: 1_700_000_000, broadcast: true });
const archivedChannel = new Api.Channel({ id: bigInt(999), accessHash: bigInt(12), title: 'Archived channel', photo, date: 1_700_000_000, broadcast: true });
const similar = new Api.Channel({ id: bigInt(4242), accessHash: bigInt(13), title: 'Similar channel', username: 'similar', photo, date: 1_700_000_000, broadcast: true });

const peers: Record<string, Api.User | Api.Channel> = {
  me, fixture: me, 7: me,
  fixturebot: bot, 777: bot,
  friend, 8: friend,
  source, '-1001234567890': source,
  secret_chan: secret, '-100555': secret,
};

const peerOf = (entity: Api.User | Api.Channel) => (entity instanceof Api.Channel
  ? new Api.PeerChannel({ channelId: entity.id })
  : new Api.PeerUser({ userId: entity.id }));

function message(id: number, text: string, chat: Api.User | Api.Channel, extra: Record<string, unknown> = {}): Api.Message {
  const result = new Api.Message({ id, date: 1_700_000_000 + id, message: text, peerId: peerOf(chat), fromId: new Api.PeerUser({ userId: me.id }), ...extra });
  (result as any)._sender = me;
  (result as any)._chat = chat;
  return result;
}

function dialog(entity: Api.User | Api.Channel, title: string) {
  const id = entity instanceof Api.Channel ? bigInt(`-100${entity.id.toString()}`) : entity.id;
  return {
    id, title, name: title, entity,
    isUser: entity instanceof Api.User, isChannel: entity instanceof Api.Channel, isGroup: false,
    unreadCount: 0, date: 1_700_000_000,
    message: { id: 1, date: 1_700_000_000 },
    inputEntity: entity,
  };
}

/**
 * Async iterable shaped like gramjs RequestIter ({ next } object, no generator):
 * the daemon's request-client Proxy calls next() with the proxy as receiver,
 * which native async generator objects reject.
 */
function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: async () => (index < items.length ? { value: items[index++], done: false } : { value: undefined as never, done: true }),
        return: async () => ({ value: undefined as never, done: true }),
      };
    },
  };
}

const keyboard = new Api.ReplyInlineMarkup({
  rows: [new Api.KeyboardButtonRow({ buttons: [
    new Api.KeyboardButtonCallback({ text: 'Yes', data: Buffer.from('answer:yes') }),
    new Api.KeyboardButtonUrl({ text: 'Site', url: 'https://example.org/fixture' }),
  ] })],
});

export class TelegramClient {
  constructor(..._args: unknown[]) { record('constructor'); }
  async connect(): Promise<void> { record('connect'); }
  async destroy(): Promise<void> { record('destroy'); }

  async getEntity(input: string | number): Promise<Api.User | Api.Channel> {
    record('getEntity', { input: String(input) });
    const entity = peers[String(input)];
    if (entity) return entity;
    throw Object.assign(new Error('No such offline fixture peer'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
  }

  async getDialogs(options: { limit: number; archived?: boolean; offsetId?: number }): Promise<unknown[]> {
    record('getDialogs', { archived: options.archived === true });
    if (options.offsetId) return [];
    const dialogs = options.archived
      ? [dialog(archivedChannel, archivedChannel.title)]
      : [dialog(me, 'Saved Messages'), dialog(bot, 'Fixture Bot'), dialog(friend, 'Private Friend'), dialog(source, source.title), dialog(secret, secret.title)];
    return Object.assign(dialogs.slice(0, options.limit), { total: dialogs.length });
  }

  iterDialogs(_options: unknown): AsyncIterable<unknown> {
    record('iterDialogs');
    return asyncIterable([me, bot, friend, source, secret].map((entity) => ({ entity })));
  }

  async getMessages(entity: Api.User | Api.Channel, options: { limit?: number; ids?: number[] }): Promise<Api.Message[]> {
    record('getMessages', { chat: entity?.id?.toString() });
    if (options.ids) return entity === bot && options.ids[0] === 42 ? [message(42, 'Pick one', bot, { replyMarkup: keyboard })] : [];
    const history = [message(3, `history of ${entity.id.toString()}`, entity)];
    return Object.assign(history.slice(0, options.limit ?? 50), { total: history.length });
  }

  /** Global search (getMessages/iterMessages without a peer): hits in several chats. */
  iterMessages(_entity: unknown, options: { limit?: number }) {
    record('iterMessages');
    const hits = [
      message(11, 'needle in saved messages', me),
      message(12, 'needle in the secret channel', secret),
      message(13, 'needle from a private friend', friend),
      message(14, 'needle in the open channel', source),
    ];
    return Object.assign(asyncIterable(hits.slice(0, options.limit ?? hits.length)), { total: hits.length });
  }

  async sendMessage(entity: Api.User | Api.Channel, options: { message: string; parseMode?: string }): Promise<Api.Message> {
    record('sendMessage', { parseMode: options.parseMode ?? null });
    return message(100, options.message, entity);
  }

  async invoke(request: any): Promise<unknown> {
    record('invoke', { request: request?.className });
    if (request instanceof Api.messages.GetDialogFilters) {
      return new Api.messages.DialogFilters({ filters: [
        new Api.DialogFilterDefault(),
        new Api.DialogFilter({
          id: 2, title: new Api.TextWithEntities({ text: 'Work', entities: [] }),
          pinnedPeers: [], excludePeers: [],
          includePeers: [new Api.InputPeerChannel({ channelId: source.id, accessHash: bigInt(10) }), new Api.InputPeerChannel({ channelId: secret.id, accessHash: bigInt(11) })],
        }),
      ] });
    }
    if (request instanceof Api.channels.GetChannelRecommendations) return new Api.messages.Chats({ chats: [similar] });
    if (request instanceof Api.messages.GetBotCallbackAnswer) return new Api.messages.BotCallbackAnswer({ message: 'Thanks from the fixture bot', cacheTime: 0 });
    throw Object.assign(new Error(`Unexpected offline RPC ${request?.className}`), { errorMessage: 'FIXTURE_UNEXPECTED_RPC' });
  }

  addEventHandler(): void { record('subscribe'); }
  removeEventHandler(): void { record('unsubscribe'); }
}
