import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { importXaiCredentials } from '../auth/xai-oauth.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SERVICE_DIR, '../..');
const REPOSITORY_ROOT = path.resolve(BACKEND_ROOT, '..');
const BUNDLED_REGISTER_ENGINE = path.join(BACKEND_ROOT, 'src/vendor/xai-registration-engine');
const BUNDLED_CONVERTER_SCRIPT = path.join(
    BACKEND_ROOT,
    'src/vendor/xai-registration-converter/sso_to_auth_json.py'
);
const DEVELOPMENT_REGISTER_ENGINE = path.join(REPOSITORY_ROOT, 'demo/grok_reg-protocol_cpa');
const DEVELOPMENT_CONVERTER_SCRIPT = path.join(
    REPOSITORY_ROOT,
    'demo/grokRegister-cpa-main/sso_to_auth_json.py'
);
const DEFAULT_REGISTER_ENGINE = process.env.XAI_REGISTER_ENGINE_PATH
    || (existsSync(path.join(BUNDLED_REGISTER_ENGINE, 'register_cli.py'))
        ? BUNDLED_REGISTER_ENGINE
        : DEVELOPMENT_REGISTER_ENGINE);
const DEFAULT_CONVERTER_SCRIPT = process.env.XAI_CONVERTER_SCRIPT_PATH
    || (existsSync(BUNDLED_CONVERTER_SCRIPT)
        ? BUNDLED_CONVERTER_SCRIPT
        : DEVELOPMENT_CONVERTER_SCRIPT);
const RUNNER_SCRIPT = path.resolve(SERVICE_DIR, '../scripts/xai-registration-runner.py');
const TASK_ROOT = path.join(tmpdir(), 'accounthub-xai-registration');
const EVENT_PREFIX = '@@ACCOUNTHUB_EVENT@@';
const MAX_LOGS = 1200;
const MAX_TASKS = 20;
const TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['running', 'stopping', 'importing']);
const ALLOWED_EMAIL_PROVIDERS = new Set([
    'cloudmail',
    'cloudflare',
    'duckmail',
    'yyds',
    'hotmail',
    'outlookmail'
]);

const tasks = new Map();
let activeTaskId = null;
let latestTaskId = null;

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function stringValue(value, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeProvider(value) {
    const normalized = stringValue(value, 'cloudmail').toLowerCase();
    if (normalized === 'outlook') return 'outlookmail';
    return ALLOWED_EMAIL_PROVIDERS.has(normalized) ? normalized : 'cloudmail';
}

function resolveConfiguredPath(value, fallback) {
    const configured = stringValue(value);
    if (!configured) return fallback;
    if (path.isAbsolute(configured)) return configured;
    const backendRelative = path.resolve(BACKEND_ROOT, configured);
    return existsSync(backendRelative)
        ? backendRelative
        : path.resolve(REPOSITORY_ROOT, configured);
}

function findChromiumExecutable() {
    for (const command of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
        const executable = findExecutable(command);
        if (executable) return executable;
    }
    for (const candidate of [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function redactProxy(value) {
    const raw = stringValue(value);
    if (!raw) return '';
    try {
        const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
        if (parsed.username || parsed.password) {
            parsed.username = parsed.username ? '***' : '';
            parsed.password = parsed.password ? '***' : '';
        }
        return raw.includes('://') ? parsed.toString().replace(/\/$/, '') : parsed.host;
    } catch {
        return '[configured]';
    }
}

export function normalizeXaiRegistrationOptions(payload = {}) {
    const emailPayload = payload.email && typeof payload.email === 'object' ? payload.email : {};
    const provider = normalizeProvider(payload.emailProvider || emailPayload.provider);
    const count = clampInteger(payload.count, 1, 1, 50);
    const threads = clampInteger(payload.threads, 1, 1, Math.min(10, count));
    const poolIdValue = Number.parseInt(payload.poolId, 10);
    const poolId = Number.isFinite(poolIdValue) && poolIdValue > 0 ? poolIdValue : null;

    return {
        count,
        threads,
        poolId,
        proxy: stringValue(payload.proxy),
        userAgent: stringValue(payload.userAgent),
        enableNsfw: payload.enableNsfw !== false,
        fastMode: payload.fastMode !== false,
        browserReuse: payload.browserReuse !== false,
        useUv: payload.useUv !== false,
        pythonCommand: stringValue(payload.pythonCommand, 'python3') || 'python3',
        registerEnginePath: resolveConfiguredPath(payload.registerEnginePath, DEFAULT_REGISTER_ENGINE),
        converterScriptPath: resolveConfiguredPath(payload.converterScriptPath, DEFAULT_CONVERTER_SCRIPT),
        email: {
            provider,
            domains: stringValue(payload.domains || emailPayload.domains),
            cloudmail: {
                url: stringValue(payload.cloudmailUrl || emailPayload.cloudmail?.url),
                adminEmail: stringValue(payload.cloudmailAdminEmail || emailPayload.cloudmail?.adminEmail),
                password: stringValue(payload.cloudmailPassword || emailPayload.cloudmail?.password)
            },
            cloudflare: {
                apiBase: stringValue(payload.cloudflareApiBase || emailPayload.cloudflare?.apiBase),
                apiKey: stringValue(payload.cloudflareApiKey || emailPayload.cloudflare?.apiKey),
                authMode: stringValue(payload.cloudflareAuthMode || emailPayload.cloudflare?.authMode, 'bearer') || 'bearer',
                pathDomains: stringValue(payload.cloudflarePathDomains || emailPayload.cloudflare?.pathDomains, '/domains') || '/domains',
                pathAccounts: stringValue(payload.cloudflarePathAccounts || emailPayload.cloudflare?.pathAccounts, '/accounts') || '/accounts',
                pathToken: stringValue(payload.cloudflarePathToken || emailPayload.cloudflare?.pathToken, '/token') || '/token',
                pathMessages: stringValue(payload.cloudflarePathMessages || emailPayload.cloudflare?.pathMessages, '/messages') || '/messages'
            },
            duckmail: {
                apiKey: stringValue(payload.duckmailApiKey || emailPayload.duckmail?.apiKey)
            },
            yyds: {
                apiKey: stringValue(payload.yydsApiKey || emailPayload.yyds?.apiKey),
                jwt: stringValue(payload.yydsJwt || emailPayload.yyds?.jwt)
            },
            hotmail: {
                accounts: stringValue(payload.hotmailAccounts || emailPayload.hotmail?.accounts)
            }
        }
    };
}

function validateOptions(options) {
    if (!existsSync(RUNNER_SCRIPT)) {
        throw Object.assign(new Error(`AccountHub runner not found: ${RUNNER_SCRIPT}`), { statusCode: 500 });
    }
    if (!existsSync(path.join(options.registerEnginePath, 'register_cli.py'))) {
        throw Object.assign(new Error('Grok registration engine is unavailable'), { statusCode: 400 });
    }
    if (!existsSync(options.converterScriptPath)) {
        throw Object.assign(new Error('Grok SSO converter is unavailable'), { statusCode: 400 });
    }
    if (process.platform === 'linux' && !findChromiumExecutable()) {
        throw Object.assign(new Error('Chromium is unavailable in the backend runtime'), { statusCode: 400 });
    }
    if (process.platform === 'linux' && !process.env.DISPLAY && !findExecutable('xvfb-run')) {
        throw Object.assign(new Error('A display server or xvfb-run is required for Grok registration'), { statusCode: 400 });
    }
    if (
        !findEnginePython(options.registerEnginePath)
        && !findExecutable('uv')
        && !findExecutable(options.pythonCommand)
    ) {
        throw Object.assign(new Error('No Grok registration Python runtime is available'), { statusCode: 400 });
    }

    const { provider } = options.email;
    if (provider === 'cloudmail') {
        if (!options.email.cloudmail.url || !options.email.cloudmail.adminEmail || !options.email.cloudmail.password) {
            throw Object.assign(new Error('CloudMail URL, admin email and password are required'), { statusCode: 400 });
        }
    } else if (provider === 'cloudflare') {
        if (!options.email.cloudflare.apiBase) {
            throw Object.assign(new Error('Cloudflare mail API base URL is required'), { statusCode: 400 });
        }
    } else if (provider === 'duckmail') {
        if (!options.email.duckmail.apiKey) {
            throw Object.assign(new Error('DuckMail API key is required'), { statusCode: 400 });
        }
    } else if (provider === 'yyds') {
        if (!options.email.yyds.apiKey && !options.email.yyds.jwt) {
            throw Object.assign(new Error('YYDS API key or JWT is required'), { statusCode: 400 });
        }
    } else if (provider === 'hotmail' || provider === 'outlookmail') {
        if (!options.email.hotmail.accounts) {
            throw Object.assign(new Error('Hotmail/Outlook account credentials are required'), { statusCode: 400 });
        }
    }
}

export function sanitizeRegistrationLogLine(value) {
    return String(value || '')
        .replace(/eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]')
        .replace(/((?:refresh|access|id|sso)[_-]?token["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
        .replace(/(sso(?:-rw)?["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

export function parseRegistrationRunnerEvent(line) {
    if (!String(line).startsWith(EVENT_PREFIX)) return null;
    try {
        return JSON.parse(String(line).slice(EVENT_PREFIX.length));
    } catch {
        return null;
    }
}

function publicOptions(options) {
    return {
        count: options.count,
        threads: options.threads,
        poolId: options.poolId,
        proxy: redactProxy(options.proxy),
        fastMode: options.fastMode,
        browserReuse: options.browserReuse,
        useUv: options.useUv,
        pythonCommand: options.pythonCommand,
        registerEnginePath: options.registerEnginePath,
        converterScriptPath: options.converterScriptPath,
        emailProvider: options.email.provider,
        domains: options.email.domains
    };
}

function publicTask(task, includeLogs = true) {
    if (!task) return null;
    return {
        id: task.id,
        status: task.status,
        stage: task.stage,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        exitCode: task.exitCode,
        signal: task.signal,
        stopRequested: task.stopRequested,
        options: task.publicOptions,
        metrics: { ...task.metrics },
        result: task.result ? { ...task.result } : null,
        error: task.error || null,
        artifactAvailable: Boolean(
            task.result?.authFiles?.length
            || task.runnerResult?.authFiles?.length
            || task.metrics.generated
        ),
        logs: includeLogs ? task.logs.map(item => ({ ...item })) : undefined
    };
}

function emitTaskEvent(eventType, task, extra = {}) {
    broadcastEvent(eventType, {
        taskId: task.id,
        task: publicTask(task, false),
        ...extra
    });
}

function appendLog(task, message, stream = 'stdout', level = 'info') {
    const sanitized = sanitizeRegistrationLogLine(message).trim();
    if (!sanitized) return;
    const entry = {
        seq: ++task.logSequence,
        timestamp: new Date().toISOString(),
        stream,
        level,
        message: sanitized
    };
    task.logs.push(entry);
    if (task.logs.length > MAX_LOGS) {
        task.logs.splice(0, task.logs.length - MAX_LOGS);
    }
    broadcastEvent('xai_registration_log', {
        taskId: task.id,
        ...entry
    });
}

function updateFromRunnerEvent(task, event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'stage') {
        task.stage = stringValue(event.stage, task.stage);
        emitTaskEvent('xai_registration_progress', task);
        return;
    }
    if (event.type === 'progress' || event.type === 'result') {
        if (event.stage) task.stage = stringValue(event.stage, task.stage);
        for (const key of ['registered', 'registrationFailed', 'converted', 'conversionFailed']) {
            if (Number.isFinite(Number(event[key]))) {
                task.metrics[key] = Number(event[key]);
            }
        }
        if (event.type === 'result') {
            task.runnerResult = {
                registered: task.metrics.registered,
                registrationFailed: task.metrics.registrationFailed,
                converted: task.metrics.converted,
                conversionFailed: task.metrics.conversionFailed,
                authFiles: Array.isArray(event.authFiles) ? event.authFiles.map(String) : []
            };
        }
        emitTaskEvent('xai_registration_progress', task);
    }
}

function attachOutputStream(task, stream, streamName) {
    let buffer = '';
    stream.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            const event = parseRegistrationRunnerEvent(line);
            if (event) {
                updateFromRunnerEvent(task, event);
            } else {
                appendLog(task, line, streamName, streamName === 'stderr' ? 'error' : 'info');
            }
        }
    });
    stream.on('end', () => {
        if (!buffer) return;
        const event = parseRegistrationRunnerEvent(buffer);
        if (event) {
            updateFromRunnerEvent(task, event);
        } else {
            appendLog(task, buffer, streamName, streamName === 'stderr' ? 'error' : 'info');
        }
        buffer = '';
    });
}

function findExecutable(command) {
    if (!command) return null;
    if (command.includes(path.sep)) {
        return existsSync(command) ? command : null;
    }
    const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const entry of pathEntries) {
        const candidate = path.join(entry, command);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function findEnginePython(registerEnginePath) {
    for (const relativePath of [
        path.join('.venv', 'bin', 'python'),
        path.join('.venv', 'Scripts', 'python.exe')
    ]) {
        const candidate = path.join(registerEnginePath, relativePath);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function buildRunnerCommand(options, taskDir, optionsPath) {
    const runnerArgs = [
        RUNNER_SCRIPT,
        '--task-dir',
        taskDir,
        '--register-engine',
        options.registerEnginePath,
        '--converter-script',
        options.converterScriptPath,
        '--options-file',
        optionsPath
    ];
    const enginePython = findEnginePython(options.registerEnginePath);
    if (enginePython) {
        return withVirtualDisplay({
            command: enginePython,
            args: ['-u', ...runnerArgs],
            runtime: 'python-venv'
        });
    }
    const uvPath = options.useUv ? findExecutable('uv') : null;
    if (uvPath) {
        return withVirtualDisplay({
            command: uvPath,
            args: ['run', '--project', options.registerEnginePath, 'python', '-u', ...runnerArgs],
            runtime: 'uv'
        });
    }
    const pythonPath = findExecutable(options.pythonCommand) || options.pythonCommand;
    return withVirtualDisplay({
        command: pythonPath,
        args: ['-u', ...runnerArgs],
        runtime: 'python'
    });
}

function withVirtualDisplay(commandSpec) {
    if (process.platform !== 'linux' || process.env.DISPLAY) return commandSpec;
    const xvfbPath = findExecutable('xvfb-run');
    if (!xvfbPath) return commandSpec;
    return {
        command: xvfbPath,
        args: ['-a', commandSpec.command, ...commandSpec.args],
        runtime: `${commandSpec.runtime}+xvfb`
    };
}

function readGeneratedRecords(task) {
    const authDir = path.join(task.taskDir, 'auths');
    if (!existsSync(authDir)) return [];
    return readdirSync(authDir)
        .filter(fileName => fileName.startsWith('xai-') && fileName.endsWith('.json'))
        .sort()
        .map(fileName => {
            const filePath = path.join(authDir, fileName);
            return {
                fileName,
                record: JSON.parse(readFileSync(filePath, 'utf8'))
            };
        });
}

function cleanupSensitiveTaskFiles(task) {
    rmSync(path.join(task.taskDir, '.options.json'), { force: true });
    rmSync(path.join(task.taskDir, 'accounts.txt'), { force: true });
    rmSync(path.join(task.taskDir, 'registration-engine'), { recursive: true, force: true });
    if (!existsSync(task.taskDir)) return;
    for (const fileName of readdirSync(task.taskDir)) {
        if (fileName.startsWith('.convert-') && fileName.endsWith('.txt')) {
            rmSync(path.join(task.taskDir, fileName), { force: true });
        }
    }
}

async function finalizeTask(task, code, signal) {
    if (task.finalized) return;
    task.finalized = true;
    if (task.stopTimer) {
        clearTimeout(task.stopTimer);
        task.stopTimer = null;
    }
    task.process = null;
    task.exitCode = Number.isFinite(code) ? code : null;
    task.signal = signal || null;

    if (task.stopRequested) {
        cleanupSensitiveTaskFiles(task);
        task.status = 'stopped';
        task.stage = 'stopped';
        task.completedAt = new Date().toISOString();
        appendLog(task, 'Registration task stopped by user', 'system', 'warning');
        if (activeTaskId === task.id) activeTaskId = null;
        emitTaskEvent('xai_registration_complete', task);
        return;
    }

    try {
        const generated = readGeneratedRecords(task);
        task.metrics.generated = generated.length;
        if (generated.length === 0) {
            throw new Error(task.error || (code === 0
                ? 'Registration completed without generating xAI JSON credentials'
                : `Registration runner exited with code ${code ?? 'unknown'}`));
        }

        task.result = {
            ...(task.runnerResult || {}),
            authFiles: generated.map(item => item.fileName),
            import: null
        };
        task.status = 'importing';
        task.stage = 'importing';
        emitTaskEvent('xai_registration_progress', task);
        const importResult = await importXaiCredentials({
            records: generated.map(item => item.record),
            poolId: task.options.poolId,
            source: 'xai-registration',
            importSource: 'xai-registration'
        });
        task.metrics.imported = Number(importResult.imported || 0);
        task.metrics.skipped = Number(importResult.skipped || 0);
        task.metrics.importFailed = Number(importResult.failed || 0);
        task.result = {
            ...task.result,
            import: importResult
        };
        task.status = importResult.failed > 0 ? 'completed_with_errors' : 'completed';
        task.stage = 'completed';
        task.completedAt = new Date().toISOString();
        appendLog(
            task,
            `Imported ${task.metrics.imported}, skipped ${task.metrics.skipped}, failed ${task.metrics.importFailed}`,
            'system',
            importResult.failed > 0 ? 'warning' : 'info'
        );
        emitTaskEvent('xai_registration_complete', task);
    } catch (error) {
        task.status = 'failed';
        task.stage = 'failed';
        task.error = error.message || String(error);
        task.completedAt = new Date().toISOString();
        appendLog(task, task.error, 'system', 'error');
        emitTaskEvent('xai_registration_error', task, { error: task.error });
    } finally {
        cleanupSensitiveTaskFiles(task);
        if (activeTaskId === task.id) activeTaskId = null;
    }
}

function cleanupOldTasks() {
    const now = Date.now();
    const ordered = [...tasks.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const task of ordered.slice(MAX_TASKS)) {
        tasks.delete(task.id);
        if (!ACTIVE_STATUSES.has(task.status)) {
            rmSync(task.taskDir, { recursive: true, force: true });
        }
    }
    for (const task of tasks.values()) {
        if (ACTIVE_STATUSES.has(task.status)) continue;
        const completedAt = Date.parse(task.completedAt || task.createdAt);
        if (Number.isFinite(completedAt) && now - completedAt > TASK_RETENTION_MS) {
            tasks.delete(task.id);
            rmSync(task.taskDir, { recursive: true, force: true });
        }
    }
}

export function getXaiRegistrationEnvironment() {
    const chromiumPath = findChromiumExecutable();
    const xvfbPath = findExecutable('xvfb-run');
    const enginePythonPath = findEnginePython(DEFAULT_REGISTER_ENGINE);
    return {
        backendRoot: BACKEND_ROOT,
        registerEnginePath: DEFAULT_REGISTER_ENGINE,
        converterScriptPath: DEFAULT_CONVERTER_SCRIPT,
        registerEngineReady: existsSync(path.join(DEFAULT_REGISTER_ENGINE, 'register_cli.py')),
        converterReady: existsSync(DEFAULT_CONVERTER_SCRIPT),
        runnerReady: existsSync(RUNNER_SCRIPT),
        uvReady: Boolean(findExecutable('uv')),
        pythonReady: Boolean(enginePythonPath || findExecutable('python3')),
        enginePythonPath,
        chromiumReady: Boolean(chromiumPath),
        chromiumPath,
        displayReady: process.platform !== 'linux' || Boolean(process.env.DISPLAY || xvfbPath),
        xvfbReady: Boolean(xvfbPath)
    };
}

export function getXaiRegistrationStatus() {
    cleanupOldTasks();
    const task = tasks.get(activeTaskId) || tasks.get(latestTaskId) || null;
    return {
        success: true,
        task: publicTask(task),
        environment: getXaiRegistrationEnvironment(),
        defaults: {
            registerEnginePath: DEFAULT_REGISTER_ENGINE,
            converterScriptPath: DEFAULT_CONVERTER_SCRIPT,
            pythonCommand: 'python3',
            useUv: true
        }
    };
}

export function getXaiRegistrationTask(taskId) {
    cleanupOldTasks();
    return publicTask(tasks.get(taskId) || null);
}

export function startXaiRegistration(payload = {}) {
    cleanupOldTasks();
    const activeTask = tasks.get(activeTaskId);
    if (activeTask && ACTIVE_STATUSES.has(activeTask.status)) {
        throw Object.assign(new Error('A Grok registration task is already running'), { statusCode: 409 });
    }

    const options = normalizeXaiRegistrationOptions(payload);
    validateOptions(options);
    mkdirSync(TASK_ROOT, { recursive: true, mode: 0o700 });
    const taskId = randomUUID();
    const taskDir = path.join(TASK_ROOT, taskId);
    mkdirSync(taskDir, { recursive: true, mode: 0o700 });
    const optionsPath = path.join(taskDir, '.options.json');
    writeFileSync(optionsPath, JSON.stringify(options), { encoding: 'utf8', mode: 0o600 });

    const command = buildRunnerCommand(options, taskDir, optionsPath);
    const now = new Date().toISOString();
    const task = {
        id: taskId,
        status: 'running',
        stage: 'starting',
        createdAt: now,
        startedAt: now,
        completedAt: null,
        exitCode: null,
        signal: null,
        stopRequested: false,
        options,
        publicOptions: publicOptions(options),
        runtime: command.runtime,
        taskDir,
        process: null,
        logSequence: 0,
        logs: [],
        runnerResult: null,
        result: null,
        error: null,
        finalized: false,
        stopTimer: null,
        metrics: {
            target: options.count,
            registered: 0,
            registrationFailed: 0,
            converted: 0,
            conversionFailed: 0,
            generated: 0,
            imported: 0,
            skipped: 0,
            importFailed: 0
        }
    };
    tasks.set(taskId, task);
    activeTaskId = taskId;
    latestTaskId = taskId;

    const child = spawn(command.command, command.args, {
        cwd: BACKEND_ROOT,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
    });
    task.process = child;
    appendLog(task, `Started Grok registration task with ${command.runtime}`, 'system');
    attachOutputStream(task, child.stdout, 'stdout');
    attachOutputStream(task, child.stderr, 'stderr');

    child.once('error', error => {
        if (task.process !== child || task.finalized) return;
        task.error = error.message || String(error);
        void finalizeTask(task, null, 'spawn_error');
    });
    child.once('close', (code, signal) => {
        void finalizeTask(task, code, signal);
    });

    emitTaskEvent('xai_registration_progress', task);
    return { success: true, task: publicTask(task) };
}

export function stopXaiRegistration(taskId = null) {
    const resolvedTaskId = taskId || activeTaskId;
    const task = tasks.get(resolvedTaskId);
    if (!task || !['running', 'stopping'].includes(task.status)) {
        throw Object.assign(new Error('No running Grok registration task found'), { statusCode: 404 });
    }
    if (task.stopRequested) {
        return { success: true, task: publicTask(task) };
    }

    task.stopRequested = true;
    task.status = 'stopping';
    task.stage = 'stopping';
    appendLog(task, 'Stopping registration task', 'system', 'warning');
    emitTaskEvent('xai_registration_progress', task);

    if (task.process?.pid) {
        try {
            if (process.platform === 'win32') {
                task.process.kill('SIGTERM');
            } else {
                process.kill(-task.process.pid, 'SIGTERM');
            }
        } catch (error) {
            if (error.code !== 'ESRCH') throw error;
        }
        task.stopTimer = setTimeout(() => {
            if (!task.process?.pid || task.finalized) return;
            try {
                if (process.platform === 'win32') {
                    task.process.kill('SIGKILL');
                } else {
                    process.kill(-task.process.pid, 'SIGKILL');
                }
            } catch (error) {
                if (error.code !== 'ESRCH') {
                    appendLog(task, `Force stop failed: ${error.message}`, 'system', 'error');
                }
            }
        }, 8000);
        task.stopTimer.unref?.();
    }
    return { success: true, task: publicTask(task) };
}

export function getXaiRegistrationArtifactArchive(taskId) {
    const task = tasks.get(taskId);
    if (!task) {
        throw Object.assign(new Error('Grok registration task not found'), { statusCode: 404 });
    }
    const generated = readGeneratedRecords(task);
    if (generated.length === 0) {
        throw Object.assign(new Error('No generated Grok JSON artifacts are available'), { statusCode: 404 });
    }

    const zip = new AdmZip();
    for (const item of generated) {
        zip.addFile(item.fileName, Buffer.from(JSON.stringify(item.record, null, 2) + '\n', 'utf8'));
    }
    return {
        buffer: zip.toBuffer(),
        fileName: `grok-registration-${task.id}.zip`
    };
}
