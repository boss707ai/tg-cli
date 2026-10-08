import type { Command } from 'commander';
import { outputSuccess, outputError } from '../../lib/output.js';
import { resolveEntity, assertForum } from '../../lib/peer.js';
import { serializeMessage } from '../../lib/serialize.js';
import { withAuth } from '../../lib/with-auth.js';
import type { GlobalOptions } from '../../lib/types.js';

/**
 * Read all data from stdin as a UTF-8 string.
 * Used when the text argument is "-" (dash placeholder) to support piped input.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trimEnd();
}

/**
 * Action handler for `tg message send <chat> <text>`.
 *
 * Sends a text message to any chat. Supports:
 * - Reply to a specific message via --reply-to <msgId>
 * - Piped stdin input via dash placeholder: echo "msg" | tg message send <chat> -
 * - gramjs built-in markdown parsing for **bold**, __italic__, `code`, [links](url)
 *
 * Returns the sent message as a serialized MessageItem.
 */
export async function messageSendAction(this: Command, chat: string, text: string): Promise<void> {
  const opts = this.optsWithGlobals() as GlobalOptions & { replyTo?: string; topic?: string; commentTo?: string; html?: boolean };

  // Handle stdin pipe via dash placeholder
  if (text === '-') {
    if (process.stdin.isTTY) {
      outputError('"-" requires piped input. Example: echo "msg" | tg message send @user -', 'STDIN_REQUIRED');
      return;
    }
    text = await readStdin();
  }

  // Validate non-empty text
  if (!text) {
    outputError('Message text is required', 'EMPTY_MESSAGE');
    return;
  }

  // Telegram message length limit
  if (text.length > 4096) {
    outputError('Message too long (max 4096 chars)', 'MESSAGE_TOO_LONG');
    return;
  }

  // Parse --topic as integer
  const topicId = opts.topic ? parseInt(opts.topic, 10) : undefined;
  if (opts.topic && (topicId === undefined || isNaN(topicId))) {
    outputError('Invalid topic ID: must be a number', 'INVALID_TOPIC_ID');
    return;
  }

  // Parse replyTo as integer
  const replyTo = opts.replyTo ? parseInt(opts.replyTo, 10) : undefined;
  if (opts.replyTo && (replyTo === undefined || isNaN(replyTo))) {
    outputError('Invalid reply-to message ID: must be a number', 'INVALID_REPLY_TO');
    return;
  }

  // Parse commentTo as integer (for channel post comments)
  const commentTo = opts.commentTo ? parseInt(opts.commentTo, 10) : undefined;
  if (opts.commentTo && (commentTo === undefined || isNaN(commentTo))) {
    outputError('Invalid comment-to message ID: must be a number', 'INVALID_COMMENT_TO');
    return;
  }

  await withAuth(opts, async (client) => {
    const entity = await resolveEntity(client, chat);

    // Forum guard: reject --topic on non-forum chats
    await assertForum(entity, topicId);

    // --topic overrides --reply-to since topic scoping IS the replyTo in gramjs
    const effectiveReplyTo = topicId !== undefined ? topicId : replyTo;

    // Default: gramjs MarkdownParser (**bold**, __italic__, `code`). NB: базовый markdown НЕ тянет инлайн-ссылки [text](url).
    // --html: parseMode 'html' → поддержка <a href>, <b>, <i> (для чистых текст-ссылок «Подписаться на канал»).
    const sentMsg = await client.sendMessage(entity, {
      message: text,
      replyTo: effectiveReplyTo,
      ...(opts.html ? { parseMode: 'html' } : {}),
      ...(commentTo !== undefined && { commentTo }),
    });

    const serialized = serializeMessage(sentMsg as any, (sentMsg as any)._sender);
    outputSuccess(serialized);
  });
}
