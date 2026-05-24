import { TelegramClient, Api } from 'telegram';

/**
 * Telegram chat folders (MTProto "dialog filters") via messages.GetDialogFilters.
 * We expose folder id/title and the set of explicitly-included chat ids
 * (pinnedPeers + includePeers) — the common "I put these chats in a folder" case.
 *
 * NOT covered: rule-based folders (contacts/groups/broadcasts/exclude_*), which
 * select chats by predicate rather than an explicit peer list.
 */
export interface FolderInfo {
  id: number;
  title: string;
  /** Shareable "chatlist" folder (DialogFilterChatlist) vs a normal one. */
  shareable: boolean;
  /** Bare ids (userId/chatId/channelId, as strings) of pinned + included peers. */
  peerIds: Set<string>;
}

/** Extract the bare numeric id from an InputPeer variant. */
function inputPeerBareId(p: any): string | null {
  if (p?.userId != null) return p.userId.toString();
  if (p?.chatId != null) return p.chatId.toString();
  if (p?.channelId != null) return p.channelId.toString();
  return null;
}

/** Fetch all chat folders (excluding the implicit "All chats" default). */
export async function getFolders(client: TelegramClient): Promise<FolderInfo[]> {
  const res: any = await client.invoke(new Api.messages.GetDialogFilters());
  // Newer layers wrap in messages.dialogFilters { filters }; older returned a bare array.
  const raw: any[] = Array.isArray(res) ? res : (res?.filters ?? []);
  const folders: FolderInfo[] = [];
  for (const f of raw) {
    if (f.className === 'DialogFilterDefault') continue; // "All chats" — no id/peers
    const title = typeof f.title === 'string' ? f.title : (f.title?.text ?? '');
    const peerIds = new Set<string>();
    for (const p of [...(f.pinnedPeers ?? []), ...(f.includePeers ?? [])]) {
      const id = inputPeerBareId(p);
      if (id) peerIds.add(id);
    }
    folders.push({
      id: f.id,
      title,
      shareable: f.className === 'DialogFilterChatlist',
      peerIds,
    });
  }
  return folders;
}

/** Find a folder by numeric id or by case-insensitive title. */
export function findFolder(folders: FolderInfo[], key: string): FolderInfo | undefined {
  const k = key.trim();
  const kl = k.toLowerCase();
  return folders.find((f) => String(f.id) === k || f.title.toLowerCase() === kl);
}
