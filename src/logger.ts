type LogFields = Record<string, unknown>;

function emit(level: string, message: string, fields?: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
  debug: (message: string, fields?: LogFields) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', message, fields);
  },
};
