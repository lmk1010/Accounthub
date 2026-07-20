import { writeLogLine } from '../utils/log-writer.js';

let originalConsole = null;

const captureOriginalConsole = () => {
    if (!originalConsole) {
        originalConsole = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error,
            debug: console.debug
        };
    }
    return originalConsole;
};

/**
 * Helper function to broadcast events to UI clients
 * @param {string} eventType - The type of event
 * @param {any} data - The data to broadcast
 */
export function broadcastEventLocal(eventType, data) {
    if (!global.eventClients || global.eventClients.length === 0) {
        return;
    }
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    global.eventClients.forEach(client => {
        client.write(`event: ${eventType}\n`);
        client.write(`data: ${payload}\n\n`);
    });
}

export function broadcastEvent(eventType, data) {
    broadcastEventLocal(eventType, data);

    if (process.send) {
        process.send({
            type: 'broadcast_event',
            eventType,
            data,
            originPid: process.pid
        });
    }
}

/**
 * Server-Sent Events for real-time updates
 */
export async function handleEvents(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    res.write('\n');

    // Store the response object for broadcasting
    if (!global.eventClients) {
        global.eventClients = [];
    }
    global.eventClients.push(res);

    // Keep connection alive
    const keepAlive = setInterval(() => {
        res.write(':\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(keepAlive);
        global.eventClients = global.eventClients.filter(r => r !== res);
    });

    return true;
}

/**
 * Initialize UI management features
 */
export function initializeUIManagement() {
    // Initialize log broadcasting for UI
    if (!global.eventClients) {
        global.eventClients = [];
    }
    if (!global.logBuffer) {
        global.logBuffer = [];
    }

    captureOriginalConsole();
    const createConsoleHandler = (level) => {
        return function(...args) {
            const originals = captureOriginalConsole();
            const fallback = originals?.log || console.log;
            const handler = originals?.[level] || fallback;
            handler.apply(console, args);
            const message = args.map(arg => {
                if (typeof arg === 'string') return arg;
                try {
                    return JSON.stringify(arg);
                } catch (_error) {
                    if (arg instanceof Error) {
                        return `[Error: ${arg.message}] ${arg.stack || ''}`;
                    }
                    return `[Object: ${Object.prototype.toString.call(arg)}] (Circular or too complex to stringify)`;
                }
            }).join(' ');
            const timestamp = new Date().toISOString();
            const logEntry = {
                timestamp,
                level,
                message
            };
            global.logBuffer.push(logEntry);
            if (global.logBuffer.length > 100) {
                global.logBuffer.shift();
            }
            broadcastEvent('log', logEntry);
            writeLogLine(level, message);
        };
    };

    console.log = createConsoleHandler('info');
    console.info = createConsoleHandler('info');
    console.warn = createConsoleHandler('warn');
    console.error = createConsoleHandler('error');
    console.debug = createConsoleHandler('debug');
}

export function logEvent(eventType, data = {}, options = {}) {
    const timestamp = new Date().toISOString();
    const level = (options.level || 'info').toLowerCase();
    const message = options.message || `[${eventType}]`;
    const logEntry = {
        timestamp,
        level,
        message,
        event: eventType,
        data
    };

    if (!global.logBuffer) {
        global.logBuffer = [];
    }
    global.logBuffer.push(logEntry);
    if (global.logBuffer.length > 100) {
        global.logBuffer.shift();
    }

    broadcastEvent('log', logEntry);

    if (options.writeToFile) {
        writeLogLine(level, message, { event: eventType, data });
    }

    if (options.emitConsole) {
        const originals = captureOriginalConsole();
        const handler = originals?.[level] || originals?.log;
        if (handler) {
            handler.call(console, message, data);
        }
    }
}
