import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildOpenAIVideoCreateResponse,
    buildOpenAIVideoRetrieveResponse,
    buildXaiVideoCreateRequest,
    buildXaiVideoRemixRequest,
    canonicalXaiVideoModel,
    extractXaiVideoUrl
} from '../src/providers/openai/xai-media.js';

test('converts an OpenAI video request into the xAI video protocol', () => {
    const prepared = buildXaiVideoCreateRequest({
        model: 'xai/grok-imagine-video-1.5-preview',
        prompt: 'Animate the skyline',
        seconds: '12',
        size: '1280x720',
        image_url: 'https://example.com/input.png'
    });

    assert.deepEqual(prepared.body, {
        model: 'grok-imagine-video-1.5-preview',
        prompt: 'Animate the skyline',
        duration: 12,
        aspect_ratio: '16:9',
        resolution: '720p',
        image: { url: 'https://example.com/input.png' }
    });
    assert.equal(prepared.metadata.seconds, '12');
    assert.equal(prepared.metadata.size, '1280x720');
});

test('limits reference video requests to ten seconds', () => {
    const prepared = buildXaiVideoCreateRequest({
        model: 'grok-imagine-video',
        prompt: 'Blend the references',
        seconds: 15,
        reference_image_urls: [
            'https://example.com/one.png',
            'https://example.com/two.png'
        ]
    });

    assert.equal(prepared.body.duration, 10);
    assert.deepEqual(prepared.body.reference_images, [
        { url: 'https://example.com/one.png' },
        { url: 'https://example.com/two.png' }
    ]);
});

test('builds OpenAI-compatible video task responses', () => {
    const created = buildOpenAIVideoCreateResponse({
        request_id: 'video-1',
        status: 'pending'
    }, {
        model: 'grok-imagine-video',
        prompt: 'test',
        seconds: '4',
        size: '720x1280',
        createdAt: 123
    });
    assert.deepEqual(created, {
        id: 'video-1',
        object: 'video',
        model: 'grok-imagine-video',
        prompt: 'test',
        seconds: '4',
        size: '720x1280',
        created_at: 123,
        status: 'queued',
        progress: 0
    });

    const retrieved = buildOpenAIVideoRetrieveResponse('video-1', {
        model: 'grok-imagine-video',
        status: 'done',
        progress: 100,
        video: {
            url: 'https://example.com/video.mp4',
            duration: 4
        }
    });
    assert.equal(retrieved.status, 'completed');
    assert.equal(retrieved.video_url, 'https://example.com/video.mp4');
    assert.equal(retrieved.seconds, '4');
});

test('converts an OpenAI remix request into an xAI video edit', () => {
    const prepared = buildXaiVideoRemixRequest({
        model: 'xai/grok-imagine-video-1.5',
        prompt: 'Make the camera movement slower',
        seconds: 6,
        size: '1280x720'
    }, {
        model: 'grok-imagine-video',
        video: {
            url: 'https://example.com/source.mp4',
            duration: 4
        }
    }, 'video-source');

    assert.deepEqual(prepared.body, {
        model: 'grok-imagine-video-1.5',
        prompt: 'Make the camera movement slower',
        video: { url: 'https://example.com/source.mp4' },
        duration: 6,
        aspect_ratio: '16:9',
        resolution: '720p'
    });
    assert.equal(prepared.metadata.sourceVideoId, 'video-source');
    assert.equal(prepared.metadata.seconds, '6');
});

test('validates video models and result URLs', () => {
    assert.equal(canonicalXaiVideoModel('grok/grok-imagine-video'), 'grok-imagine-video');
    assert.equal(canonicalXaiVideoModel('xai/grok-imagine-video-1.5'), 'grok-imagine-video-1.5');
    assert.throws(() => canonicalXaiVideoModel('sora-2'), /Unsupported xAI video model/);
    assert.equal(
        extractXaiVideoUrl({ video: { url: 'https://example.com/video.mp4' } }),
        'https://example.com/video.mp4'
    );
    assert.throws(() => extractXaiVideoUrl({ video: { url: 'file:///tmp/video.mp4' } }), /invalid video\.url/);
});
