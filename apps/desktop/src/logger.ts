import electron from "electron";
const { app, shell } = electron || {};
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogScope =
  | "app"
  | "ipc"
  | "lease"
  | "pet.default"
  | "pet.agent"
  | "pet.window"
  | "pet.wayland"
  | "pet.chat"
  | "pet.session"
  | "pet.pinned"
  | "pet.install"
  | "pet.wardrobe"
  | "pet.activities"
  | "plugin"
  | "state"
  | "tray"
  | "ui"
  | "remote"
  | "teams"
  | "terminal-focus"
  | "window-tracker"
  | "capabilities"
  | "capture"
  | "voice"
  | "provider";

type LogFields = Record<string, unknown>;

const levelPriority = { debug: 10, info: 20, warn: 30, error: 40 } as const satisfies Record<LogLevel, number>;
const maxLogBytes = 2 * 1024 * 1024;
const maxLineBytes = 64 * 1024;

const configuredLevel: LogLevel = normalizeLogLevel(process.env.OPENPETS_LOG_LEVEL) ?? (isDevRun() ? "debug" : "info");
let logFilePath: string | null = null;
let previousLogFilePath: string | null = null;
const mirrorToConsole = isDevRun() || process.env.OPENPETS_LOG_CONSOLE === "1";
let currentLogBytes = 0;
let pendingBytes = 0;
let droppedLines = 0;
let writeQueue: Promise<void> = Promise.resolve();

export function initializeLogger(): void {
  if (logFilePath) return;
  try {
    const logsDir = getLogsDir();
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(logsDir).isDirectory()) throw new Error("Log directory must be a real directory.");
    if (process.platform !== "win32") chmodSync(logsDir, 0o700);
    logFilePath = join(logsDir, "openpets.log");
    previousLogFilePath = join(logsDir, "openpets.previous.log");
    for (const name of ["openpets.log", "openpets.previous.log", "openpets.previous.old.log"]) {
      boundExistingLog(join(logsDir, name));
    }
    rotateCurrentLog(logFilePath, previousLogFilePath);
    const file = openSync(logFilePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const metadata = fstatSync(file);
      if (!metadata.isFile()) throw new Error("Log file must be a regular file.");
      if (process.platform !== "win32") fchmodSync(file, 0o600);
      currentLogBytes = metadata.size;
    } finally {
      closeSync(file);
    }
    info("app", "logger initialized", { logFile: logFilePath, previousLogFile: previousLogFilePath, level: configuredLevel, console: mirrorToConsole });
  } catch (initError: unknown) {
    const message = initError instanceof Error ? initError.message : String(initError);
    logFilePath = null;
    previousLogFilePath = null;
    console.error("OpenPets file logger unavailable; continuing without log file.", redactLogText(message));
  }
}

export function getLogsDir(): string {
  return join(app.getPath("userData"), "logs");
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

export async function openLogsFolder(): Promise<void> {
  try {
    mkdirSync(getLogsDir(), { recursive: true, mode: 0o700 });
    await shell.openPath(getLogsDir());
  } catch (openError: unknown) {
    error("app", "open logs folder failed", openError);
  }
}

export function debug(scope: LogScope, message: string, fields?: LogFields): void {
  writeLog("debug", scope, message, fields);
}

export function info(scope: LogScope, message: string, fields?: LogFields): void {
  writeLog("info", scope, message, fields);
}

export function warn(scope: LogScope, message: string, fields?: LogFields): void {
  writeLog("warn", scope, message, fields);
}

export function error(scope: LogScope, message: string, errorOrFields?: unknown, fields?: LogFields): void {
  const normalized = errorOrFields instanceof Error ? { ...fields, error: formatError(errorOrFields) } : { ...(isRecord(errorOrFields) ? errorOrFields : { error: errorOrFields }), ...fields };
  writeLog("error", scope, message, normalized);
}

/** Redact bearer tokens and remote endpoints before they reach any log sink. */
export function redactLogText(value: string): string {
  return value
    .replace(/\btcp:\/\/(?:\[[^\]\s]+\]|[A-Za-z0-9._:-]+):\d{1,5}\b/gi, "[redacted-endpoint]")
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, "[redacted-token]")
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/g, "[redacted-token]")
    .replace(/[A-Za-z0-9+/=]{40,}/g, "[redacted-token]");
}

function writeLog(level: LogLevel, scope: LogScope, message: string, fields: LogFields | undefined): void {
  if (levelPriority[level] < levelPriority[configuredLevel]) return;
  let line: string;
  try {
    line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope.padEnd(12)} ${redact(message)}${formatFields(fields)}\n`;
  } catch (formatError) {
    line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope.padEnd(12)} ${redact(message)} logFormatError=${JSON.stringify(redactLogText(formatError instanceof Error ? formatError.message : String(formatError)))}\n`;
  }
  line = boundLine(line);

  if (mirrorToConsole) {
    try {
      const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      writer(line.trimEnd());
    } catch {
      // Logging must never affect app behavior.
    }
  }

  enqueueLine(line);
}

/** Drain accepted diagnostics before the app finishes its shutdown lifecycle. */
export async function flushLogs(): Promise<void> {
  await writeQueue;
  if (droppedLines > 0 && logFilePath) {
    const count = droppedLines;
    droppedLines = 0;
    enqueueLine(`${new Date().toISOString()} WARN  app          log backlog limited; droppedLines=${count}\n`);
    await writeQueue;
  }
}

function enqueueLine(line: string): void {
  const currentPath = logFilePath;
  const previousPath = previousLogFilePath;
  if (!currentPath || !previousPath) return;
  const bytes = Buffer.byteLength(line);
  if (pendingBytes + bytes > maxLogBytes) {
    droppedLines += 1;
    return;
  }
  pendingBytes += bytes;
  writeQueue = writeQueue.then(async () => {
    if (!logFilePath) return;
    if (currentLogBytes + bytes > maxLogBytes) {
      const oldPath = join(dirname(previousPath), "openpets.previous.old.log");
      await rm(oldPath, { force: true });
      if (existsSync(previousPath)) await rename(previousPath, oldPath);
      await rename(currentPath, previousPath);
      await writeFile(currentPath, "", { mode: 0o600 });
      currentLogBytes = 0;
    }
    const metadata = await lstat(currentPath);
    if (!metadata.isFile()) throw new Error("Log file must be a regular file.");
    const file = await open(currentPath, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) throw new Error("Log file changed before append.");
      await file.appendFile(line, "utf8");
    } finally {
      await file.close();
    }
    currentLogBytes += bytes;
  }).catch((appendError: unknown) => {
    logFilePath = null;
    previousLogFilePath = null;
    console.error("OpenPets file logger unavailable; continuing without log file.", redactLogText(String(appendError)));
  }).finally(() => {
    pendingBytes -= bytes;
  });
}

function boundLine(line: string): string {
  const bytes = Buffer.from(line);
  if (bytes.length <= maxLineBytes) return line;
  return `${bytes.subarray(0, maxLineBytes - 64).toString("utf8")} [log line truncated]\n`;
}

function boundExistingLog(path: string): void {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isFile()) throw new Error("Log file must be a regular file.");
  const size = metadata.size;
  if (size > maxLogBytes) {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const tail = Buffer.alloc(maxLogBytes);
    let bytesRead: number;
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) throw new Error("Log file changed before truncation.");
      bytesRead = readSync(fd, tail, 0, tail.length, size - tail.length);
    } finally {
      closeSync(fd);
    }
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, tail.subarray(0, bytesRead), { flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  if (process.platform !== "win32") {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Log file must be a regular file.");
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  }
}

function rotateCurrentLog(currentPath: string, previousPath: string): void {
  if (!existsSync(currentPath)) return;
  try {
    const current = statSync(currentPath);
    if (current.size <= 0) return;
    if (existsSync(previousPath)) {
      const oldPath = join(dirname(previousPath), "openpets.previous.old.log");
      rmSync(oldPath, { force: true });
      renameSync(previousPath, oldPath);
    }
    renameSync(currentPath, previousPath);
  } catch (rotationError: unknown) {
    if (mirrorToConsole) console.error("Failed to rotate OpenPets log file.", rotationError instanceof Error ? formatError(rotationError) : redactLogText(String(rotationError)));
  }
}

function normalizeLogLevel(value: string | undefined): LogLevel | null {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return null;
}

function isDevRun(): boolean {
  return process.env.OPENPETS_DEV === "1" || process.env.NODE_ENV === "development" || app?.isPackaged === false;
}

function formatFields(fields: LogFields | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  return ` ${Object.entries(fields).slice(0, 30).filter(([, value]) => value !== undefined).map(([key, value]) => `${redact(key)}=${isSensitiveKey(key) ? '"[redacted]"' : formatValue(value)}`).join(" ")}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(redact(value));
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Error) return JSON.stringify(formatError(value));
  return JSON.stringify(sanitize(value));
}

function sanitize(value: unknown, depth = 0, budget = { remaining: 200, seen: new WeakSet<object>() }): unknown {
  if (budget.remaining-- <= 0 || depth > 6) return "[log structure truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Error) return formatError(value);
  if (typeof value === "object") {
    if (budget.seen.has(value)) return "[repeated log value]";
    budget.seen.add(value);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1, budget));
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 30)) {
      output[redact(key)] = isSensitiveKey(key) ? "[redacted]" : sanitize(nested, depth + 1, budget);
    }
    return output;
  }
  return String(value);
}

function formatError(error: Error): { readonly name: string; readonly message: string; readonly stack?: string } {
  return { name: error.name, message: redact(error.message), stack: error.stack ? redact(error.stack) : undefined };
}

function redact(value: string): string {
  const maxCharacters = 16 * 1024;
  const truncated = value.length > maxCharacters;
  // Include bounded lookahead so a credential crossing the truncation boundary
  // is redacted before its remaining prefix can be emitted.
  const sanitized = redactLogText(value.slice(0, maxCharacters + 256));
  return sanitized.slice(0, maxCharacters) + (truncated ? " [log value truncated]" : "");
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|credential|api[-_]?key/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
