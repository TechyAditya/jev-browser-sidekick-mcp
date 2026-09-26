/** Protocol-safe logger. MCP stdio uses stdout, so everything goes to stderr. */

export const log = {
  info(message: string, extra?: unknown): void {
    write("info", message, extra);
  },
  warn(message: string, extra?: unknown): void {
    write("warn", message, extra);
  },
  error(message: string, extra?: unknown): void {
    write("error", message, extra);
  },
};

const write = (level: string, message: string, extra?: unknown): void => {
  const line =
    extra === undefined ? message : `${message} ${safeJson(extra)}`;
  process.stderr.write(`[jev ${level}] ${line}\n`);
};

export const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, redact, 0);
  } catch {
    return String(value);
  }
};

const SECRET = /key|token|secret|authorization|password/i;

const redact = (key: string, value: unknown): unknown => {
  if (SECRET.test(key) && typeof value === "string" && value.length > 0) {
    return `${value.slice(0, 4)}…${value.slice(-3)}`;
  }
  return value;
};
