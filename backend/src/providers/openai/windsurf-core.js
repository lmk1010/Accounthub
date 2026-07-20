import { OpenAIApiService } from './openai-core.js';

/**
 * WindsurfAPI service — an OpenAI-compatible proxy backed by Windsurf cloud accounts.
 * WindsurfAPI exposes /v1/chat/completions (OpenAI format) at the configured base URL.
 *
 * Config keys:
 *   WINDSURF_BASE_URL  — e.g. http://localhost:3003/v1 (required)
 *   WINDSURF_API_KEY   — the API_KEY set in WindsurfAPI .env (leave empty if unset)
 */
export class WindsurfApiService extends OpenAIApiService {
    constructor(config) {
        const mappedConfig = {
            ...config,
            OPENAI_API_KEY: config.WINDSURF_API_KEY || 'windsurf-no-key',
            OPENAI_BASE_URL: config.WINDSURF_BASE_URL || 'http://localhost:3003/v1',
        };
        super(mappedConfig);
    }
}
