const PREFIX = '[Windsurf]';
export const log = {
    debug: (...args) => console.log(`${PREFIX}[DEBUG]`, ...args),
    info:  (...args) => console.log(`${PREFIX}[INFO]`,  ...args),
    warn:  (...args) => console.warn(`${PREFIX}[WARN]`,  ...args),
    error: (...args) => console.error(`${PREFIX}[ERROR]`, ...args),
};
