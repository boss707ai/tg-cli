import type { Command } from 'commander';
import { Api } from 'telegram';
import { outputSuccess, outputError } from '../../lib/output.js';
import { resolveEntity } from '../../lib/peer.js';
import { messagePeerMarkedId, serializeMessage } from '../../lib/serialize.js';
import { buildEntityMap } from '../../lib/entity-map.js';
import { isBlockedPeer } from '../../lib/blocklist.js';
import { withAuth } from '../../lib/with-auth.js';
import { parseMessageIds, validatePagination } from '../../lib/validate.js';
import { formatError } from '../../lib/errors.js';
import { batchError, outputBatchResult } from '../../lib/batch-results.js';
import type { BatchItemError, GlobalOptions, MessageItem } from '../../lib/types.js';

/**
 * Serialize messages from a GetReplies result, resolving sender names.
 *
 * Comments on a channel post live in the linked discussion group, so GetReplies
 * returns messages from a chat that never went through resolveEntity. Messages
 * whose chat is on the read-access blocklist are dropped here, and `total`
 * (the server count) is lowered by the number hidden.
 */
function serializeReplies(result: any): { messages: MessageItem[]; total: number } {
  const entityMap = buildEntityMap(result);
  const visible = (result.messages ?? []).filter(
    (msg: any) => !isBlockedPeer(msg.peerId, entityMap.get(messagePeerMarkedId(msg))),
  );
  const hidden = (result.messages ?? []).length - visible.length;
  const messages = visible.map((msg: any) => {
    const senderId = messagePeerMarkedId({ peerId: msg.fromId });
    const senderEntity = entityMap.get(senderId);
    return serializeMessage(msg, senderEntity);
  });
  return { messages, total: Math.max(0, (result.count ?? 0) - hidden) };
}

/**
 * Action handler for `tg message replies <channel> <msg-ids>`.
 *
 * Reads replies/comments on channel posts using messages.GetReplies.
 * Accepts comma-separated msg IDs for batch fetching in a single connection.
 * Options: --limit (default 50), --offset (default 0)
 */
export async function messageRepliesAction(
  this: Command,
  channelInput: string,
  msgIdsInput: string,
): Promise<void> {
  const opts = this.optsWithGlobals() as GlobalOptions & {
    limit: string;
    offset: string;
  };

  let limit: number;
  let offset: number;
  let msgIds: number[];
  try {
    ({ limit, offset } = validatePagination({ limit: opts.limit, offset: opts.offset }));
    msgIds = parseMessageIds(msgIdsInput);
  } catch (err: unknown) {
    const { message, code } = formatError(err);
    outputError(message, code);
    return;
  }

  await withAuth(opts, async (client) => {
    const entity = await resolveEntity(client, channelInput);

    // Single post — original simple output
    if (msgIds.length === 1) {
      const result = await client.invoke(
        new Api.messages.GetReplies({
          peer: entity,
          msgId: msgIds[0],
          limit,
          addOffset: offset,
        }),
      );

      const { messages, total } = serializeReplies(result);
      outputSuccess({
        messages,
        total,
        postId: msgIds[0],
      });
      return;
    }

    // Batch mode — iterate over post IDs within one connection
    const posts: Array<{
      postId: number;
      messages: MessageItem[];
      total: number;
    }> = [];
    const errors: BatchItemError[] = [];

    for (const msgId of msgIds) {
      try {
        const result = await client.invoke(
          new Api.messages.GetReplies({
            peer: entity,
            msgId,
            limit,
            addOffset: offset,
          }),
        );

        const { messages, total } = serializeReplies(result);
        posts.push({
          postId: msgId,
          messages,
          total,
        });
      } catch (err: unknown) {
        errors.push(batchError(String(msgId), err));
      }
    }

    outputBatchResult({ posts }, errors);
  });
}
