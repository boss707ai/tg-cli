import type { Command } from 'commander';
import type { TelegramClient } from 'telegram';
import { withAuth } from '../../lib/with-auth.js';
import { outputSuccess, outputError } from '../../lib/output.js';
import { bigIntToString, serializeDialog } from '../../lib/serialize.js';
import { validatePagination } from '../../lib/validate.js';
import { formatError, TgError } from '../../lib/errors.js';
import { isBlockedDialog, normalizeId } from '../../lib/blocklist.js';
import { getFolders, findFolder } from '../../lib/folders.js';
import type { ChatListItem, GlobalOptions } from '../../lib/types.js';

const DIALOG_BATCH = 100;
const MAX_DIALOGS = 5000;
/** Folder/Archive mode reads the whole (self-bounded) set in one request. */
const WHOLE_SET_LIMIT = 100000;

/**
 * Keep fetching dialogs until we have `offset + limit` chats accepted by `keep`,
 * or the dialog list is exhausted.
 *
 * The first request asks for `firstBatch` dialogs (the plain list asks for
 * `offset + limit` at once, like before); follow-up requests page in batches of
 * DIALOG_BATCH from the last seen dialog. Filtering happens BEFORE pagination,
 * so offset/limit/total count only chats that pass `keep` (blocked chats never
 * shift a page or show up as a gap).
 */
async function fetchFilteredPage(
  client: TelegramClient,
  keep: (chat: ChatListItem) => boolean,
  offset: number,
  limit: number,
  firstBatch: number = DIALOG_BATCH,
): Promise<{ chats: ChatListItem[]; total: number; hasMore: boolean }> {
  const needed = offset + limit;
  const matching: ChatListItem[] = [];
  const seen = new Set<string>();
  let last: any;
  let fetched = 0;
  let exhausted = false;

  while (matching.length < needed && fetched < MAX_DIALOGS) {
    const requested = last ? DIALOG_BATCH : firstBatch;
    const params: Record<string, unknown> = { limit: requested };
    if (last) {
      params.offsetDate = last.date ?? last.message?.date;
      params.offsetId = last.message?.id ?? last.topMessage ?? 0;
      params.offsetPeer = last.inputEntity ?? last.entity;
    }
    const batch = await client.getDialogs(params as any);
    if (!batch.length) {
      exhausted = true;
      break;
    }
    fetched += batch.length;
    for (const dialog of batch) {
      const key = bigIntToString((dialog as any).id) || String((dialog as any).id);
      if (seen.has(key)) continue;
      seen.add(key);
      last = dialog;
      const chat = serializeDialog(dialog);
      if (keep(chat)) matching.push(chat);
    }
    if (batch.length < requested) {
      exhausted = true;
      break;
    }
  }

  return {
    chats: matching.slice(offset, offset + limit),
    total: matching.length,
    hasMore:
      matching.length > offset + limit
      || (matching.length >= needed && !exhausted && fetched < MAX_DIALOGS),
  };
}

/**
 * Action handler for `tg chat list`.
 *
 * Lists chats/dialogs with optional type/folder filtering and pagination.
 * Options: --type (user|group|channel|supergroup), --folder <id|title>, --archived,
 * --limit (default 50; whole set with --folder/--archived), --offset (default 0).
 *
 * Chats on the local read-access blocklist are hidden on every path, before
 * pagination: offset/limit/total count visible chats only.
 */
export async function chatListAction(this: Command): Promise<void> {
  const opts = this.optsWithGlobals() as GlobalOptions & {
    type?: string;
    folder?: string;
    limit?: string;
    offset?: string;
  };
  // Read separately so the boolean flag doesn't break the all-string opts shape
  // that withAuth expects.
  const archived = (opts as { archived?: boolean }).archived === true;

  let limit: number;
  let offset: number;
  try {
    ({ limit, offset } = validatePagination({ limit: opts.limit, offset: opts.offset }));
  } catch (err: unknown) {
    const { message, code } = formatError(err);
    outputError(message, code);
    return;
  }

  // A folder (or the system Archive) is a small, explicit set — it bounds itself —
  // so without an explicit --limit we return the whole set (no arbitrary cap to
  // silently truncate it). The whole-account list isn't bounded (1000+ dialogs),
  // so it keeps a 50 page. An explicit --limit always wins in either mode.
  const wholeSet = opts.folder != null || archived;
  if (wholeSet && opts.limit == null) limit = Infinity;

  await withAuth(opts, async (client) => {
    if (wholeSet) {
      // Folder/archive mode fetches the full dialog list once, then keeps only the
      // relevant members. Robust (one read, like the app does on startup). Members
      // with no accessible dialog (e.g. a private channel we've left) can't appear.
      // `archived: true` reads folder 1 (the system Archive) instead of the main list.
      const dialogParams: { limit: number; archived?: boolean } = { limit: WHOLE_SET_LIMIT };
      if (archived) dialogParams.archived = true;
      const dialogs = await client.getDialogs(dialogParams);

      // Hide chats on the local read-access blocklist (privacy guard)
      let chats = dialogs.map(serializeDialog).filter((c) => !isBlockedDialog(c));

      // Filter by Telegram folder (dialog filter) if requested
      if (opts.folder) {
        const folder = findFolder(await getFolders(client), opts.folder);
        if (!folder) {
          throw new TgError(`Folder not found: ${opts.folder}`, 'FOLDER_NOT_FOUND');
        }
        const ids = new Set([...folder.peerIds].map((id) => normalizeId(id)));
        chats = chats.filter((c) => c.id != null && ids.has(normalizeId(c.id)));
      }

      if (opts.type) {
        chats = chats.filter((c) => c.type === opts.type);
      }

      const total = chats.length;
      outputSuccess({ chats: chats.slice(offset, offset + limit), total });
      return;
    }

    if (opts.type) {
      const { chats, total, hasMore } = await fetchFilteredPage(
        client,
        (c) => c.type === opts.type && !isBlockedDialog(c),
        offset,
        limit,
      );
      outputSuccess({ chats, total, hasMore });
      return;
    }

    // Plain list: one request for offset+limit dialogs; only if blocked chats were
    // hidden and more dialogs exist do we page further to fill the page.
    // total = visible chats seen (the server count would reveal how many are
    // hidden); hasMore tells whether a next page may exist, like with --type.
    const { chats, total, hasMore } = await fetchFilteredPage(
      client,
      (c) => !isBlockedDialog(c),
      offset,
      limit,
      offset + limit,
    );
    outputSuccess({ chats, total, hasMore });
  });
}
