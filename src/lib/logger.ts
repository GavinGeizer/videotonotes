import { randomUUID } from "crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogMeta = Record<string, unknown>;

export type Logger = {
  debug: (message: string, meta?: LogMeta) => void;
  info: (message: string, meta?: LogMeta) => void;
  warn: (message: string, meta?: LogMeta) => void;
  error: (message: string, meta?: LogMeta) => void;
  child: (meta: LogMeta) => Logger;
};

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL: LogLevel = "info";

const resolveLevel = (): LogLevel => {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return DEFAULT_LEVEL;
};

const shouldLog = (level: LogLevel, threshold: LogLevel) =>
  levelOrder[level] >= levelOrder[threshold];

const resolveConsoleMethod = (level: LogLevel) => {
  if (level === "debug") return console.log;
  return console[level];
};

const nowIso = () => new Date().toISOString();

export const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    };
  }
  return { message: String(error) };
};

export const createRequestId = () => {
  try {
    return randomUUID();
  } catch {
    return `req_${Math.random().toString(36).slice(2, 10)}`;
  }
};

export function createLogger(options: { scope: string; requestId?: string; baseMeta?: LogMeta }): Logger {
  const levelThreshold = resolveLevel();
  const baseMeta: LogMeta = {
    scope: options.scope,
    requestId: options.requestId,
    ...options.baseMeta,
  };

  const log = (level: LogLevel, message: string, meta?: LogMeta) => {
    if (!shouldLog(level, levelThreshold)) return;
    const payload = {
      timestamp: nowIso(),
      level,
      message,
      ...baseMeta,
      ...meta,
    };
    resolveConsoleMethod(level)(payload);
  };

  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
    child: (meta) =>
      createLogger({
        scope: options.scope,
        requestId: options.requestId,
        baseMeta: { ...baseMeta, ...meta },
      }),
  };
}
