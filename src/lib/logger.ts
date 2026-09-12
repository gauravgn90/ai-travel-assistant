type Level = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function currentLevel(): Level {
  const raw = process.env.LOG_LEVEL as Level | undefined;
  return raw && raw in ORDER ? raw : "info";
}

function emit(level: Exclude<Level, "silent">, scope: string, message: string, meta?: unknown) {
  if (ORDER[level] < ORDER[currentLevel()]) return;
  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope}`;
  if (meta === undefined) {
    console[level === "debug" ? "log" : level](`${prefix} ${message}`);
  } else {
    console[level === "debug" ? "log" : level](`${prefix} ${message}`, meta);
  }
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(childScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => emit("debug", scope, message, meta),
    info: (message, meta) => emit("info", scope, message, meta),
    warn: (message, meta) => emit("warn", scope, message, meta),
    error: (message, meta) => emit("error", scope, message, meta),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}
