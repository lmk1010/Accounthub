export class DroidAnthropicResponseTransformer {
    constructor(model, requestId) {
        this.model = model;
        this.requestId = requestId || `chatcmpl-${Date.now()}`;
        this.created = Math.floor(Date.now() / 1000);
    }

    _createOpenAIChunk(content, role = null, finish = false, finishReason = null) {
        const chunk = {
            id: this.requestId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.model,
            choices: [
                {
                    index: 0,
                    delta: {},
                    finish_reason: finish ? finishReason : null
                }
            ]
        };

        if (role) {
            chunk.choices[0].delta.role = role;
        }
        if (content) {
            chunk.choices[0].delta.content = content;
        }

        return chunk;
    }

    _mapStopReason(anthropicReason) {
        const mapping = {
            end_turn: 'stop',
            max_tokens: 'length',
            stop_sequence: 'stop',
            tool_use: 'tool_calls'
        };
        return mapping[anthropicReason] || 'stop';
    }

    _transformEvent(eventType, eventData) {
        if (eventType === 'message_start') {
            return this._createOpenAIChunk('', 'assistant', false);
        }

        if (eventType === 'content_block_delta') {
            const text = eventData.delta?.text || '';
            return this._createOpenAIChunk(text, null, false);
        }

        if (eventType === 'message_delta') {
            const stopReason = eventData.delta?.stop_reason;
            if (stopReason) {
                return this._createOpenAIChunk('', null, true, this._mapStopReason(stopReason));
            }
            return null;
        }

        return null;
    }

    async *transformStream(sourceStream) {
        let buffer = '';
        let currentEvent = null;

        for await (const chunk of sourceStream) {
            buffer += chunk.toString('utf-8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                if (line.startsWith('event:')) {
                    currentEvent = line.slice(6).trim();
                    continue;
                }
                if (!line.startsWith('data:')) {
                    continue;
                }
                const dataStr = line.slice(5).trim();
                if (dataStr === '[DONE]') {
                    return;
                }
                let data;
                try {
                    data = JSON.parse(dataStr);
                } catch (_error) {
                    data = null;
                }

                if (data && !data.type && currentEvent) {
                    data.type = currentEvent;
                }

                const eventType = data?.type || currentEvent;
                if (!eventType || !data) {
                    continue;
                }

                const transformed = this._transformEvent(eventType, data);
                if (transformed) {
                    yield transformed;
                }
                currentEvent = null;
            }
        }
    }
}
