export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface Logger {
  error(event: string, metadata?: Record<string, unknown>): void;
  warn(event: string, metadata?: Record<string, unknown>): void;
  info(event: string, metadata?: Record<string, unknown>): void;
  debug(event: string, metadata?: Record<string, unknown>): void;
  trace(event: string, metadata?: Record<string, unknown>): void;
}

export interface StructuredLoggerOptions {
  level: LogLevel;
  sink?: (line: string) => void;
  now?: () => Date;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const SENSITIVE_KEY = /^(authorization|headers?|api[-_]?key|password|secret|prompt|payload|fullRenderedContext)$/i;

function sanitizeString(value: string): string {
  return value
    .replace(/\[ds4:local-only\][\s\S]*?\[\/ds4:local-only\]/giu, "[redacted local-only]")
    .replace(/\[ds4:local-only\][\s\S]*/giu, "[redacted local-only]")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu, "[redacted private key]")
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16})\b/gu, "[redacted credential]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, "$1[redacted token]");
}

function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (depth >= 4) return "[max-depth]";

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  }

  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(child, depth + 1);
    }
    return sanitized;
  }

  return String(value);
}

export class StructuredLogger implements Logger {
  private readonly sink: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly options: StructuredLoggerOptions) {
    this.sink = options.sink ?? ((line) => console.error(line));
    this.now = options.now ?? (() => new Date());
  }

  error(event: string, metadata?: Record<string, unknown>): void {
    this.write("error", event, metadata);
  }

  warn(event: string, metadata?: Record<string, unknown>): void {
    this.write("warn", event, metadata);
  }

  info(event: string, metadata?: Record<string, unknown>): void {
    this.write("info", event, metadata);
  }

  debug(event: string, metadata?: Record<string, unknown>): void {
    this.write("debug", event, metadata);
  }

  trace(event: string, metadata?: Record<string, unknown>): void {
    this.write("trace", event, metadata);
  }

  private write(level: LogLevel, event: string, metadata?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[this.options.level]) return;

    this.sink(
      JSON.stringify({
        timestamp: this.now().toISOString(),
        component: "ds4-context-engine",
        level,
        event,
        ...(metadata ? { metadata: sanitize(metadata) } : {}),
      }),
    );
  }
}

export const silentLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};
