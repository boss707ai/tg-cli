import type { Command } from 'commander';
import { Api } from 'telegram';
import { outputSuccess, outputError } from '../../lib/output.js';
import { resolveEntity } from '../../lib/peer.js';
import { extractButtons, bigIntToString } from '../../lib/serialize.js';
import { withAuth } from '../../lib/with-auth.js';
import { parseMessageId } from '../../lib/validate.js';
import { formatError } from '../../lib/errors.js';
import type { GlobalOptions, ButtonItem } from '../../lib/types.js';

/**
 * Action handler for `tg message click <chat> <msg-id>`.
 *
 * Presses an inline keyboard button on a bot message. Select the button by visible
 * label (--text, exact then substring match), by callback_data (--data), or by
 * grid position (--row + --col, both 1-based).
 *
 * Callback buttons are pressed via Api.messages.GetBotCallbackAnswer and the bot's
 * toast/alert text (if any) is returned as botAnswer. URL/WebView buttons are not
 * "pressed" server-side -- their URL is returned so the caller can open it.
 *
 * The bot usually responds by editing this message or sending a new one; read it
 * afterwards with `tg message history <chat> --limit 3`.
 *
 * Returns: { messageId, chatId, button, position, clicked, botAnswer, alert, url }
 */
export async function messageClickAction(
  this: Command,
  chatInput: string,
  msgIdInput: string,
): Promise<void> {
  const opts = this.optsWithGlobals() as GlobalOptions & {
    text?: string;
    data?: string;
    row?: string;
    col?: string;
  };

  // Upstream's strict parser: `42abc`, `0`, `-5`, `1e3` are rejected, not truncated.
  let messageId: number;
  try {
    messageId = parseMessageId(msgIdInput);
  } catch (err: unknown) {
    const { message, code } = formatError(err);
    outputError(message, code);
    return;
  }

  const hasText = opts.text != null;
  const hasData = opts.data != null;
  const hasRowCol = opts.row != null && opts.col != null;

  if (!hasText && !hasData && !hasRowCol) {
    outputError(
      'Specify which button: --text <label>, --data <callback>, or --row <n> --col <n>',
      'NO_BUTTON_SELECTOR',
    );
    return;
  }

  await withAuth(opts, async (client) => {
    const entity = await resolveEntity(client, chatInput);

    const fetched = await client.getMessages(entity, { ids: [messageId] });
    const msg = fetched[0];
    if (!msg) {
      outputError(`Message ${messageId} not found`, 'MESSAGE_NOT_FOUND');
      return;
    }

    const rows = extractButtons((msg as any).replyMarkup);
    if (rows.length === 0) {
      outputError(`Message ${messageId} has no inline buttons`, 'NO_BUTTONS');
      return;
    }

    // Locate the target button by the chosen selector.
    let target: ButtonItem | undefined;
    let position: { row: number; col: number } | undefined;

    const scan = (predicate: (b: ButtonItem) => boolean): boolean => {
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
          if (predicate(rows[r][c])) {
            target = rows[r][c];
            position = { row: r + 1, col: c + 1 };
            return true;
          }
        }
      }
      return false;
    };

    if (hasRowCol) {
      const r = parseInt(opts.row!, 10) - 1;
      const c = parseInt(opts.col!, 10) - 1;
      if (rows[r] && rows[r][c]) {
        target = rows[r][c];
        position = { row: r + 1, col: c + 1 };
      }
    } else if (hasData) {
      scan((b) => b.data === opts.data);
    } else {
      const needle = opts.text!.toLowerCase();
      // Exact label match first, then substring fallback.
      if (!scan((b) => b.text.toLowerCase() === needle)) {
        scan((b) => b.text.toLowerCase().includes(needle));
      }
    }

    if (!target || !position) {
      outputError(
        `No matching button. Available: ${JSON.stringify(rows.flat().map((b) => b.text))}`,
        'BUTTON_NOT_FOUND',
      );
      return;
    }

    // URL / WebView buttons have nothing to press server-side -- hand back the link.
    if (target.type === 'url' || target.type === 'webview') {
      outputSuccess({
        messageId,
        chatId: bigIntToString((entity as any).id),
        button: target.text,
        position,
        type: target.type,
        clicked: false,
        url: target.url ?? null,
        note: 'URL/WebView button — open the URL; nothing is sent to the bot.',
      });
      return;
    }

    if (target.type !== 'callback') {
      outputError(
        `Button type '${target.type}' cannot be clicked via callback`,
        'NOT_CLICKABLE',
      );
      return;
    }

    const answer = (await client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: entity,
        msgId: messageId,
        data: Buffer.from(target.data ?? '', 'utf8'),
      }),
    )) as any;

    outputSuccess({
      messageId,
      chatId: bigIntToString((entity as any).id),
      button: target.text,
      position,
      clicked: true,
      botAnswer: answer?.message ?? null,
      alert: answer?.alert ?? false,
      url: answer?.url ?? null,
      note: 'Bot may reply with a new message or edit this one — read it with: tg message history <chat> --limit 3',
    });
  });
}
