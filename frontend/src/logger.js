const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_PATTERN = /(key|token|secret|authorization|password)/i;

const getThreshold = () => {
  const configured = window.localStorage.getItem('LOG_LEVEL') || 'info';
  return LOG_LEVELS[configured] ?? LOG_LEVELS.info;
};

const redact = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        SENSITIVE_PATTERN.test(key) ? '[REDACTED]' : redact(entryValue),
      ])
    );
  }

  return value;
};

const write = (level, message, context = {}) => {
  if (LOG_LEVELS[level] < getThreshold()) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    context: redact(context),
  };

  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[method]('[frontend]', payload);
};

export const logger = {
  debug: (message, context) => write('debug', message, context),
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),
};
