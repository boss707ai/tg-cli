import type { Command } from 'commander';
import { withAuth } from '../../lib/with-auth.js';
import { outputSuccess } from '../../lib/output.js';
import { getFolders } from '../../lib/folders.js';
import type { GlobalOptions } from '../../lib/types.js';

/**
 * Action handler for `tg chat folders`.
 * Lists Telegram chat folders (dialog filters) with their explicit chat counts.
 * Use `tg chat list --folder <id|title>` to list the chats inside one.
 */
export async function chatFoldersAction(this: Command): Promise<void> {
  const opts = this.optsWithGlobals() as GlobalOptions;

  await withAuth(opts, async (client) => {
    const folders = await getFolders(client);
    outputSuccess({
      folders: folders.map((f) => ({
        id: f.id,
        title: f.title,
        chatCount: f.peerIds.size,
        shareable: f.shareable,
      })),
    });
  });
}
