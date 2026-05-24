import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local read-access blocklist (privacy guard).
 *
 * File: $TG_BLOCKLIST or ~/.config/tg-cli/blocked-chats.txt
 * One entry per line; `#` comments and blank lines ignored.
 * Entry forms:
 *   123456789        — chat/user numeric id (marked -100.. and bare both match)
 *   @username        — username
 *   type:private     — block ALL private (1:1 user) chats at once
 *
 * Enforced at the peer-resolution chokepoint (peer.ts:resolveEntity) so EVERY
 * command that targets a chat is covered, plus filtered out of `chat list`.
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

/** Match a resolved gramjs entity (User/Chat/Channel) against the blocklist. */
export function isBlockedEntity(entity: any): boolean {
  const bl = loadBlocklist();
  if (entity?.id != null && bl.ids.has(normalizeId(entity.id.toString()))) return true;
  const uname = entity?.username;
  if (uname && bl.usernames.has(String(uname).toLowerCase())) return true;
  if (bl.blockAllPrivate && entity?.className === 'User') return true;
  return false;
}

/** Match a serialized dialog ({ id, type, username }) for `chat list` filtering. */
export function isBlockedDialog(c: { id?: string; type?: string; username?: string | null }): boolean {
  const bl = loadBlocklist();
  if (c.id != null && bl.ids.has(normalizeId(c.id))) return true;
  if (c.username && bl.usernames.has(String(c.username).toLowerCase())) return true;
  if (bl.blockAllPrivate && c.type === 'user') return true;
  return false;
}
