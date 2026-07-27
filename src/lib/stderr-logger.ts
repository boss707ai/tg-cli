import { Logger } from 'telegram/extensions/index.js';

/**
 * gramjs Logger that writes to stderr instead of stdout.
 *
 * The default gramjs Logger emits its connection INFO/WARN lines via
 * `console.log`, which pollutes stdout and breaks the CLI contract that stdout
 * carries ONLY JSON output (a downstream `tg ... | jq` chokes on the log lines).
 * Routing logs to stderr restores that contract — matching how the rest of the
 * CLI already treats stderr as the channel for all non-data output.
 */
class StderrLogger extends Logger {
  log(level: any, message: string): void {
    process.stderr.write(this.format(message, level) + '\n');
  }
}

/** Shared stderr-routing logger instance for all TelegramClient connections. */
export const stderrLogger = new StderrLogger();
