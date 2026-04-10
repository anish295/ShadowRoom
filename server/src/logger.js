export function createLogger() {
  const base = (level, msg, meta) => {
    const time = new Date().toISOString();
    const payload = meta ? ` ${JSON.stringify(meta)}` : "";
    // eslint-disable-next-line no-console
    console.log(`[${time}] ${level.toUpperCase()} ${msg}${payload}`);
  };

  return {
    info: (msg, meta) => base("info", msg, meta),
    warn: (msg, meta) => base("warn", msg, meta),
    error: (msg, meta) => base("error", msg, meta),
  };
}

