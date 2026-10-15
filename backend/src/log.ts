/**
 * Central pino logger — JSON-only output to stdout → journald.
 *
 * No pino-pretty, no per-call string formatting. Levels emitted as strings
 * ("info" / "warn" / "error" / "debug"). Fields pid/hostname suppressed.
 *
 * Format per line (NDJSON):
 *   {"time":<ms>,"level":"info","tag":"<subsystem>","event":"<key>",...,"msg":"<summary>"}
 *
 * See Spec §4.13 Logging-Format & Auswertung.
 */
import { createWriteStream, existsSync } from "node:fs";
import pino from "pino";

export type Logger = pino.Logger;

const baseOptions: pino.LoggerOptions = {
  base: null,                              // suppress pid + hostname
  level: process.env["LOG_LEVEL"] ?? "info",
  formatters: {
    level: (label) => ({ level: label }),  // string instead of numeric
  },
};

/**
 * Diagnostic file sink: journald is unreadable without sudo, so when the marker
 * file /var/lib/xenia/.debug-log exists, mirror the NDJSON log stream to
 * /var/lib/xenia/xenia-app.log (readable by the xenia user). Create/remove the
 * marker + restart to toggle — no unit edit. Default (no marker): stdout only.
 */
const DEBUG_LOG_MARKER = "/var/lib/xenia/.debug-log";
const DEBUG_LOG_FILE = "/var/lib/xenia/xenia-app.log";

function buildRootLogger(): Logger {
  if (!existsSync(DEBUG_LOG_MARKER)) return pino(baseOptions);
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
  try {
    const file = createWriteStream(DEBUG_LOG_FILE, { flags: "a" });
    file.on("error", () => { /* best-effort file logging — never crash on it */ });
    streams.push({ stream: file });
  } catch { /* best-effort */ }
  return pino(baseOptions, pino.multistream(streams));
}

export const rootLogger: Logger = buildRootLogger();

/**
 * Logger for the Xenia HTTP client. Default level "error" — silences the
 * high-volume per-poll request/response chatter (~4/s during brew). Set
 * `DEBUG_XENIA=1` in the environment to enable info-level (and below).
 *
 * Known limitation (§4.13): Xenia-client logs carry no `shot_id`, even when
 * the request happens inside a shot (e.g. scriptStop() from autoCalibrate).
 * Correlation to a shot is via timestamp only.
 */
export function makeXeniaLogger(): Logger {
  const log = rootLogger.child({ tag: "xenia" });
  if (!process.env["DEBUG_XENIA"]) log.level = "error";
  return log;
}
