/**
 * WindsurfClaudeApiService — AccountHub native integration for Windsurf accounts.
 *
 * Each provider instance represents ONE Windsurf account (apiKey).
 * The Language Server binary is shared globally across all Windsurf providers.
 *
 * Config keys (per provider):
 *   WINDSURF_API_KEY        — Windsurf token (from windsurf.com/show-auth-token or API key)
 *   WINDSURF_LS_BINARY_PATH — Path to language_server_linux_x64 binary (default: /opt/windsurf/language_server_linux_x64)
 *   WINDSURF_API_SERVER_URL — Codeium API server URL (default: https://server.self-serve.windsurf.com)
 *   WINDSURF_MODEL          — Default model key (default: claude-sonnet-4-5-20250929)
 */

import { randomUUID } from 'crypto';
import { startLanguageServer, waitForReady } from './langserver.js';
import { WindsurfClient } from './client.js';
import { resolveModel, getModelInfo } from './windsurf-models.js';
import { log } from './log.js';

// ─── Token usage conversion (Windsurf → Claude format) ───────────────────────

/**
 * Convert Windsurf usage { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 * to Claude Messages API usage format.
 */
function wsUsageToClaudeUsage(wsUsage) {
    return {
        input_tokens:                wsUsage?.inputTokens      || 0,
        output_tokens:               wsUsage?.outputTokens     || 0,
        cache_read_input_tokens:     wsUsage?.cacheReadTokens  || 0,
        cache_creation_input_tokens: wsUsage?.cacheWriteTokens || 0,
    };
}

// ─── Environment fact extraction (ported from WindsurfAPI-master demo) ──────

const WORKSPACE_STUB_OVERRIDE =
    'Any `<workspace_information>` or `<workspace_layout>` block elsewhere in this conversation describes a placeholder ' +
    'directory created by the proxy infrastructure, not the user\'s project. Treat the Working directory above as the ' +
    'authoritative working directory and use tools to discover real project contents.';

const WORKSPACE_PATH_HINT =
    'Workspace path hidden; "<workspace>" is a redaction marker, NOT a real path — never pass it to shell tools. ' +
    'When asked for cwd, use the Working directory from Environment facts above.';

/**
 * Extract CWD and env facts from ALL messages (system + user).
 * Matches every Claude Code / Anthropic-format variant seen in the wild.
 * Returns a bullet-list string or '' if no cwd found.
 */
function extractCallerEnvironment(messages) {
    if (!Array.isArray(messages)) return '';
    const seen = new Set();
    const out = [];

    const PATH_TAIL = '(?:[\\/~]|[A-Za-z]:\\\\)[^\\s`\'"<>\\n.,;)]+';
    const ADJ = '(?:Primary|Current|Initial|Default|Active|Project|My)\\s+';
    const PATTERNS = [
        ['cwd', new RegExp(
            `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:${ADJ})?(?:Working\\s+directory|cwd)\\s*[:=]\\s*\`?(${PATH_TAIL})\`?` +
            `|(?:current\\s+working\\s+directory(?:\\s+is)?)\\s*[:=]?\\s*\`?(${PATH_TAIL})\`?` +
            `|<cwd>\\s*(${PATH_TAIL})\\s*</cwd>`,
            'gi'
        ), (v) => `- Working directory: ${v}`],
        ['git', /(?:^|\n)\s*(?:[-*]\s+)?Is(?:\s+(?:directory\s+)?(?:a\s+)?)git\s+repo(?:sitory)?\s*[:=]\s*([^\n<]+)/i,
            (v) => `- Is git repo: ${v}`],
        ['platform', /(?:^|\n)\s*(?:[-*]\s+)?Platform\s*[:=]\s*([^\n<]+)/i, (v) => `- Platform: ${v}`],
        ['os', /(?:^|\n)\s*(?:[-*]\s+)?OS\s+[Vv]ersion\s*[:=]\s*([^\n<]+)/i, (v) => `- OS version: ${v}`],
    ];

    for (const m of messages) {
        if (!m) continue;
        let content;
        if (typeof m.content === 'string') content = m.content;
        else if (Array.isArray(m.content))
            content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
        else continue;
        if (!content) continue;

        for (const [key, re, fmt] of PATTERNS) {
            if (seen.has(key)) continue;
            if (re.global) {
                for (const match of content.matchAll(re)) {
                    const value = (match[1] || match[2] || match[3] || '').trim();
                    if (!value || /[\x00-\x1f]/.test(value) || value === '<workspace>') continue;
                    seen.add(key);
                    out.push(fmt(value));
                    break;
                }
            } else {
                const match = content.match(re);
                if (!match) continue;
                const value = (match[1] || match[2] || '').trim();
                if (!value || /[\x00-\x1f]/.test(value)) continue;
                seen.add(key);
                out.push(fmt(value));
            }
        }
        if (seen.size >= PATTERNS.length) break;
    }

    if (!seen.has('cwd')) return '';
    return out.join('\n');
}

// ─── Tool preamble builder (Claude → Windsurf NO_TOOL emulation) ─────────────

/**
 * Convert Claude-format tools[] to a text preamble for the Cascade NO_TOOL path.
 * callerEnv: string from extractCallerEnvironment(), injected at proto level.
 */
function buildToolPreambleFromClaudeTools(tools, callerEnv) {
    if (!Array.isArray(tools) || tools.length === 0) return null;
    const lines = [];

    // ── Environment facts (proto-level authority, overrides <workspace_information>) ──
    if (callerEnv && callerEnv.trim()) {
        lines.push('## Environment facts');
        lines.push('The facts below are provided by the calling agent and describe the active execution context.');
        lines.push('Tool calls operate on these paths.\n');
        lines.push(callerEnv.trim());
        lines.push('');
        lines.push(WORKSPACE_STUB_OVERRIDE);
        lines.push('');
    }
    lines.push(WORKSPACE_PATH_HINT);
    lines.push('');

    // ── Tool protocol ──
    lines.push('You have access to the following functions. They are REAL callable tools — the caller will execute them and return results.');
    lines.push('To invoke a function, emit a block in this EXACT format:');
    lines.push('<tool_call>{"name":"<function_name>","arguments":{...}}</tool_call>');
    lines.push('Rules:');
    lines.push('1. Each <tool_call>...</tool_call> block must fit on ONE line (no line breaks inside the JSON).');
    lines.push('2. "arguments" must be a JSON object matching the function\'s parameter schema.');
    lines.push('3. You MAY emit MULTIPLE <tool_call> blocks for parallel calls. Emit ALL needed calls, then STOP.');
    lines.push('4. After emitting the last <tool_call> block, STOP. Do not write any explanation after it.');
    lines.push('5. NEVER say "I don\'t have access to tools" — the functions listed below ARE your available tools.');
    lines.push('6. NEVER FABRICATE OUTPUT. Do not invent command outputs or file contents — those come from tool execution.');
    lines.push('7. NEVER write narration like "I\'ll run X" — emit the <tool_call> block directly with no preamble.');
    lines.push('');
    lines.push('Available functions:');
    for (const tool of tools) {
        lines.push(`\n## ${tool.name}`);
        if (tool.description) lines.push(tool.description);
        if (tool.input_schema) lines.push(`Parameters: ${JSON.stringify(tool.input_schema)}`);
    }
    return lines.join('\n');
}

/**
 * Replace server-side LS workspace paths with the user's real CWD.
 * Pattern: /home/user/project[s]/workspace-{hex16} (the path our LS creates).
 * Also replaces the <workspace> placeholder the model sometimes emits.
 */
function sanitizeWorkspacePaths(text, userCwd) {
    if (!text || !userCwd) return text;
    return text
        .replace(/\/home\/user\/project[s]?\/workspace-[0-9a-f]{8,}/g, userCwd)
        .replace(/<workspace>/g, userCwd);
}

/** Parse <tool_call>{...}</tool_call> blocks from model text output. */
function parseToolCallsFromText(text, userCwd) {
    const calls = [];
    const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        try {
            const rawJson = userCwd ? sanitizeWorkspacePaths(m[1].trim(), userCwd) : m[1].trim();
            const parsed = JSON.parse(rawJson);
            if (parsed.name) {
                calls.push({
                    id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    name: parsed.name,
                    input: parsed.arguments || parsed.input || {},
                });
            }
        } catch { /* skip malformed */ }
    }
    return calls;
}

/**
 * Extract text that appears BEFORE the first <tool_call> block.
 * Text after tool calls is dropped — it belongs in the next turn after tool execution.
 */
function extractPreToolText(text) {
    const idx = text.indexOf('<tool_call>');
    if (idx === -1) return text.trim();  // no tool calls at all
    return text.slice(0, idx).trim();
}

/**
 * Log in to Windsurf with email+password and return the resolved apiKey.
 * This is a one-time operation — the returned apiKey is stored as the account credential.
 * @param {string} email
 * @param {string} password
 * @param {object} [proxy]  - optional { host, port, username, password }
 * @returns {Promise<{ apiKey: string, name: string, email: string, refreshToken: string, apiServerUrl: string }>}
 */
export async function windsurfEmailLogin(email, password, proxy = null) {
    const { windsurfLogin } = await import('./windsurf-login.js');
    const result = await windsurfLogin(email, password, proxy);
    return {
        apiKey: result.apiKey,
        name: result.name || email,
        email: result.email || email,
        refreshToken: result.refreshToken || '',
        apiServerUrl: result.apiServerUrl || '',
    };
}

const DEFAULT_LS_BINARY = '/opt/windsurf/language_server_linux_x64';
const DEFAULT_API_SERVER = 'https://server.self-serve.windsurf.com';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

// Global LS entry promise — shared across all WindsurfClaudeApiService instances.
// Returns { port, csrfToken } once the LS is ready.
let _lsEntryPromise = null;

async function ensureLanguageServer(binaryPath, apiServerUrl) {
    if (_lsEntryPromise) return _lsEntryPromise;
    _lsEntryPromise = (async () => {
        try {
            log.info(`Starting Windsurf Language Server at ${binaryPath}...`);
            const entry = await startLanguageServer({ binaryPath, apiServerUrl });
            await waitForReady();
            log.info(`Windsurf Language Server ready on port ${entry.port}.`);
            return entry; // { port, csrfToken }
        } catch (err) {
            _lsEntryPromise = null;
            throw err;
        }
    })();
    return _lsEntryPromise;
}

export class WindsurfClaudeApiService {
    constructor(config) {
        this.apiKey = config.WINDSURF_API_KEY || '';
        this.lsBinaryPath = config.WINDSURF_LS_BINARY_PATH || DEFAULT_LS_BINARY;
        this.apiServerUrl = config.WINDSURF_API_SERVER_URL || DEFAULT_API_SERVER;
        this.defaultModel = config.WINDSURF_MODEL || DEFAULT_MODEL;
        this._client = null;
        this._lsEntry = null;
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;
        this._lsEntry = await ensureLanguageServer(this.lsBinaryPath, this.apiServerUrl);
        this._client = new WindsurfClient(this.apiKey, this._lsEntry.port, this._lsEntry.csrfToken);
        await this._client.warmupCascade();
        this.isInitialized = true;
        log.info(`WindsurfClaudeApiService initialized (port=${this._lsEntry.port}, key=${this.apiKey.slice(0, 8)}...)`);
    }

    /** Resolve model name → { modelEnum, modelUid } */
    _resolveModelInfo(modelName) {
        const key = resolveModel(modelName || this.defaultModel) || this.defaultModel;
        const info = getModelInfo(key);
        return {
            modelKey: key,
            modelEnum: info?.enumValue || 0,
            modelUid: info?.modelUid || null,
        };
    }

    /** Build messages array for cascadeChat, injecting top-level system prompt if present */
    _prepareMessages(requestBody) {
        const msgs = Array.isArray(requestBody.messages) ? [...requestBody.messages] : [];
        // Anthropic Messages API puts system prompt in requestBody.system, not in messages[]
        if (requestBody.system && typeof requestBody.system === 'string' && requestBody.system.trim()) {
            // Only prepend if no system message already exists
            if (!msgs.some(m => m.role === 'system')) {
                msgs.unshift({ role: 'system', content: requestBody.system });
            }
        } else if (Array.isArray(requestBody.system) && requestBody.system.length > 0) {
            // system can also be an array of content blocks
            const sysText = requestBody.system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n').trim();
            if (sysText && !msgs.some(m => m.role === 'system')) {
                msgs.unshift({ role: 'system', content: sysText });
            }
        }
        return msgs;
    }

    /** Extract tool preamble + userCwd from Claude-format requestBody.tools (if present) */
    _extractToolPreamble(requestBody, messages) {
        const tools = requestBody?.tools;
        if (!Array.isArray(tools) || tools.length === 0) return { preamble: null, userCwd: null };
        const callerEnv = extractCallerEnvironment(messages || []);
        if (callerEnv) log.info(`[WS] callerEnv lifted: ${callerEnv.replace(/\n/g, ' | ')}`);
        // Extract just the CWD value for path sanitization
        const cwdMatch = callerEnv.match(/- Working directory:\s*(.+)/);
        const userCwd = cwdMatch ? cwdMatch[1].trim() : null;
        if (userCwd) log.info(`[WS] userCwd for path sanitization: ${userCwd}`);
        return { preamble: buildToolPreambleFromClaudeTools(tools, callerEnv), userCwd };
    }

    /**
     * Non-streaming: collect all chunks and return a Claude-format message response.
     */
    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        const { modelKey, modelEnum, modelUid } = this._resolveModelInfo(model);
        const messages = this._prepareMessages(requestBody);
        const { preamble: toolPreamble, userCwd } = this._extractToolPreamble(requestBody, messages);

        let fullText = '';
        let thinkingText = '';

        const chunks = await new Promise((resolve, reject) => {
            this._client.cascadeChat(messages, modelEnum, modelUid, {
                toolPreamble,
                onChunk: (chunk) => {
                    if (chunk.text) fullText += chunk.text;
                    if (chunk.thinking) thinkingText += chunk.thinking;
                },
                onEnd: resolve,
                onError: reject,
            });
        });
        const usage = wsUsageToClaudeUsage(chunks?.usage);

        const id = `msg_ws${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const content = [];
        if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText });

        // Parse tool calls from text (sanitize server workspace paths → userCwd)
        const toolCalls = toolPreamble ? parseToolCallsFromText(fullText, userCwd) : [];
        const rawClean = toolCalls.length > 0 ? extractPreToolText(fullText) : fullText;
        const cleanText = userCwd ? sanitizeWorkspacePaths(rawClean, userCwd) : rawClean;
        if (cleanText) content.push({ type: 'text', text: cleanText });
        for (const tc of toolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        }
        if (content.length === 0) content.push({ type: 'text', text: '' });

        return {
            id,
            type: 'message',
            role: 'assistant',
            content,
            model: modelKey,
            stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage,
        };
    }

    /**
     * Streaming: yield Claude-format SSE events (Anthropic Messages API format).
     */
    async *generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        const { modelKey, modelEnum, modelUid } = this._resolveModelInfo(model);
        const messages = this._prepareMessages(requestBody);
        const { preamble: toolPreamble, userCwd } = this._extractToolPreamble(requestBody, messages);

        const id = `msg_ws${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        log.info(`[WS-Stream] model=${modelKey} enum=${modelEnum} uid=${modelUid} tools=${toolPreamble ? `yes(${requestBody?.tools?.length})` : 'no'} msgs=${messages.length}`);

        // Buffer all content events so message_start can carry real usage (cache tokens).
        // cascadeChat is effectively non-streaming (it collects internally before firing onEnd),
        // so awaiting it before yielding any SSE events costs no real latency.
        const bufferedEvents = [];
        let accText = '';
        let error = null;
        let chatResult = null;

        try {
            chatResult = await this._client.cascadeChat(messages, modelEnum, modelUid, {
                toolPreamble,
                onChunk: (chunk) => {
                    if (chunk.text) {
                        accText += chunk.text;
                        if (!toolPreamble) {
                            bufferedEvents.push({ type: 'content_block_delta', index: 0,
                                delta: { type: 'text_delta', text: chunk.text } });
                        }
                    }
                    if (chunk.thinking) {
                        bufferedEvents.push({ type: 'content_block_delta', index: 0,
                            delta: { type: 'thinking_delta', thinking: chunk.thinking } });
                    }
                    // cascade_native tool call — accumulate as a tool_call marker in text
                    if (chunk.nativeToolCall) {
                        const tc = chunk.nativeToolCall;
                        const args = (() => { try { return JSON.parse(tc.argumentsJson || '{}'); } catch { return {}; } })();
                        const marker = `<tool_call>${JSON.stringify({ name: tc.name, arguments: args })}</tool_call>`;
                        log.info(`[WS-Stream] nativeToolCall: ${tc.name}`);
                        accText += marker;
                    }
                },
                onEnd: () => { log.info(`[WS-Stream] cascadeChat onEnd, accText.length=${accText.length}`); },
                onError: (err) => { log.info(`[WS-Stream] cascadeChat onError: ${err?.message || err}`); error = err; },
            });
        } catch (e) {
            error = e;
        }

        if (error) {
            log.info(`[WS-Stream] throwing cascadeChat error: ${error?.message || error}`);
            throw error;
        }

        // Real token counts — now available before any SSE event is emitted
        const wsUsage = chatResult?.usage ?? null;
        const usageForDelta = wsUsageToClaudeUsage(wsUsage);
        log.info(`[WS-Stream] usage: in=${usageForDelta.input_tokens} out=${usageForDelta.output_tokens} cache_r=${usageForDelta.cache_read_input_tokens} cache_w=${usageForDelta.cache_creation_input_tokens}`);

        // Emit message_start with REAL usage so billing relays (new-api etc.) see cache tokens
        yield {
            type: 'message_start',
            message: { id, type: 'message', role: 'assistant', content: [], model: modelKey,
                usage: {
                    input_tokens: usageForDelta.input_tokens,
                    output_tokens: 0,
                    cache_creation_input_tokens: usageForDelta.cache_creation_input_tokens,
                    cache_read_input_tokens: usageForDelta.cache_read_input_tokens,
                } },
        };
        yield { type: 'ping' };

        if (toolPreamble) {
            // ── Tool mode: parse accumulated text, emit blocks in correct order ──
            const toolCalls = parseToolCallsFromText(accText, userCwd);
            log.info(`[WS-Stream] accText.length=${accText.length} toolCalls=${toolCalls.length}`);

            let blockIndex = 0;
            let stopReason = 'end_turn';

            if (toolCalls.length > 0) {
                // Has tool calls: emit text BEFORE first <tool_call> (if any), then tool_use blocks
                stopReason = 'tool_use';
                const preText = userCwd ? sanitizeWorkspacePaths(extractPreToolText(accText), userCwd) : extractPreToolText(accText);
                if (preText) {
                    yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } };
                    yield { type: 'content_block_delta', index: blockIndex,
                        delta: { type: 'text_delta', text: preText } };
                    yield { type: 'content_block_stop', index: blockIndex };
                    blockIndex++;
                }
                for (const tc of toolCalls) {
                    yield { type: 'content_block_start', index: blockIndex,
                        content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } };
                    yield { type: 'content_block_delta', index: blockIndex,
                        delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) } };
                    yield { type: 'content_block_stop', index: blockIndex };
                    blockIndex++;
                }
            } else {
                // No tool calls — emit full text as a single text block
                const safeFullText = userCwd ? sanitizeWorkspacePaths(accText, userCwd) : accText;
                yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } };
                if (safeFullText) {
                    yield { type: 'content_block_delta', index: blockIndex,
                        delta: { type: 'text_delta', text: safeFullText } };
                }
                yield { type: 'content_block_stop', index: blockIndex };
            }

            yield { type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: usageForDelta };
            yield { type: 'message_stop' };
        } else {
            // ── No-tool mode: emit content block from buffered events ──
            log.info(`[WS-Stream] accText.length=${accText.length} (no-tool mode)`);
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            for (const event of bufferedEvents) yield event;
            yield { type: 'content_block_stop', index: 0 };
            yield { type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: usageForDelta };
            yield { type: 'message_stop' };
        }
    }

    async getUsageLimits() {
        if (!this.apiKey) throw new Error('WINDSURF_API_KEY not configured');
        const { getUserStatus } = await import('./windsurf-api.js');
        return getUserStatus(this.apiKey, null);
    }

    async listModels() {
        const { listModels: wsListModels } = await import('./windsurf-models.js');
        return wsListModels();
    }

    async refreshToken() {
        return Promise.resolve();
    }

    async dispose() {
        this._client = null;
        this._lsEntry = null;
        this.isInitialized = false;
    }
}
