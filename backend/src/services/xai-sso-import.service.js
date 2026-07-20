import { spawn } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SERVICE_DIR, '../..');
const BUNDLED_REGISTER_ENGINE = path.join(BACKEND_ROOT, 'src/vendor/xai-registration-engine');
const BUNDLED_CONVERTER_SCRIPT = path.join(
    BACKEND_ROOT,
    'src/vendor/xai-registration-converter/sso_to_auth_json.py'
);
const CONVERSION_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_LENGTH = 24_000;

function firstString(...values) {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const normalized = value.trim();
        if (normalized) return normalized;
    }
    return '';
}

function findExecutable(command) {
    if (!command) return null;
    if (command.includes(path.sep)) return existsSync(command) ? command : null;
    for (const entry of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(entry, command);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function resolvePythonCommand(configured = '') {
    const enginePath = process.env.XAI_REGISTER_ENGINE_PATH || BUNDLED_REGISTER_ENGINE;
    for (const candidate of [
        firstString(configured),
        path.join(enginePath, '.venv', 'bin', 'python'),
        path.join(enginePath, '.venv', 'Scripts', 'python.exe'),
        'python3',
        'python'
    ]) {
        const executable = findExecutable(candidate);
        if (executable) return executable;
    }
    return null;
}

function sanitizeConverterOutput(value) {
    return String(value || '')
        .replace(/eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]')
        .replace(/((?:refresh|access|id|sso)[_-]?token["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
        .trim();
}

function summarizeConverterError(value, fallback) {
    const lines = sanitizeConverterOutput(value)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    return lines.slice(-4).join(' | ') || fallback;
}

function runConverter(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        let settled = false;
        const append = chunk => {
            output += chunk.toString('utf8');
            if (output.length > MAX_OUTPUT_LENGTH) {
                output = output.slice(-MAX_OUTPUT_LENGTH);
            }
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new Error('xAI SSO OAuth conversion timed out'));
        }, CONVERSION_TIMEOUT_MS);
        child.once('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, output: sanitizeConverterOutput(output) });
        });
    });
}

export function sanitizeConvertedXaiRecord(record = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const sanitized = { ...record };
    delete sanitized.password;
    delete sanitized.sso;
    delete sanitized.sso_cookie;
    delete sanitized.ssoCookie;
    return sanitized;
}

export async function convertXaiSsoDeliveries(accounts = [], options = {}) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
        return { records: [], failures: [] };
    }

    const converterScriptPath = firstString(
        options.converterScriptPath,
        process.env.XAI_CONVERTER_SCRIPT_PATH,
        BUNDLED_CONVERTER_SCRIPT
    );
    const pythonCommand = resolvePythonCommand(options.pythonCommand);
    if (!existsSync(converterScriptPath)) {
        return {
            records: [],
            failures: accounts.map(account => ({
                email: account.email || null,
                reason: 'Grok SSO converter is unavailable'
            }))
        };
    }
    if (!pythonCommand) {
        return {
            records: [],
            failures: accounts.map(account => ({
                email: account.email || null,
                reason: 'Python runtime for Grok SSO conversion is unavailable'
            }))
        };
    }

    const taskDir = mkdtempSync(path.join(tmpdir(), 'accounthub-xai-sso-import-'));
    const authDir = path.join(taskDir, 'auths');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const records = [];
    const failures = [];

    try {
        for (let index = 0; index < accounts.length; index += 1) {
            const account = accounts[index] || {};
            const email = firstString(account.email);
            const sso = firstString(account.sso);
            if (!email || !sso) {
                failures.push({ email: email || null, reason: 'Delivery record is missing email or SSO' });
                continue;
            }

            const inputPath = path.join(taskDir, `.sso-${index + 1}.txt`);
            writeFileSync(inputPath, `${sso}\n`, { encoding: 'utf8', mode: 0o600 });
            const beforeFiles = new Set(readdirSync(authDir));
            const args = [
                '-u',
                converterScriptPath,
                '--sso',
                inputPath,
                '--email',
                email,
                '--cpa-auth-dir',
                authDir
            ];
            const proxy = firstString(options.proxy);
            if (proxy) args.push('--proxy', proxy);

            try {
                const result = await runConverter(pythonCommand, args, path.dirname(converterScriptPath));
                const generatedFiles = readdirSync(authDir)
                    .filter(fileName => fileName.startsWith('xai-') && fileName.endsWith('.json'))
                    .filter(fileName => !beforeFiles.has(fileName));
                const candidateFiles = generatedFiles.length > 0
                    ? generatedFiles
                    : readdirSync(authDir).filter(fileName => fileName.startsWith('xai-') && fileName.endsWith('.json'));
                const generatedRecord = candidateFiles
                    .map(fileName => JSON.parse(readFileSync(path.join(authDir, fileName), 'utf8')))
                    .find(record => firstString(record?.email).toLowerCase() === email.toLowerCase());

                if (result.code !== 0 || !generatedRecord) {
                    failures.push({
                        email,
                        reason: summarizeConverterError(
                            result.output,
                            `Grok SSO OAuth conversion failed with code ${result.code}`
                        )
                    });
                    continue;
                }

                records.push(sanitizeConvertedXaiRecord(generatedRecord));
            } catch (error) {
                failures.push({
                    email,
                    reason: summarizeConverterError(error.message, 'Grok SSO OAuth conversion failed')
                });
            } finally {
                rmSync(inputPath, { force: true });
            }
        }
    } finally {
        rmSync(taskDir, { recursive: true, force: true });
    }

    return { records: records.filter(Boolean), failures };
}
