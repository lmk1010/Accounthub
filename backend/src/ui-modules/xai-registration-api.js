import { getRequestBody } from '../utils/common.js';
import {
    getXaiRegistrationArtifactArchive,
    getXaiRegistrationStatus,
    getXaiRegistrationTask,
    startXaiRegistration,
    stopXaiRegistration
} from '../services/xai-registration.service.js';

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return true;
}

function errorStatus(error, fallback = 400) {
    const status = Number.parseInt(error?.statusCode, 10);
    return Number.isFinite(status) ? status : fallback;
}

export async function handleStartXaiRegistration(req, res) {
    try {
        const body = await getRequestBody(req);
        return sendJson(res, 202, startXaiRegistration(body || {}));
    } catch (error) {
        return sendJson(res, errorStatus(error), {
            success: false,
            error: error.message || 'Failed to start Grok registration'
        });
    }
}

export async function handleGetXaiRegistrationStatus(_req, res) {
    return sendJson(res, 200, getXaiRegistrationStatus());
}

export async function handleStopXaiRegistration(req, res) {
    try {
        const body = await getRequestBody(req);
        return sendJson(res, 200, stopXaiRegistration(body?.taskId || null));
    } catch (error) {
        return sendJson(res, errorStatus(error), {
            success: false,
            error: error.message || 'Failed to stop Grok registration'
        });
    }
}

export async function handleGetXaiRegistrationTask(_req, res, taskId) {
    const task = getXaiRegistrationTask(taskId);
    if (!task) {
        return sendJson(res, 404, {
            success: false,
            error: 'Grok registration task not found'
        });
    }
    return sendJson(res, 200, { success: true, task });
}

export async function handleDownloadXaiRegistrationArtifacts(_req, res, taskId) {
    try {
        const archive = getXaiRegistrationArtifactArchive(taskId);
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${archive.fileName}"`,
            'Content-Length': archive.buffer.length
        });
        res.end(archive.buffer);
        return true;
    } catch (error) {
        return sendJson(res, errorStatus(error, 404), {
            success: false,
            error: error.message || 'Failed to download Grok registration artifacts'
        });
    }
}
