import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildInsertPayload } from '../src/dao/request-logs-dao.js';

test('request log insert payload never binds undefined values', () => {
    const columns = new Set([
        'provider_uuid',
        'provider_type',
        'pool_id',
        'request_model',
        'status_code',
        'is_success',
        'error_type',
        'error_message',
        'client_ip',
        'user_agent',
        'client_token_id'
    ]);

    const payload = buildInsertPayload({
        providerUuid: 'provider-1',
        requestModel: 'gpt-5.5',
        isSuccess: false,
        errorMessage: 'upstream failed',
        clientIp: undefined,
        userAgent: undefined,
        clientTokenId: undefined
    }, columns);

    assert.deepEqual(payload.columns, [
        'provider_uuid',
        'provider_type',
        'pool_id',
        'request_model',
        'status_code',
        'is_success',
        'error_type',
        'error_message',
        'client_ip',
        'user_agent',
        'client_token_id'
    ]);
    assert.equal(payload.params.includes(undefined), false);
    assert.equal(payload.params[payload.columns.indexOf('provider_type')], null);
    assert.equal(payload.params[payload.columns.indexOf('status_code')], null);
    assert.equal(payload.params[payload.columns.indexOf('client_ip')], null);
});
