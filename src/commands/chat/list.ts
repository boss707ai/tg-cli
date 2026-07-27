import type { Command } from 'commander';
import { withAuth } from '../../lib/with-auth.js';
import { outputSuccess } from '../../lib/output.js';
import { serializeDialog } from '../../lib/serialize.js';
import { isBlockedDialog, normalizeId } from '../../lib/blocklist.js';
import { getFolders, findFolder } from '../../lib/folders.js';
import { TgError } from '../../lib/errors.js';
import type { GlobalOptions } from '../../lib/types.js';

/**
 * Action handler for `tg chat list`.
 *
 * Lists chats/dialogs with optional type/folder filtering and pagination.
 * Options: --type, --folder <id|title>, --limit (default 50), --offset (default 0)
 */
export async function chatListAction(this: Command): Promise<void> {
  const opts = this.optsWithGlobals() as GlobalOptions & {
    type?: string;
    folder?: string;
    limit?: string;
    offset: string;
  };
  // Read separately so the boolean flag doesn't break the all-string opts shape
  // that withAuth expects.
  const archived = (opts as { archived?: boolean }).archived === true;

  const offset = parseInt(opts.offset, 10) || 0;
  // A folder (or the system Archive) is a small, explicit set — it bounds itself —
  // so without an explicit --limit we return the whole set (no arbitrary cap to
  // silently truncate it). The whole-account list isn't bounded (1000+ dialogs),
  // so it keeps a 50 page. An explicit --limit always wins in either mode.
  const wholeSet = opts.folder != null || archived;
  const limit =
    opts.limit != null
      ? parseInt(opts.limit, 10) || 50
      : wholeSet
        ? Infinity
        : 50;

  await withAuth(opts, async (client) => {
    // Folder/archive mode fetches the full dialog list once, then keeps only the
    // relevant members. Robust (one read, like the app does on startup). Members
    // with no accessible dialog (e.g. a private channel we've left) can't appear.
    // `archived: true` reads folder 1 (the system Archive) instead of the main list.
    const dialogParams: { limit: number; archived?: boolean } = {
      limit: wholeSet ? 100000 : offset + limit,
    };
    if (archived) dialogParams.archived = true;
    const dialogs = await client.getDialogs(dialogParams);

    let chats = dialogs.map(serializeDialog);

    // Hide chats on the local read-access blocklist (privacy guard)
    chats = chats.filter((c) => !isBlockedDialog(c));

    // Filter by Telegram folder (dialog filter) if requested
    if (opts.folder) {
      const folder = findFolder(await getFolders(client), opts.folder);
      if (!folder) {
        throw new TgError(`Folder not found: ${opts.folder}`, 'FOLDER_NOT_FOUND');
      }
      const ids = new Set([...folder.peerIds].map((id) => normalizeId(id)));
      chats = chats.filter((c) => c.id != null && ids.has(normalizeId(c.id)));
    }

    // Filter by type
    if (opts.type) {
      chats = chats.filter((c) => c.type === opts.type);
    }

    const total = chats.length;
    chats = chats.slice(offset, offset + limit);

    outputSuccess({ chats, total });
  });
}
