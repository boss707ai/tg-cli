import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { executeDaemonCommand } from '../../src/lib/daemon/execute.js';
import { DAEMON_COMMANDS, isDaemonCommand } from '../../src/lib/daemon/command-protocol.js';
import { daemonRequestForCommand } from '../../src/lib/daemon/route.js';
import { createChatCommand } from '../../src/commands/chat/index.js';
import { createMessageCommand } from '../../src/commands/message/index.js';
import { createMediaCommand } from '../../src/commands/media/index.js';
import { createUserCommand } from '../../src/commands/user/index.js';
import { createContactCommand } from '../../src/commands/contact/index.js';

// Fork commands (chat folders, chat similar, message click) and fork flags
// (chat list --archived/--folder, message send --html) must run through the
// daemon: with a daemon up, direct calls are refused (DAEMON_ALREADY_RUNNING)
// and only DAEMON_COMMANDS are proxied.

const bot = new Api.User({ id: bigInt(777), accessHash: bigInt(1), firstName: 'Bot', bot: true });
const source = new Api.Channel({
  id: bigInt(1234567890), accessHash: bigInt(10), title: 'Source', photo: new Api.ChatPhotoEmpty(), date: 1_700_000_000,
});
const keyboardMessage = new Api.Message({
  id: 42,
  date: 1_700_000_000,
  message: 'Pick one',
  peerId: new Api.PeerUser({ userId: bot.id }),
  replyMarkup: new Api.ReplyInlineMarkup({
    rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: 'Yes', data: Buffer.from('answer:yes') })] })],
  }),
});

describe('fork commands are exposed through the daemon', () => {
  it.each([['chat', 'folders'], ['chat', 'similar'], ['message', 'click']])('%s %s is a daemon command', (group, action) => {
    expect(isDaemonCommand([group, action])).toBe(true);
  });

  it('every action of the proxied groups is daemon-routable, except the streaming message watch', () => {
    const groups = [createChatCommand(), createMessageCommand(), createMediaCommand(), createUserCommand(), createContactCommand()];
    const missing = groups.flatMap(group => group.commands
      .map(action => [group.name(), action.name()])
      .filter(([g, a]) => !(g === 'message' && a === 'watch') && !isDaemonCommand([g, a])));
    expect(missing).toEqual([]);
    expect(Object.keys(DAEMON_COMMANDS)).toEqual(groups.map(g => g.name()));
  });
});

describe('fork commands execute on the daemon client', () => {
  let client: any;
  let controller: AbortController;
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    controller = new AbortController();
    client = {
      getEntity: vi.fn(async (input: string | number) => {
        if (String(input) === 'bot') return bot;
        if (String(input) === 'source') return source;
        throw Object.assign(new Error('USERNAME_NOT_OCCUPIED'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
      }),
      getMessages: vi.fn().mockResolvedValue([keyboardMessage]),
      getDialogs: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(new Api.Message({
        id: 31, peerId: new Api.PeerUser({ userId: bot.id }), date: 1_700_000_000, message: 'sent',
      })),
      invoke: vi.fn(async (request: any) => {
        if (request instanceof Api.messages.GetDialogFilters) {
          return new Api.messages.DialogFilters({
            filters: [
              new Api.DialogFilterDefault(),
              new Api.DialogFilter({
                id: 2, title: new Api.TextWithEntities({ text: 'Work', entities: [] }),
                pinnedPeers: [], includePeers: [new Api.InputPeerUser({ userId: bot.id, accessHash: bigInt(1) })], excludePeers: [],
              }),
            ],
          });
        }
        if (request instanceof Api.channels.GetChannelRecommendations) {
          return new Api.messages.Chats({ chats: [new Api.Channel({
            id: bigInt(5), accessHash: bigInt(5), title: 'Similar', photo: new Api.ChatPhotoEmpty(), date: 1_700_000_000,
          })] });
        }
        if (request instanceof Api.messages.GetBotCallbackAnswer) {
          return new Api.messages.BotCallbackAnswer({ message: 'Thanks!', cacheTime: 0 });
        }
        throw new Error(`Unexpected RPC ${request?.className}`);
      }),
      connect: vi.fn(),
      destroy: vi.fn(),
    };
  });

  afterEach(() => {
    expect(process.exitCode).toBe(previousExitCode);
    process.exitCode = previousExitCode;
    // The shared daemon client is never connected/destroyed per request.
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  const run = (argv: string[]) => executeDaemonCommand(client, 'default', { argv }, controller.signal);

  it('chat folders', async () => {
    const result = await run(['chat', 'folders']);
    expect(result).toEqual({
      output: { ok: true, data: { folders: [{ id: 2, title: 'Work', chatCount: 1, shareable: false }] } },
      exitCode: 0,
    });
  });

  it('chat similar <channel> and without a channel', async () => {
    const result = await run(['chat', 'similar', '--', 'source']);
    expect(result).toMatchObject({ output: { ok: true, data: { chats: [{ id: '5', title: 'Similar', type: 'channel' }], total: 1 } }, exitCode: 0 });
    const request = client.invoke.mock.calls[0][0];
    expect(request.channel).toBe(source);
    expect(await run(['chat', 'similar'])).toMatchObject({ output: { ok: true }, exitCode: 0 });
  });

  it('message click', async () => {
    const result = await run(['message', 'click', '--text=Yes', '--', 'bot', '42']);
    expect(result).toMatchObject({
      output: { ok: true, data: { messageId: 42, chatId: '777', button: 'Yes', clicked: true, botAnswer: 'Thanks!' } },
      exitCode: 0,
    });
  });

  it('message click errors keep their codes and exit status 1', async () => {
    const result = await run(['message', 'click', '--', 'bot', '42']);
    expect(result).toMatchObject({ output: { ok: false, code: 'NO_BUTTON_SELECTOR' }, exitCode: 1 });
  });
});

describe('CLI --daemon re-encoding keeps fork options', () => {
  class Captured extends Error {}

  /** Parse like the CLI does and return the leaf command routeThroughDaemon would forward. */
  async function leaf(group: Command, argv: string[]): Promise<Command> {
    const program = new Command('tg').exitOverride();
    program.addCommand(group);
    let action: Command | undefined;
    program.hook('preAction', (_root, actionCommand) => { action = actionCommand; throw new Captured(); });
    await program.parseAsync(argv, { from: 'user' }).catch((error) => { if (!(error instanceof Captured)) throw error; });
    return action!;
  }

  let client: any;
  beforeEach(() => {
    client = {
      getEntity: vi.fn().mockResolvedValue(bot),
      getDialogs: vi.fn().mockResolvedValue([]),
      invoke: vi.fn().mockResolvedValue(new Api.messages.DialogFilters({ filters: [] })),
      sendMessage: vi.fn().mockResolvedValue(new Api.Message({ id: 1, peerId: new Api.PeerUser({ userId: bot.id }), date: 1, message: 'x' })),
    };
  });
  const execute = (argv: string[]) => executeDaemonCommand(client, 'default', { argv }, new AbortController().signal);

  it('chat list --archived reaches getDialogs({ archived: true }) on the daemon', async () => {
    const request = daemonRequestForCommand(await leaf(createChatCommand(), ['chat', 'list', '--archived', '--type', 'channel']));
    expect(request.argv).toEqual(expect.arrayContaining(['chat', 'list', '--archived', '--type=channel']));
    expect(request.argv.some(arg => arg.startsWith('--limit'))).toBe(false); // whole archive by default
    expect(await execute(request.argv)).toMatchObject({ output: { ok: true }, exitCode: 0 });
    expect(client.getDialogs).toHaveBeenCalledWith({ limit: 100000, archived: true });
  });

  it('chat list --folder is forwarded and resolved on the daemon', async () => {
    const request = daemonRequestForCommand(await leaf(createChatCommand(), ['chat', 'list', '--folder', 'Work']));
    expect(request.argv).toContain('--folder=Work');
    expect(await execute(request.argv)).toMatchObject({ output: { ok: false, code: 'FOLDER_NOT_FOUND' }, exitCode: 1 });
  });

  it('message send --html keeps parseMode html on the daemon', async () => {
    const request = daemonRequestForCommand(await leaf(createMessageCommand(), ['message', 'send', '--html', 'bot', '<b>hi</b>']));
    expect(request.argv).toEqual(['message', 'send', '--html', '--', 'bot', '<b>hi</b>']);
    expect(await execute(request.argv)).toMatchObject({ output: { ok: true }, exitCode: 0 });
    expect(client.sendMessage).toHaveBeenCalledWith(bot, expect.objectContaining({ message: '<b>hi</b>', parseMode: 'html' }));
  });

  it('message click selectors are forwarded', async () => {
    const request = daemonRequestForCommand(await leaf(createMessageCommand(), ['message', 'click', 'bot', '42', '--row', '1', '--col', '2']));
    expect(request.argv).toEqual(['message', 'click', '--row=1', '--col=2', '--', 'bot', '42']);
  });
});
