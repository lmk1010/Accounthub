/**
 * Logs routes
 */
import fs from 'fs';
import { sendJson, sendError } from './index.js';
import { handleEvents } from '../ui-modules/event-broadcast.js';
import * as logsService from '../services/logs.service.js';
import * as appMetaDao from '../dao/app-meta-dao.js';

const DEBUG_TOOL_USE_KEY = 'debug_tool_use';

export async function logsRouter(method, path, req, res) {
    if (method === 'GET' && path === '/api/logs/days') {
        return await handleLogDays(req, res);
    }

    if (method === 'GET' && path === '/api/logs/entries') {
        return await handleLogEntries(req, res);
    }

    if (method === 'GET' && path === '/api/logs/recent') {
        return await handleLogBuffer(req, res);
    }

    if (method === 'GET' && path === '/api/logs/stream') {
        return await handleEvents(req, res);
    }

    if (method === 'GET' && path === '/api/logs/download') {
        return await handleLogDownload(req, res);
    }

    if (method === 'GET' && path === '/api/logs/search') {
        return await handleLogSearch(req, res);
    }

    if (method === 'GET' && path === '/api/logs/debug-config') {
        return await handleGetDebugConfig(req, res);
    }

    if (method === 'POST' && path === '/api/logs/debug-config') {
        return await handleSetDebugConfig(req, res);
    }

    if (method === 'DELETE' && path === '/api/logs/delete') {
        return await handleLogDelete(req, res);
    }

    if (method === 'POST' && path === '/api/logs/gzip') {
        return await handleLogGzip(req, res);
    }

    if (method === 'POST' && path === '/api/logs/gzip-all') {
        return await handleLogGzipAll(req, res);
    }

    if (method === 'DELETE' && path === '/api/logs/cleanup') {
        return await handleLogCleanup(req, res);
    }

    return false;
}

async function handleLogDays(req, res) {
    try {
        const data = await logsService.listLogDays();
        sendJson(res, 200, { success: true, data });
    } catch (error) {
        console.error('[Logs] Failed to list log days:', error.message);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleLogEntries(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const file = url.searchParams.get('file');
        const page = Number(url.searchParams.get('page') || 1);
        const pageSize = Number(url.searchParams.get('pageSize') || 200);
        const direction = url.searchParams.get('direction') || 'desc';

        const data = await logsService.readLogEntries(file, { page, pageSize, direction });
        sendJson(res, 200, { success: true, data: { file, ...data } });
    } catch (error) {
        console.error('[Logs] Failed to read log entries:', error.message);
        if (error.code === 'ENOENT') {
            sendError(res, 404, 'Log file not found', 'NOT_FOUND');
        } else {
            sendError(res, 500, error.message, 'SERVER_ERROR');
        }
    }
    return true;
}

async function handleLogBuffer(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = Number(url.searchParams.get('limit') || 200);
        const entries = await logsService.getLogBuffer(limit);
        sendJson(res, 200, { success: true, data: { entries } });
    } catch (error) {
        console.error('[Logs] Failed to read log buffer:', error.message);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleLogDownload(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const file = url.searchParams.get('file');
        if (!file) {
            sendError(res, 400, 'Missing file parameter', 'BAD_REQUEST');
            return true;
        }

        const fileInfo = await logsService.getLogFileInfo(file);

        res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileInfo.name)}"`,
            'Content-Length': fileInfo.size
        });

        const stream = fs.createReadStream(fileInfo.path);
        stream.pipe(res);
        stream.on('error', (err) => {
            console.error('[Logs] Download stream error:', err.message);
            if (!res.headersSent) {
                sendError(res, 500, err.message, 'SERVER_ERROR');
            }
        });
    } catch (error) {
        console.error('[Logs] Failed to download log file:', error.message);
        if (error.code === 'ENOENT') {
            sendError(res, 404, 'Log file not found', 'NOT_FOUND');
        } else {
            sendError(res, 500, error.message, 'SERVER_ERROR');
        }
    }
    return true;
}

async function handleLogSearch(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const file = url.searchParams.get('file');
        const keyword = url.searchParams.get('keyword');
        const limit = Number(url.searchParams.get('limit') || 200);
        const context = Number(url.searchParams.get('context') || 0);
        const caseSensitive = url.searchParams.get('caseSensitive') === 'true';

        if (!file) {
            sendError(res, 400, 'Missing file parameter', 'BAD_REQUEST');
            return true;
        }
        if (!keyword) {
            sendError(res, 400, 'Missing keyword parameter', 'BAD_REQUEST');
            return true;
        }

        const data = await logsService.searchLogEntries(file, keyword, { limit, context, caseSensitive });
        sendJson(res, 200, { success: true, data });
    } catch (error) {
        console.error('[Logs] Failed to search log file:', error.message);
        if (error.code === 'ENOENT') {
            sendError(res, 404, 'Log file not found', 'NOT_FOUND');
        } else {
            sendError(res, 500, error.message, 'SERVER_ERROR');
        }
    }
    return true;
}

async function handleGetDebugConfig(req, res) {
    try {
        const value = await appMetaDao.getValue(DEBUG_TOOL_USE_KEY);
        const debugToolUse = value === 'true';
        global.DEBUG_TOOL_USE = debugToolUse;
        sendJson(res, 200, {
            success: true,
            data: { debugToolUse }
        });
    } catch (error) {
        console.error('[Logs] Failed to get debug config:', error.message);
        sendJson(res, 200, {
            success: true,
            data: { debugToolUse: global.DEBUG_TOOL_USE === true }
        });
    }
    return true;
}

async function handleSetDebugConfig(req, res) {
    try {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }
        const data = JSON.parse(body);
        const debugToolUse = data.debugToolUse === true;

        await appMetaDao.setValue(DEBUG_TOOL_USE_KEY, String(debugToolUse));
        global.DEBUG_TOOL_USE = debugToolUse;

        console.log(`[Logs] DEBUG_TOOL_USE set to: ${debugToolUse} (persisted)`);
        sendJson(res, 200, {
            success: true,
            data: { debugToolUse }
        });
    } catch (error) {
        console.error('[Logs] Failed to set debug config:', error.message);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleLogDelete(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const file = url.searchParams.get('file');

        if (!file) {
            sendError(res, 400, 'Missing file parameter', 'BAD_REQUEST');
            return true;
        }

        await logsService.deleteLogFile(file);
        console.log(`[Logs] Deleted log file: ${file}`);
        sendJson(res, 200, { success: true, message: 'Log file deleted successfully' });
    } catch (error) {
        console.error('[Logs] Failed to delete log file:', error.message);
        if (error.code === 'ENOENT') {
            sendError(res, 404, 'Log file not found', 'NOT_FOUND');
        } else {
            sendError(res, 500, error.message, 'SERVER_ERROR');
        }
    }
    return true;
}

async function handleLogGzip(req, res) {
    try {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }
        const data = body ? JSON.parse(body) : {};
        const file = data.file;
        if (!file) {
            sendError(res, 400, 'Missing file parameter', 'BAD_REQUEST');
            return true;
        }
        const result = await logsService.gzipLogFile(file);
        sendJson(res, 200, { success: true, data: result });
    } catch (error) {
        console.error('[Logs] Failed to gzip log file:', error.message);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleLogGzipAll(req, res) {
    try {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }
        const data = body ? JSON.parse(body) : {};
        const keepDays = data.keepDays;
        const result = await logsService.gzipLogFiles({ keepDays });
        sendJson(res, 200, { success: true, data: result });
    } catch (error) {
        console.error('[Logs] Failed to gzip log files:', error.message);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleLogCleanup(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const days = Number(url.searchParams.get('days') || 7);
        const result = await logsService.deleteLogFilesOlderThan(days);
        sendJson(res, 200, { success: true, data: result });
    } catch (error) {
        console.error('[Logs] Failed to cleanup log files:', error.message);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}
