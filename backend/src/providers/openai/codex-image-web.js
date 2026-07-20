import * as crypto from 'crypto';
import { getCodexChannelDefaults } from '../../services/codex-channel-config-cache.js';

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROWSER_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';
const BROWSER_CLIENT_BUILD = '5955942';
const BROWSER_CLIENT_VERSION = 'prod-be885abbfcfe7b1f511e88b3003d9ee44757fbad';
const MAX_POW_ATTEMPTS = 500000;
const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
const DEFAULT_IMAGE_CONTROLLER_MODEL = 'gpt-5.4-mini';
const DEFAULT_UPSTREAM_MODEL = 'gpt-5-3';
const IMAGE_GENERATION_MODE_WEB = 'web-conversation';
const IMAGE_GENERATION_MODE_RESPONSES = 'responses-tool';
const IMAGE_CORES = [16, 24, 32];
const IMAGE_NAV_KEYS = [
    'webdriver−false',
    'vendor−Google Inc.',
    'cookieEnabled−true',
    'pdfViewerEnabled−true',
    'hardwareConcurrency−32',
    'language−zh-CN',
    'mimeTypes−[object MimeTypeArray]',
    'userAgentData−[object NavigatorUAData]'
];
const IMAGE_WINDOW_KEYS = [
    'innerWidth',
    'innerHeight',
    'devicePixelRatio',
    'screen',
    'chrome',
    'location',
    'history',
    'navigator'
];

function randomChoice(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function buildBrowserHeaders(service, deviceId, extraHeaders = {}) {
    return {
        Authorization: `Bearer ${service.credentials.accessToken}`,
        'ChatGPT-Account-ID': service.credentials.accountId,
        'User-Agent': BROWSER_USER_AGENT,
        Accept: '*/*',
        'Accept-Language': BROWSER_ACCEPT_LANGUAGE,
        'oai-language': 'zh-CN',
        Origin: service.baseUrl,
        Referer: `${service.baseUrl}/`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'sec-ch-ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'oai-device-id': deviceId,
        Cookie: `oai-did=${deviceId}`,
        ...extraHeaders
    };
}

function createImageError(message, status = 500, extra = {}) {
    const error = new Error(message || 'Image generation failed');
    error.status = status;
    error.statusCode = status;
    Object.assign(error, extra);
    return error;
}

function markImageQuotaCooldown(error, status, model, delayMs = 3600000) {
    const resetAtMs = Date.now() + Math.max(5000, Number(delayMs) || 3600000);
    error.status = status;
    error.statusCode = status;
    error.skipErrorCount = true;
    error.shouldSwitchCredential = true;
    error.isQuotaCooldown = true;
    error.rateLimitedModel = model || null;
    error.quotaResetTime = new Date(resetAtMs).toISOString();
    error.quotaResetDelayMs = Math.max(0, resetAtMs - Date.now());
    error.quotaResetFormatted = error.quotaResetTime;
    return error;
}

function markImageAuthError(error, status, detail = '') {
    error.status = status;
    error.statusCode = status;
    error.skipErrorCount = true;
    error.shouldSwitchCredential = true;
    error.isAuthCredentialIssue = true;
    error.shouldDeleteCredential = status === 401;
    if (detail) {
        error.message = detail;
    }
    return error;
}

function stringifyPayload(payload) {
    if (payload === null || payload === undefined) return '';
    if (typeof payload === 'string') return payload;
    if (Buffer.isBuffer(payload)) return payload.toString('utf8');
    try {
        return JSON.stringify(payload);
    } catch {
        return String(payload);
    }
}

function parseMaybeJson(payload) {
    if (!payload || typeof payload !== 'string') return null;
    try {
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

function looksLikeQuotaMessage(message) {
    const text = String(message || '').toLowerCase();
    return /quota|rate.?limit|too.?many|usage.?limit|image.*limit|credit|try again later|图片.*额度|图像.*额度|生成.*次数|稍后再试/.test(text);
}

function looksLikeCapabilityMessage(message) {
    const text = String(message || '').toLowerCase();
    return /upgrade|plus|pro|available only|not available.*plan|image generation is disabled|workspace|当前套餐|升级|不可用/.test(text);
}

function looksLikeAuthMessage(message) {
    const text = String(message || '').toLowerCase();
    return /token_invalidated|token_revoked|invalidated oauth token|authentication token has been invalidated|unauthorized|invalid token|revoked/.test(text);
}

function buildPowConfig() {
    return [
        randomChoice([3000, 4000, 3760, 4160]),
        new Date().toUTCString().replace('GMT', 'GMT-0500 (Eastern Standard Time)'),
        4294705152,
        0,
        BROWSER_USER_AGENT,
        'https://chatgpt.com/backend-api/sentinel/sdk.js',
        '',
        'en-US',
        'en-US,zh-CN,en,zh',
        0,
        randomChoice(IMAGE_NAV_KEYS),
        'location',
        randomChoice(IMAGE_WINDOW_KEYS),
        Math.round(Math.random() * 5000),
        crypto.randomUUID(),
        '',
        randomChoice(IMAGE_CORES),
        Date.now() - Math.round(Math.random() * 1000)
    ];
}

function generatePowAnswer(seed, difficulty, config) {
    const diffLen = String(difficulty || '').length;
    const seedBuffer = Buffer.from(String(seed || ''), 'utf8');
    const target = Buffer.from(String(difficulty || ''), 'hex');
    const prefix1 = Buffer.from(`${JSON.stringify(config.slice(0, 3)).slice(0, -1)},`, 'utf8');
    const prefix2 = Buffer.from(`,${JSON.stringify(config.slice(4, 9)).slice(1, -1)},`, 'utf8');
    const prefix3 = Buffer.from(`,${JSON.stringify(config.slice(10)).slice(1)}`, 'utf8');

    for (let attempt = 0; attempt < MAX_POW_ATTEMPTS; attempt += 1) {
        const encoded = Buffer.from(
            Buffer.concat([
                prefix1,
                Buffer.from(String(attempt), 'utf8'),
                prefix2,
                Buffer.from(String(attempt >> 1), 'utf8'),
                prefix3
            ])
        ).toString('base64');
        const digest = crypto.createHash('sha3-512').update(seedBuffer).update(encoded).digest();
        if (digest.subarray(0, diffLen).compare(target) <= 0) {
            return encoded;
        }
    }

    return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${Buffer.from(`"${seed}"`, 'utf8').toString('base64')}`;
}

function getRequirementsToken() {
    return `gAAAAAC${generatePowAnswer(String(Math.random()), '0fffff', buildPowConfig())}`;
}

function getProofToken(seed, difficulty) {
    return `gAAAAAB${generatePowAnswer(seed, difficulty, buildPowConfig())}`;
}

function extractInlineFileIds(payload, fileIds) {
    for (const [prefix, storedPrefix] of [['file-service://', ''], ['sediment://', 'sed:']]) {
        let cursor = 0;
        while (cursor < payload.length) {
            const start = payload.indexOf(prefix, cursor);
            if (start < 0) break;
            cursor = start + prefix.length;
            let end = cursor;
            while (end < payload.length && /[A-Za-z0-9_-]/.test(payload[end])) {
                end += 1;
            }
            const value = `${storedPrefix}${payload.slice(cursor, end)}`;
            if (value && !fileIds.includes(value)) {
                fileIds.push(value);
            }
            cursor = end;
        }
    }
}

async function parseConversationSse(stream) {
    let buffer = '';
    const fileIds = [];
    const textParts = [];
    let conversationId = '';

    for await (const chunk of stream) {
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf('\n');
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            extractInlineFileIds(payload, fileIds);
            const obj = parseMaybeJson(payload);
            if (!obj || typeof obj !== 'object') continue;
            conversationId = String(obj.conversation_id || obj?.v?.conversation_id || conversationId || '');
            const content = obj?.message?.content;
            const parts = Array.isArray(content?.parts) ? content.parts : [];
            if (content?.content_type === 'text' && typeof parts[0] === 'string') {
                textParts.push(parts[0]);
            }
        }
    }

    return {
        conversationId,
        fileIds,
        text: textParts.join('').trim()
    };
}

function extractImageIdsFromMapping(mapping) {
    const fileIds = [];
    for (const node of Object.values(mapping || {})) {
        const message = node?.message || {};
        if (message?.author?.role !== 'tool') continue;
        if (message?.metadata?.async_task_type !== 'image_gen') continue;
        const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
        for (const part of parts) {
            const pointer = String(part?.asset_pointer || '');
            if (pointer.startsWith('file-service://')) {
                const value = pointer.replace('file-service://', '');
                if (value && !fileIds.includes(value)) fileIds.push(value);
            } else if (pointer.startsWith('sediment://')) {
                const value = `sed:${pointer.replace('sediment://', '')}`;
                if (value && !fileIds.includes(value)) fileIds.push(value);
            }
        }
    }
    return fileIds;
}

function resolveUpstreamImageModel(requestedModel) {
    const model = String(requestedModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
    if (model === 'gpt-image-1') return 'auto';
    if (model === 'gpt-image-2') return DEFAULT_UPSTREAM_MODEL;
    return model;
}

function decodeJwtPayload(token) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    try {
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
        return JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

function isFreeImageAccount(service) {
    const tokenPayload = decodeJwtPayload(service?.credentials?.accessToken);
    const authClaims = tokenPayload?.['https://api.openai.com/auth'];
    const planType = String(authClaims?.chatgpt_plan_type || '').trim().toLowerCase();
    const subscriptionTitle = String(
        service?.config?.subscriptionTitle
        || service?.credentials?.subscriptionTitle
        || ''
    ).trim().toLowerCase();
    return planType === 'free' || subscriptionTitle.includes('free');
}

function resolveConversationImageModel(service, requestedModel) {
    const model = String(requestedModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
    if (model === 'gpt-image-1') return 'auto';
    if (model === 'gpt-image-2') {
        return isFreeImageAccount(service) ? 'auto' : DEFAULT_UPSTREAM_MODEL;
    }
    return resolveUpstreamImageModel(model);
}

function buildPromptWithSize(prompt, size) {
    const normalizedPrompt = String(prompt || '').trim();
    const normalizedSize = String(size || '').trim().toLowerCase();
    const match = normalizedSize.match(/^(\d+)x(\d+)$/);
    if (!match) return normalizedPrompt;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return normalizedPrompt;
    }
    let hint = `${normalizedSize} aspect ratio`;
    if (width === height) hint = `square ${normalizedSize} aspect ratio`;
    else if (width > height) hint = `landscape ${normalizedSize} aspect ratio`;
    else hint = `portrait ${normalizedSize} aspect ratio`;
    return `${normalizedPrompt}\n\nRender with a ${hint}.`;
}

async function bootstrapSession(service, requestContext) {
    const deviceId = crypto.randomUUID();
    await service.axiosInstance.get('/', {
        headers: buildBrowserHeaders(service, deviceId),
        signal: requestContext?.abortSignal
    }).catch(() => null);
    return deviceId;
}

async function getChatRequirements(service, deviceId, requestContext) {
    const response = await service.axiosInstance.post('/backend-api/sentinel/chat-requirements', { p: getRequirementsToken() }, {
        headers: buildBrowserHeaders(service, deviceId, { 'Content-Type': 'application/json' }),
        signal: requestContext?.abortSignal
    });
    return response?.data || {};
}

function buildClientContextualInfo() {
    return {
        is_dark_mode: false,
        time_since_loaded: Math.floor(Math.random() * 451) + 50,
        page_height: Math.floor(Math.random() * 501) + 500,
        page_width: Math.floor(Math.random() * 1001) + 1000,
        pixel_ratio: 1.2,
        screen_height: Math.floor(Math.random() * 401) + 800,
        screen_width: Math.floor(Math.random() * 1001) + 1200
    };
}

async function sendConversation(service, deviceId, requirementsToken, proofToken, prompt, model, requestContext) {
    return service.axiosInstance.post('/backend-api/conversation', {
        action: 'next',
        messages: [{ id: crypto.randomUUID(), author: { role: 'user' }, content: { content_type: 'text', parts: [prompt] }, metadata: { attachments: [] } }],
        parent_message_id: crypto.randomUUID(),
        model,
        history_and_training_disabled: false,
        timezone_offset_min: -480,
        timezone: 'America/Los_Angeles',
        conversation_mode: { kind: 'primary_assistant' },
        conversation_origin: null,
        force_paragen: false,
        force_paragen_model_slug: '',
        force_rate_limit: false,
        force_use_sse: true,
        paragen_cot_summary_display_override: 'allow',
        paragen_stream_type_override: null,
        reset_rate_limits: false,
        suggestions: [],
        supported_encodings: [],
        system_hints: ['picture_v2'],
        variant_purpose: 'comparison_implicit',
        websocket_request_id: crypto.randomUUID(),
        client_contextual_info: buildClientContextualInfo()
    }, {
        headers: buildBrowserHeaders(service, deviceId, {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            'oai-client-build-number': BROWSER_CLIENT_BUILD,
            'oai-client-version': BROWSER_CLIENT_VERSION,
            'openai-sentinel-chat-requirements-token': requirementsToken,
            ...(proofToken ? { 'openai-sentinel-proof-token': proofToken } : {})
        }),
        responseType: 'stream',
        signal: requestContext?.abortSignal,
        timeout: 180000
    });
}

async function pollConversationImageIds(service, deviceId, conversationId, requestContext) {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        const response = await service.axiosInstance.get(`/backend-api/conversation/${conversationId}`, {
            headers: buildBrowserHeaders(service, deviceId),
            signal: requestContext?.abortSignal
        }).catch(() => null);
        const fileIds = extractImageIdsFromMapping(response?.data?.mapping || {});
        if (fileIds.length > 0) return fileIds;
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    return [];
}

async function getDownloadUrl(service, deviceId, conversationId, fileId, requestContext) {
    const isSediment = fileId.startsWith('sed:');
    const rawId = isSediment ? fileId.slice(4) : fileId;
    const endpoint = isSediment
        ? `/backend-api/conversation/${conversationId}/attachment/${rawId}/download`
        : `/backend-api/files/${rawId}/download`;
    const response = await service.axiosInstance.get(endpoint, {
        headers: buildBrowserHeaders(service, deviceId),
        signal: requestContext?.abortSignal
    });
    return String(response?.data?.download_url || '').trim();
}

async function downloadImage(service, downloadUrl, requestContext) {
    const response = await service.axiosInstance.get(downloadUrl, {
        headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: '*/*' },
        responseType: 'arraybuffer',
        signal: requestContext?.abortSignal,
        timeout: 180000
    });
    return Buffer.from(response.data);
}

function normalizeImageError(error, requestedModel) {
    const status = Number(error?.response?.status || error?.status || error?.statusCode || 500);
    const payload = stringifyPayload(error?.response?.data);
    const message = `${error?.message || ''} ${payload}`.trim();

    if (looksLikeAuthMessage(message) || status === 401) {
        return markImageAuthError(error, status, message || `Codex image auth failed (${status})`);
    }
    if (looksLikeCapabilityMessage(message)) {
        return markImageQuotaCooldown(error, status, requestedModel, 6 * 3600000);
    }
    if (looksLikeQuotaMessage(message) || status === 429 || status === 402) {
        return markImageQuotaCooldown(error, status, requestedModel, 3600000);
    }
    if (status >= 500 || !Number.isFinite(status)) {
        error.skipErrorCount = true;
        error.shouldSwitchCredential = true;
    }
    error.status = status;
    error.statusCode = status;
    return error;
}

function mimeTypeFromOutputFormat(outputFormat) {
    const normalized = String(outputFormat || '').trim().toLowerCase();
    if (!normalized) return 'image/png';
    if (normalized.includes('/')) return normalized;
    if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
    if (normalized === 'webp') return 'image/webp';
    return 'image/png';
}

function parseImageIntegerField(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.trunc(parsed);
}

function buildImageGenerationTool(requestBody) {
    const requestedModel = String(requestBody?.model || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
    const tool = {
        type: 'image_generation',
        action: 'generate',
        model: requestedModel
    };

    for (const field of ['size', 'quality', 'background', 'output_format', 'moderation']) {
        const value = String(requestBody?.[field] || '').trim();
        if (value) tool[field] = value;
    }

    const outputCompression = parseImageIntegerField(requestBody?.output_compression);
    if (outputCompression !== null) tool.output_compression = outputCompression;

    const partialImages = parseImageIntegerField(requestBody?.partial_images);
    if (partialImages !== null) tool.partial_images = partialImages;

    return tool;
}

function buildImageResponsesRequest(requestBody) {
    const prompt = String(requestBody?.prompt || '').trim();
    return {
        instructions: '',
        stream: true,
        reasoning: { effort: 'medium', summary: 'auto' },
        parallel_tool_calls: true,
        include: ['reasoning.encrypted_content'],
        model: DEFAULT_IMAGE_CONTROLLER_MODEL,
        store: false,
        tool_choice: { type: 'image_generation' },
        input: [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: prompt }]
        }],
        tools: [buildImageGenerationTool(requestBody)]
    };
}

function extractGeneratedImages(responsePayload) {
    const output = Array.isArray(responsePayload?.output) ? responsePayload.output : [];
    const results = [];

    for (const item of output) {
        if (!item || item.type !== 'image_generation_call') continue;
        const result = String(item.result || '').trim();
        if (!result) continue;
        results.push({
            result,
            revisedPrompt: String(item.revised_prompt || '').trim(),
            outputFormat: String(item.output_format || '').trim()
        });
    }

    return results;
}

export async function resolveCodexImageGenerationConfig() {
    try {
        const channelDefaults = await getCodexChannelDefaults();
        const mode = String(
            channelDefaults?.codexImageGenerationMode
            || (channelDefaults?.codexImageGenerationUseResponsesTool === true ? IMAGE_GENERATION_MODE_RESPONSES : '')
        ).trim().toLowerCase();
        return {
            enabled: channelDefaults?.codexImageGenerationEnabled !== false,
            mode: mode === IMAGE_GENERATION_MODE_WEB ? IMAGE_GENERATION_MODE_WEB : IMAGE_GENERATION_MODE_RESPONSES
        };
    } catch {
        return {
            enabled: true,
            mode: IMAGE_GENERATION_MODE_RESPONSES
        };
    }
}

async function generateCodexImageViaConversation(service, requestBody, requestContext = null) {
    const prompt = buildPromptWithSize(requestBody?.prompt, requestBody?.size);
    const requestedModel = String(requestBody?.model || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
    const responseFormat = String(requestBody?.response_format || 'b64_json').trim().toLowerCase() === 'url' ? 'url' : 'b64_json';

    await service.ensureValidCredentials();
    const deviceId = await bootstrapSession(service, requestContext);
    const requirements = await getChatRequirements(service, deviceId, requestContext);
    const requirementsToken = String(requirements?.token || '').trim();
    const proofToken = requirements?.proofofwork?.required
        ? getProofToken(String(requirements.proofofwork.seed || ''), String(requirements.proofofwork.difficulty || ''))
        : '';
    const upstreamModel = resolveConversationImageModel(service, requestedModel);
    const conversationResponse = await sendConversation(service, deviceId, requirementsToken, proofToken, prompt, upstreamModel, requestContext);
    const parsed = await parseConversationSse(conversationResponse.data);
    let fileIds = Array.isArray(parsed.fileIds) ? parsed.fileIds : [];
    if (parsed.conversationId && fileIds.length === 0) {
        fileIds = await pollConversationImageIds(service, deviceId, parsed.conversationId, requestContext);
    }
    if (!parsed.conversationId || fileIds.length === 0) {
        const upstreamMessage = parsed.text || 'No image returned from upstream';
        throw createImageError(upstreamMessage, 502);
    }
    const downloadUrl = await getDownloadUrl(service, deviceId, parsed.conversationId, String(fileIds[0]), requestContext);
    if (!downloadUrl) {
        throw createImageError('Failed to get image download url', 502);
    }
    const imageBuffer = responseFormat === 'b64_json'
        ? await downloadImage(service, downloadUrl, requestContext)
        : null;
    return {
        created: Math.floor(Date.now() / 1000),
        data: [responseFormat === 'url'
            ? { url: downloadUrl, revised_prompt: String(requestBody?.prompt || '').trim() }
            : { b64_json: imageBuffer.toString('base64'), revised_prompt: String(requestBody?.prompt || '').trim() }]
    };
}

async function generateCodexImageViaResponsesTool(service, requestBody, requestContext = null) {
    const requestedModel = String(requestBody?.model || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
    const responseFormat = String(requestBody?.response_format || 'b64_json').trim().toLowerCase() === 'url' ? 'url' : 'b64_json';
    const prompt = buildPromptWithSize(requestBody?.prompt, requestBody?.size);
    const response = await service.generateContent(DEFAULT_IMAGE_CONTROLLER_MODEL, buildImageResponsesRequest({
        ...requestBody,
        model: requestedModel,
        prompt
    }), requestContext && typeof requestContext === 'object' ? requestContext : null);
    const images = extractGeneratedImages(response);

    if (images.length === 0) {
        throw createImageError('No image returned from upstream', 502);
    }

    return {
        created: Number(response?.created_at || response?.created) || Math.floor(Date.now() / 1000),
        data: images.map(image => (responseFormat === 'url'
            ? {
                url: `data:${mimeTypeFromOutputFormat(image.outputFormat)};base64,${image.result}`,
                revised_prompt: image.revisedPrompt
            }
            : {
                b64_json: image.result,
                revised_prompt: image.revisedPrompt
            }))
    };
}

export async function generateCodexWebImage(service, requestBody, requestContext = null) {
    const requestedModel = String(requestBody?.model || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;

    try {
        const { enabled, mode } = await resolveCodexImageGenerationConfig();
        if (!enabled) {
            throw createImageError('openai-codex 渠道未开启图片生成功能，当前不提供 /v1/images/generations。', 400, {
                skipErrorCount: true,
                shouldSwitchCredential: false
            });
        }
        if (mode === IMAGE_GENERATION_MODE_RESPONSES) {
            return await generateCodexImageViaResponsesTool(service, requestBody, requestContext);
        }
        return await generateCodexImageViaConversation(service, requestBody, requestContext);
    } catch (error) {
        throw normalizeImageError(error, requestedModel);
    }
}
