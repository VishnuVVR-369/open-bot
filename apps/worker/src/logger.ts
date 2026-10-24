export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Structured, single-line JSON logs. */
export function createLogger(scope = "worker"): Logger {
  const write = (level: string, message: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      scope,
      message,
      ...fields,
    });
    (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
