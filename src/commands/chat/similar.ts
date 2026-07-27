import type { Command } from 'commander';
import { Api } from 'telegram';
import { withAuth } from '../../lib/with-auth.js';
import { outputSuccess } from '../../lib/output.js';
import { resolveEntity } from '../../lib/peer.js';
import { bigIntToString } from '../../lib/serialize.js';
import type { GlobalOptions } from '../../lib/types.js';

/**
 * Determine chat type from a gramjs Chat or Channel entity.
 */
function chatType(entity: any): string {
  if (entity.className === 'Channel') {
    return entity.megagroup ? 'supergroup' : 'channel';
  }
  if (entity.className === 'Chat') return 'group';
  return 'unknown';
}

/**
 * Action handler for `tg chat similar [channel]`.
 *
 * Fetches the "Similar Channels" recommendations Telegram surfaces for a
 * channel (channels.getChannelRecommendations). With a channel argument it
 * returns channels similar to that one; without it, personal recommendations
 * based on the account's subscriptions.
 *
 * The API returns messages.Chats or messages.ChatsSlice. ChatsSlice carries a
 * `count` field: the total available (Premium accounts get the full list,
 * non-Premium see a truncated set), which is reported as `totalAvailable`.
 */
export async function chatSimilarAction(
  this: Command,
  channelInput: string | undefined,
): Promise<void> {
  const opts = this.optsWithGlobals() as GlobalOptions;

  await withAuth(opts, async (client) => {
    const channel = channelInput
      ? await resolveEntity(client, channelInput)
      : undefined;

    const res = await client.invoke(
      new Api.channels.GetChannelRecommendations({ channel }),
    );

    const chats = ((res as any).chats ?? [])
      .filter((c: any) => c.className === 'Channel' || c.className === 'Chat')
      .map((c: any) => ({
        id: bigIntToString(c.id),
        title: c.title ?? '',
        type: chatType(c),
        username: c.username ?? null,
        membersCount: c.participantsCount ?? null,
      }));

    // ChatsSlice => truncated list; `count` is the true total (Premium-gated).
    const totalAvailable = (res as any).count ?? chats.length;

    outputSuccess({ chats, total: chats.length, totalAvailable });
  });
}
