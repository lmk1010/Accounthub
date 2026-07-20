export const XAI_IMAGE_MODELS = Object.freeze([
    'grok-imagine-image',
    'grok-imagine-image-quality'
]);

export const XAI_VIDEO_MODELS = Object.freeze([
    'grok-imagine-video',
    'grok-imagine-video-1.5',
    'grok-imagine-video-1.5-preview'
]);

export const XAI_DEFAULT_VIDEO_MODEL = XAI_VIDEO_MODELS[0];

const XAI_VIDEO_MODEL_SET = new Set(XAI_VIDEO_MODELS);
const XAI_VIDEO_DEFAULT_SECONDS = '4';
const XAI_VIDEO_DEFAULT_SIZE = '720x1280';
const XAI_VIDEO_DEFAULT_RESOLUTION = '720p';
const XAI_VIDEO_MAX_REFERENCES = 7;

function cloneJson(value) {
    if (!value || typeof value !== 'object') return {};
    return JSON.parse(JSON.stringify(value));
}

function modelParts(model) {
    const normalized = String(model || '').trim();
    const separator = normalized.lastIndexOf('/');
    if (separator < 0 || separator === normalized.length - 1) {
        return { prefix: '', baseModel: normalized };
    }
    return {
        prefix: normalized.slice(0, separator).trim().toLowerCase(),
        baseModel: normalized.slice(separator + 1).trim()
    };
}

export function canonicalXaiVideoModel(model) {
    const { prefix, baseModel } = modelParts(model || XAI_DEFAULT_VIDEO_MODEL);
    const normalized = baseModel.toLowerCase();
    if (!XAI_VIDEO_MODEL_SET.has(normalized)) {
        throw new Error(`Unsupported xAI video model: ${baseModel || model}`);
    }
    if (prefix && !['xai', 'x-ai', 'grok'].includes(prefix)) {
        throw new Error(`Unsupported xAI video model prefix: ${prefix}`);
    }
    return normalized;
}

export function extractXaiVideoId(payload) {
    return String(payload?.request_id || payload?.id || '').trim();
}

function normalizeSeconds(rawValue) {
    const raw = String(rawValue ?? XAI_VIDEO_DEFAULT_SECONDS).trim() || XAI_VIDEO_DEFAULT_SECONDS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        throw new Error('seconds must be an integer');
    }
    return String(Math.min(15, Math.max(1, parsed)));
}

function normalizeSize(rawValue) {
    const size = String(rawValue || XAI_VIDEO_DEFAULT_SIZE).trim() || XAI_VIDEO_DEFAULT_SIZE;
    switch (size) {
        case '720x1280':
        case '1024x1792':
            return { size, aspectRatio: '9:16', resolution: XAI_VIDEO_DEFAULT_RESOLUTION };
        case '1280x720':
        case '1792x1024':
            return { size, aspectRatio: '16:9', resolution: XAI_VIDEO_DEFAULT_RESOLUTION };
        default:
            throw new Error('size must be one of 720x1280, 1280x720, 1024x1792, or 1792x1024');
    }
}

function normalizeAspectRatio(rawValue, fallback) {
    const normalized = String(rawValue || '').trim().toLowerCase();
    const aliases = {
        square: '1:1',
        landscape: '16:9',
        portrait: '9:16'
    };
    const value = aliases[normalized] || normalized;
    return ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].includes(value)
        ? value
        : fallback;
}

function normalizeResolution(rawValue, fallback) {
    const normalized = String(rawValue || '').trim().toLowerCase();
    return ['480p', '720p'].includes(normalized) ? normalized : fallback;
}

function imageUrlFromValue(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    const nestedImageUrl = value.image_url && typeof value.image_url === 'object'
        ? value.image_url.url
        : value.image_url;
    return String(value.url || nestedImageUrl || value.imageUrl || '').trim();
}

function resolveInputImageUrl(body) {
    const inputReference = body?.input_reference;
    if (inputReference && typeof inputReference === 'object') {
        const imageUrl = String(inputReference.image_url || '').trim();
        const fileId = String(inputReference.file_id || '').trim();
        if (imageUrl && fileId) {
            throw new Error('input_reference must provide exactly one of image_url or file_id');
        }
        if (fileId) {
            throw new Error('input_reference.file_id is not supported for xAI video generation');
        }
        if (imageUrl) return imageUrl;
    }

    const images = Array.isArray(body?.image) ? body.image : [body?.image];
    for (const image of images) {
        const imageUrl = imageUrlFromValue(image);
        if (imageUrl) return imageUrl;
    }
    return String(body?.image_url || '').trim();
}

function collectReferenceImages(body) {
    const values = [];
    for (const candidate of [body?.reference_images, body?.reference_image_urls]) {
        const list = Array.isArray(candidate)
            ? candidate
            : (typeof candidate === 'string' ? candidate.split(',') : []);
        for (const item of list) {
            const url = imageUrlFromValue(item);
            if (url) values.push(url);
        }
    }
    return values;
}

export function buildXaiVideoCreateRequest(requestBody = {}) {
    const body = cloneJson(requestBody);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new Error('prompt is required');

    const model = canonicalXaiVideoModel(body.model || XAI_DEFAULT_VIDEO_MODEL);
    let seconds = normalizeSeconds(body.seconds ?? body.duration);
    const sizeOptions = normalizeSize(body.size);
    const aspectRatio = normalizeAspectRatio(body.aspect_ratio, sizeOptions.aspectRatio);
    const resolution = normalizeResolution(body.resolution, sizeOptions.resolution);
    const imageUrl = resolveInputImageUrl(body);
    const referenceImages = collectReferenceImages(body);

    if (referenceImages.length > XAI_VIDEO_MAX_REFERENCES) {
        throw new Error(`reference_images supports at most ${XAI_VIDEO_MAX_REFERENCES} images`);
    }
    if (imageUrl && referenceImages.length > 0) {
        throw new Error('image and reference_images cannot be combined');
    }
    if (referenceImages.length > 0 && Number(seconds) > 10) {
        seconds = '10';
    }

    const upstreamBody = {
        model,
        prompt,
        duration: Number(seconds),
        aspect_ratio: aspectRatio,
        resolution
    };
    if (imageUrl) upstreamBody.image = { url: imageUrl };
    if (referenceImages.length > 0) {
        upstreamBody.reference_images = referenceImages.map(url => ({ url }));
    }

    return {
        body: upstreamBody,
        metadata: {
            model,
            prompt,
            seconds,
            size: sizeOptions.size,
            createdAt: Math.floor(Date.now() / 1000)
        }
    };
}

export function buildXaiVideoRemixRequest(requestBody = {}, sourcePayload = {}, sourceVideoId = '', fallbackModel = XAI_DEFAULT_VIDEO_MODEL) {
    const body = cloneJson(requestBody);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new Error('prompt is required');

    const model = canonicalXaiVideoModel(body.model || sourcePayload.model || fallbackModel);
    const upstreamBody = {
        model,
        prompt,
        video: { url: extractXaiVideoUrl(sourcePayload) }
    };

    if (body.seconds !== undefined || body.duration !== undefined) {
        upstreamBody.duration = Number(normalizeSeconds(body.seconds ?? body.duration));
    }
    if (body.size !== undefined) {
        const sizeOptions = normalizeSize(body.size);
        upstreamBody.aspect_ratio = sizeOptions.aspectRatio;
        upstreamBody.resolution = sizeOptions.resolution;
    }
    if (body.aspect_ratio !== undefined) {
        upstreamBody.aspect_ratio = normalizeAspectRatio(body.aspect_ratio, '9:16');
    }
    if (body.resolution !== undefined) {
        upstreamBody.resolution = normalizeResolution(body.resolution, XAI_VIDEO_DEFAULT_RESOLUTION);
    }

    const sourceDuration = sourcePayload.video?.duration ?? sourcePayload.seconds;
    const seconds = normalizeSeconds(body.seconds ?? body.duration ?? sourceDuration ?? XAI_VIDEO_DEFAULT_SECONDS);
    const size = String(body.size || sourcePayload.size || XAI_VIDEO_DEFAULT_SIZE).trim() || XAI_VIDEO_DEFAULT_SIZE;

    return {
        body: upstreamBody,
        metadata: {
            model,
            prompt,
            seconds,
            size,
            sourceVideoId: String(sourceVideoId || '').trim(),
            createdAt: Math.floor(Date.now() / 1000)
        }
    };
}

export function normalizeXaiVideoNativeRequest(requestBody = {}, fallbackModel = XAI_DEFAULT_VIDEO_MODEL) {
    const body = cloneJson(requestBody);
    body.model = canonicalXaiVideoModel(body.model || fallbackModel);
    return body;
}

export function normalizeOpenAIVideoStatus(status) {
    switch (String(status || '').trim().toLowerCase()) {
        case 'queued':
        case 'pending':
            return 'queued';
        case 'in_progress':
        case 'processing':
        case 'running':
            return 'in_progress';
        case 'completed':
        case 'done':
        case 'succeeded':
        case 'success':
            return 'completed';
        case 'failed':
        case 'error':
        case 'expired':
        case 'cancelled':
        case 'canceled':
            return 'failed';
        default:
            return '';
    }
}

export function buildOpenAIVideoCreateResponse(payload = {}, metadata = {}) {
    const id = extractXaiVideoId(payload);
    if (!id) throw new Error('xAI video response did not include request_id');

    const response = {
        id,
        object: 'video',
        model: metadata.model || XAI_DEFAULT_VIDEO_MODEL,
        prompt: metadata.prompt || '',
        seconds: String(metadata.seconds || XAI_VIDEO_DEFAULT_SECONDS),
        size: metadata.size || XAI_VIDEO_DEFAULT_SIZE,
        created_at: metadata.createdAt || Math.floor(Date.now() / 1000),
        status: normalizeOpenAIVideoStatus(payload.status) || 'queued',
        progress: Number.isFinite(Number(payload.progress)) ? Number(payload.progress) : 0
    };
    return response;
}

export function buildOpenAIVideoRetrieveResponse(videoId, payload = {}, fallbackModel = XAI_DEFAULT_VIDEO_MODEL) {
    const id = String(videoId || extractXaiVideoId(payload)).trim();
    if (!id) throw new Error('video_id is required');

    const response = {
        id,
        object: 'video',
        model: String(payload.model || fallbackModel).trim() || fallbackModel
    };
    for (const field of ['created_at', 'completed_at', 'expires_at', 'prompt', 'remixed_from_video_id', 'size']) {
        if (payload[field] !== undefined && payload[field] !== null) response[field] = payload[field];
    }

    const status = normalizeOpenAIVideoStatus(payload.status);
    if (status) response.status = status;
    if (payload.progress !== undefined && payload.progress !== null) {
        response.progress = Number(payload.progress);
    }
    if (payload.seconds !== undefined && payload.seconds !== null) {
        response.seconds = String(payload.seconds);
    } else if (payload.video?.duration !== undefined && payload.video?.duration !== null) {
        response.seconds = String(payload.video.duration);
    }

    const videoUrl = String(payload.video?.url || payload.video_url || '').trim();
    if (videoUrl) response.video_url = videoUrl;

    if (payload.error) {
        response.status = 'failed';
        response.progress ??= 0;
        if (typeof payload.error === 'object') {
            response.error = {
                code: String(payload.error.code || payload.code || 'video_generation_failed'),
                message: String(payload.error.message || payload.code || 'Video generation failed')
            };
        } else {
            response.error = {
                code: String(payload.code || 'video_generation_failed'),
                message: String(payload.error)
            };
        }
    } else if (payload.code) {
        response.status = 'failed';
        response.progress ??= 0;
        response.error = {
            code: String(payload.code),
            message: String(payload.code)
        };
    }
    return response;
}

export function extractXaiVideoUrl(payload = {}) {
    const rawUrl = String(payload.video?.url || payload.video_url || '').trim();
    if (!rawUrl) throw new Error('xAI video response did not include video.url');
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('xAI video response included invalid video.url');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error('xAI video response included invalid video.url');
    }
    return rawUrl;
}
