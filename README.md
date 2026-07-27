# @miolamio/tg-cli

Agent-first Telegram CLI client built on MTProto. Designed for Claude Code agents and power users who need structured, scriptable access to Telegram.

> This is a fork of [miolamio/tg-cli](https://github.com/miolamio/tg-cli) with additions on top of upstream:
>
> - `tg message click <chat> <msg-id>` — press inline bot buttons (`--text` / `--data` / `--row --col`); messages expose a `buttons` field (with `callback_data`/URLs) via `--fields ...,buttons`
> - `tg chat similar [channel]` — Telegram's "similar channels" recommendations (omit the argument for personal ones)
> - `tg chat folders` + `tg chat list --folder <id|title>` — Telegram dialog folders; `tg chat list --archived` — the system Archive
> - `tg chat list` items carry `lastMessageDate` (unix) — signal of how alive a chat is
> - `tg message send --html` — HTML parse mode for inline `<a href>` links
> - Local read-access blocklist (privacy guard): chats listed in `$TG_BLOCKLIST` or `~/.config/tg-cli/blocked-chats.txt` are excluded from any read
> - `tg media send --voice` generates a real waveform (ffmpeg), so voice notes render with an equalizer
> - gramjs connection logs go to stderr — stdout stays pure JSON (`tg ... | jq` safe)
> - Bare numeric chat IDs resolve reliably in fresh processes (entity-cache warm-up + retry)

## Install

From this fork (builds from source via the `prepare` script):

```bash
npm install -g github:boss707ai/tg-cli
```

Requires Node.js >= 20. The upstream npm package (`npm install -g @miolamio/tg-cli`) does not include the additions listed above. Voice-note waveform generation additionally needs `ffmpeg`/`ffprobe` on PATH.

## Setup

You need Telegram API credentials from [my.telegram.org](https://my.telegram.org):

```bash
export TG_API_ID=your_api_id
export TG_API_HASH=your_api_hash
```

Or save them to `~/.config/telegram-cli/config.json`:

```json
{
  "api_id": "your_api_id",
  "api_hash": "your_api_hash"
}
```

Then log in:

```bash
tg auth login
```

## Commands

### Auth & Session

```bash
tg auth login              # Interactive login (phone + code + 2FA)
tg auth status             # Check auth status
tg auth logout             # Log out and destroy session
tg session export          # Export session string for portability
tg session import <string> # Import session string
```

### Chats

```bash
tg chat list [--limit N] [--type group|channel|user] [--folder ID|TITLE] [--archived]
tg chat folders                          # List Telegram dialog folders
tg chat similar [channel]                # Similar-channel recommendations
tg chat info <chat>
tg chat join <username-or-invite-link>
tg chat leave <chat>
tg chat resolve <username-or-id>
tg chat invite-info <link>
tg chat members <chat> [--limit N] [--offset N]
tg chat topics <chat> [--limit N]
tg chat search <query> [--limit N]       # Search public channels/groups globally
```

### Messages

```bash
# Read
tg message history <chat> [--limit N] [--since DATE] [--until DATE]
tg message search [--chat CHAT] [--query TEXT] [--filter photos|videos|...]
tg message get <chat> <id1,id2,...>
tg message pinned <chat>
tg message replies <channel> <msg-ids>

# Write
tg message send <chat> <text> [--reply-to ID] [--markdown] [--html]
tg message click <chat> <msg-id> --text LABEL|--data CALLBACK|--row N --col N
tg message edit <chat> <msg-id> <text>
tg message delete <chat> <ids> --revoke|--for-me
tg message forward <from-chat> <msg-ids> <to-chat>
tg message react <chat> <msg-id> <emoji> [--remove]
tg message pin <chat> <msg-id> [--notify]
tg message unpin <chat> <msg-id>
tg message poll <chat> --question <q> --option <o1> --option <o2> [--quiz --correct N]
```

### Media

```bash
tg media download <chat> <msg-ids> [--output DIR]
tg media send <chat> <files...> [--caption TEXT] [--album] [--voice]
```

### Users

```bash
tg user profile <users>      # Bio, photos, last seen, common chats
tg user block <user>
tg user unblock <user>
tg user blocked [--limit N]  # List blocked users
```

### Contacts

```bash
tg contact list [--limit N]
tg contact add <username-or-phone> [--first NAME] [--last NAME]
tg contact delete <user>
tg contact search <query> [--limit N] [--global]
```

## Output Modes

Every command supports structured output:

```bash
tg chat list                    # JSON (default)
tg chat list --human            # Human-readable table
tg chat list --jsonl            # One JSON object per line (streaming)
tg chat list --toon             # TOON format (30-40% fewer tokens for LLMs)
tg chat list --fields id,title  # Select specific fields
```

JSON envelope format:

```json
{
  "ok": true,
  "data": { ... }
}
```

## Agent Usage

Designed for non-interactive automation. Export a session once, then reuse:

```bash
# Initial setup (interactive)
tg auth login
SESSION=$(tg session export)

# Reuse in scripts / agents
echo "$SESSION" | tg session import
tg message search --query "meeting notes" --limit 10
tg chat list --fields id,title,unreadCount --jsonl
```

Pipe message text via stdin:

```bash
echo "Hello from the CLI" | tg message send mychat -
```

## Development

```bash
git clone https://github.com/boss707ai/tg-cli.git
cd tg-cli
npm install
npm run build
npm test
```

## License

MIT
