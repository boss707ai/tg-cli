import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TgError } from './errors.js';

/**
 * Local read-access blocklist (privacy guard).
 *
 * File: $TG_BLOCKLIST or ~/.config/tg-cli/blocked-chats.txt
 * One entry per line; `#` comments and blank lines ignored.
 * Entry forms:
 *   123456789        — chat/user numeric id (marked -100.. and bare both match)
 *   @username        — username (also matches collectible usernames[])
 *   type:private     — block ALL private (1:1 user) chats at once
 *
 * Enforced at the peer-resolution chokepoint (peer.ts:resolveEntity) so EVERY
 * command that targets a chat is covered, plus filtered out of `chat list` and
 * out of global `message search` results (isBlockedPeer — no chat is resolved there).
 * People closed explicitly (id / @username, not `type:private`) are also hidden
 * from the contacts directory (isExplicitlyBlockedEntity).
 */

const BLOCKLIST_PATH =
  process.env.TG_BLOCKLIST ?? join(homedir(), '.config', 'tg-cli', 'blocked-chats.txt');

interface Blocklist {
  ids: Set<string>;
  usernames: Set<string>;
  blockAllPrivate: boolean;
}

let cache: Blocklist | null = null;

/** Strip Telegram id markings so marked (-100.., -..) and bare ids compare equal. */
export function normalizeId(raw: string | number | bigint): string {
  let s = String(raw).trim();
  if (s.startsWith('-100')) s = s.slice(4);
  else if (s.startsWith('-')) s = s.slice(1);
  return s;
}

/** Load and cache the blocklist for the lifetime of the process. */
export function loadBlocklist(): Blocklist {
  if (cache) return cache;
  const bl: Blocklist = { ids: new Set(), usernames: new Set(), blockAllPrivate: false };
  if (existsSync(BLOCKLIST_PATH)) {
    for (const rawLine of readFileSync(BLOCKLIST_PATH, 'utf-8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.toLowerCase() === 'type:private' || line.toLowerCase() === 'type:user') {
        bl.blockAllPrivate = true;
      } else if (line.startsWith('@')) {
        bl.usernames.add(line.slice(1).toLowerCase());
      } else if (/^-?\d+$/.test(line)) {
        bl.ids.add(normalizeId(line));
      } else {
        bl.usernames.add(line.toLowerCase());
      }
    }
  }
  return (cache = bl);
}

/** Match a raw user input string (numeric id or @username) against the blocklist. */
export function isBlockedInput(input: string): boolean {
  const bl = loadBlocklist();
  const t = input.trim();
  if (/^-?\d+$/.test(t)) return bl.ids.has(normalizeId(t));
  const u = (t.startsWith('@') ? t.slice(1) : t).toLowerCase();
  return bl.usernames.has(u);
}

/**
 * Match an entity against EXPLICIT entries only (numeric id or @username),
 * ignoring `type:private`. Used for the contacts directory (`contact list`,
 * `contact search`, `user blocked`): a person closed by name or id disappears
 * from it, while `type:private` closes only the conversations — applying it
 * there would empty the contact list.
 */
export function isExplicitlyBlockedEntity(entity: any): boolean {
  const bl = loadBlocklist();
  if (entity?.id != null && bl.ids.has(normalizeId(entity.id.toString()))) return true;
  return hasBlockedUsername(bl, entity);
}

/**
 * Does any public username of the entity match a @username entry? Checks the
 * main `username` and the collectible (Fragment) ones in `usernames[]` — active
 * or not — where `username` may be empty.
 */
function hasBlockedUsername(
  bl: Blocklist,
  entity: { username?: unknown; usernames?: unknown } | null | undefined,
): boolean {
  const uname = entity?.username;
  if (uname && bl.usernames.has(String(uname).toLowerCase())) return true;
  const extra = Array.isArray(entity?.usernames) ? entity.usernames : [];
  return extra.some((u: any) => {
    const name = typeof u === 'string' ? u : u?.username;
    return !!name && bl.usernames.has(String(name).toLowerCase());
  });
}

/** Match a resolved gramjs entity (User/Chat/Channel) against the blocklist. */
export function isBlockedEntity(entity: any): boolean {
  const bl = loadBlocklist();
  if (isExplicitlyBlockedEntity(entity)) return true;
  if (bl.blockAllPrivate && entity?.className === 'User') return true;
  return false;
}

/**
 * Refuse a chat entity that Telegram returned without resolveEntity (e.g. from
 * CheckChatInvite) when it is on the blocklist: throws the same CHAT_BLOCKED
 * error as the resolveEntity guard. A missing entity passes.
 */
export function assertChatNotBlocked(entity: any): void {
  if (entity && isBlockedEntity(entity)) {
    throw new TgError('Chat is blocked by local read-access policy (blocked-chats.txt)', 'CHAT_BLOCKED');
  }
}

/**
 * Match the chat a message belongs to (peerId + optional chat entity) against the
 * blocklist. Used where messages arrive without peer resolution — global search.
 */
export function isBlockedPeer(peerId: any, chatEntity?: any): boolean {
  const bl = loadBlocklist();
  if (chatEntity && isBlockedEntity(chatEntity)) return true;
  const raw = peerId?.channelId ?? peerId?.chatId ?? peerId?.userId;
  if (raw != null && bl.ids.has(normalizeId(raw.toString()))) return true;
  const isPrivate = peerId?.userId != null && peerId?.channelId == null && peerId?.chatId == null;
  if (bl.blockAllPrivate && isPrivate) return true;
  return false;
}

/**
 * Match a serialized dialog ({ id, type, username }) for `chat list` filtering.
 * `usernames` carries the entity's collectible usernames (not part of the output).
 */
export function isBlockedDialog(c: {
  id?: string;
  type?: string;
  username?: string | null;
  usernames?: ReadonlyArray<string | { username?: string }> | null;
}): boolean {
  const bl = loadBlocklist();
  if (c.id != null && bl.ids.has(normalizeId(c.id))) return true;
  if (hasBlockedUsername(bl, c)) return true;
  if (bl.blockAllPrivate && c.type === 'user') return true;
  return false;
}
