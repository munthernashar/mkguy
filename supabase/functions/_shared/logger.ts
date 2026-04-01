export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_PATTERN = /(key|token|secret|authorization|password)/i;

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        SENSITIVE_PATTERN.test(key) ? '[REDACTED]' : redact(entryValue),
      ])
    );
  }

  return value;
};

const getThreshold = (): number => {
  const configured = (Deno.env.get('LOG_LEVEL') ?? 'info') as LogLevel;
  return LOG_LEVELS[configured] ?? LOG_LEVELS.info;
};

export const log = (level: LogLevel, message: string, context: Record<string, unknown> = {}) => {
  if (LOG_LEVELS[level] < getThreshold()) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    context: redact(context),
  };

  console.log(JSON.stringify(payload));
};
