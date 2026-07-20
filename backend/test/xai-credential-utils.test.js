import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    extractXaiDeliveryAccounts,
    inferTokenRecord,
    normalizeXaiCredentialRecord,
    normalizeXaiImportPayload,
    parseXaiDeliveryLine,
    supportsXaiApiAccess
} from '../src/auth/xai-credential-utils.js';
import {
    buildXaiAuthorizeUrl,
    buildXaiDeviceCodeParams,
    buildXaiDeviceFlowHeaders,
    buildXaiPkcePair,
    buildCredentialIdentityKeys,
    findMatchingXaiCredential,
    resolveXaiOAuthFlow
} from '../src/auth/xai-oauth.js';
import {
    XAI_CLIENT_SCOPE,
    XAI_DEFAULT_API_BASE_URL,
    XAI_DEFAULT_CHAT_BASE_URL
} from '../src/providers/openai/xai-constants.js';

function createJwt(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${claims}.signature`;
}

test('infers API keys, JWT access tokens, and opaque refresh tokens', () => {
    const accessToken = createJwt({ sub: 'user-1' });

    assert.deepEqual(inferTokenRecord('xai-test-key'), {
        api_key: 'xai-test-key',
        auth_kind: 'api_key',
        using_api: true
    });
    assert.deepEqual(inferTokenRecord(accessToken), {
        access_token: accessToken,
        auth_kind: 'oauth',
        using_api: false
    });
    assert.deepEqual(inferTokenRecord('refresh-token-value'), {
        refresh_token: 'refresh-token-value',
        auth_kind: 'oauth',
        using_api: false
    });
});

test('normalizes snake_case OAuth credentials and JWT claims', () => {
    const accessToken = createJwt({
        email: 'grok@example.com',
        sub: 'subject-1',
        principal_type: 'User',
        principal_id: 'principal-1',
        team_id: 'team-1',
        exp: 1893456000
    });
    const result = normalizeXaiCredentialRecord({
        credentials: {
            access_token: accessToken,
            refresh_token: 'refresh-1'
        },
        using_api: false
    });

    assert.equal(result.type, 'xai');
    assert.equal(result.auth_kind, 'oauth');
    assert.equal(result.usingApi, false);
    assert.equal(result.accessToken, accessToken);
    assert.equal(result.refreshToken, 'refresh-1');
    assert.equal(result.email, 'grok@example.com');
    assert.equal(result.sub, 'subject-1');
    assert.equal(result.user_id, 'principal-1');
    assert.equal(result.principal_type, 'User');
    assert.equal(result.principal_id, 'principal-1');
    assert.equal(result.team_id, 'team-1');
    assert.equal(result.expired, '2030-01-01T00:00:00.000Z');
    assert.equal(result.baseUrl, XAI_DEFAULT_API_BASE_URL);
    assert.equal(result.chatBaseUrl, XAI_DEFAULT_CHAT_BASE_URL);
});

test('routes API-capable OAuth access tokens through the official API', () => {
    const accessToken = createJwt({
        sub: 'api-oauth-user',
        scope: 'openid offline_access grok-cli:access api:access'
    });
    const result = normalizeXaiCredentialRecord({
        access_token: accessToken,
        auth_kind: 'oauth',
        using_api: false,
        chat_base_url: XAI_DEFAULT_CHAT_BASE_URL
    });

    assert.equal(supportsXaiApiAccess(result), true);
    assert.equal(result.using_api, false);
    assert.equal(result.scope.includes('api:access'), true);
    assert.equal(result.chat_base_url, XAI_DEFAULT_API_BASE_URL);
});

test('forces API keys onto the official API and preserves custom base URLs', () => {
    const result = normalizeXaiCredentialRecord({
        apiKey: 'xai-custom-key',
        usingApi: false,
        baseUrl: 'https://relay.example.com/v1'
    });

    assert.equal(result.authKind, 'api_key');
    assert.equal(result.usingApi, true);
    assert.equal(result.api_key, 'xai-custom-key');
    assert.equal(result.access_token, 'xai-custom-key');
    assert.equal(result.base_url, 'https://relay.example.com/v1');
    assert.equal(result.chat_base_url, 'https://relay.example.com/v1');
});

test('extracts credentials from supported nested collection shapes', () => {
    const wrappers = [
        value => ({ accounts: value }),
        value => ({ items: value }),
        value => ({ records: value }),
        value => ({ data: { accounts: value } }),
        value => ({ payload: { items: value } })
    ];

    wrappers.forEach((wrap, index) => {
        const results = normalizeXaiImportPayload(wrap([{
            credentials: { refreshToken: `refresh-${index}` }
        }]));
        assert.equal(results.length, 1);
        assert.equal(results[0].refresh_token, `refresh-${index}`);
    });
});

test('combines JSON records and one-token-per-line imports', () => {
    const accessToken = createJwt({ sub: 'subject-2' });
    const results = normalizeXaiImportPayload({
        records: [{ api_key: 'xai-record-key' }],
        jsonContent: JSON.stringify({
            data: {
                accounts: [{ credentials: { refresh_token: 'refresh-json' } }]
            }
        }),
        tokenText: `${accessToken}\nrefresh-line`
    });

    assert.equal(results.length, 4);
    assert.deepEqual(results.map(item => item.auth_kind), [
        'api_key',
        'oauth',
        'oauth',
        'oauth'
    ]);
    assert.equal(results[2].access_token, accessToken);
    assert.equal(results[3].refresh_token, 'refresh-line');
});

test('recognizes three-part Grok delivery records without treating them as refresh tokens', () => {
    const deliveryLine = 'buyer@example.com----account-password----header.payload.signature';

    assert.deepEqual(parseXaiDeliveryLine(deliveryLine), {
        email: 'buyer@example.com',
        password: 'account-password',
        sso: 'header.payload.signature'
    });
    assert.deepEqual(extractXaiDeliveryAccounts({ tokenText: deliveryLine }), [{
        email: 'buyer@example.com',
        password: 'account-password',
        sso: 'header.payload.signature'
    }]);
    assert.deepEqual(normalizeXaiImportPayload({ tokenText: deliveryLine }), []);
    assert.equal(parseXaiDeliveryLine('mail----password----client-id----refresh-token'), null);
    assert.deepEqual(
        normalizeXaiImportPayload({ tokenText: 'mail----password----client-id----refresh-token' }),
        []
    );
});

test('imports Grok CLI auth.json issuer entries', () => {
    const accessToken = createJwt({
        sub: 'cli-user',
        email: 'cli@example.com',
        exp: 1893456000
    });
    const results = normalizeXaiImportPayload({
        'https://auth.x.ai::client-id': {
            key: accessToken,
            auth_mode: 'oidc',
            user_id: 'cli-user',
            refresh_token: 'cli-refresh',
            expires_at: '2030-01-01T00:00:00Z'
        }
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].auth_kind, 'oauth');
    assert.equal(results[0].access_token, accessToken);
    assert.equal(results[0].refresh_token, 'cli-refresh');
    assert.equal(results[0].email, 'cli@example.com');
    assert.equal(results[0].sub, 'cli-user');
});

test('treats opaque Grok CLI auth.json keys as access tokens without requiring refresh tokens', () => {
    const results = normalizeXaiImportPayload({
        'https://auth.x.ai::client-id': {
            key: 'opaque-cli-access-token',
            auth_mode: 'oidc',
            user_id: 'cli-user'
        }
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].access_token, 'opaque-cli-access-token');
    assert.equal(results[0].refresh_token, undefined);
    assert.equal(results[0].using_api, false);
});

test('matches the Grok Build device OAuth request contract', () => {
    const params = buildXaiDeviceCodeParams();
    const headers = buildXaiDeviceFlowHeaders();

    assert.equal(params.client_id, 'b1a00492-073a-47ea-816f-4c329264a828');
    assert.equal(params.referrer, 'grok-build');
    assert.equal(params.scope, XAI_CLIENT_SCOPE);
    assert.equal(params.scope.includes('conversations:read'), true);
    assert.equal(params.scope.includes('conversations:write'), true);
    assert.deepEqual(headers, {
        'x-grok-client-version': '0.2.101',
        'x-grok-client-surface': 'ui'
    });
});

test('defaults Grok login to device flow and keeps authorization code as an explicit fallback', () => {
    assert.equal(resolveXaiOAuthFlow(), 'device-code');
    assert.equal(resolveXaiOAuthFlow({ poolId: 3 }), 'device-code');
    assert.equal(resolveXaiOAuthFlow({ flow: 'device-code' }), 'device-code');
    assert.equal(resolveXaiOAuthFlow({ flow: 'authorization-code' }), 'authorization-code');
});

test('matches the Grok Build OIDC authorization code and PKCE contract', () => {
    const pkce = buildXaiPkcePair();
    assert.equal(pkce.codeVerifier.length, 43);
    assert.equal(
        pkce.codeChallenge,
        crypto.createHash('sha256').update(pkce.codeVerifier).digest('base64url')
    );

    const authUrl = new URL(buildXaiAuthorizeUrl({
        authorizationEndpoint: 'https://auth.x.ai/oauth/authorize'
    }, {
        redirectUri: 'http://127.0.0.1:56121/callback',
        codeChallenge: pkce.codeChallenge,
        state: 'state-1',
        nonce: 'nonce-1'
    }));

    assert.equal(authUrl.searchParams.get('response_type'), 'code');
    assert.equal(authUrl.searchParams.get('client_id'), 'b1a00492-073a-47ea-816f-4c329264a828');
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://127.0.0.1:56121/callback');
    assert.equal(authUrl.searchParams.get('scope'), XAI_CLIENT_SCOPE);
    assert.equal(authUrl.searchParams.get('code_challenge'), pkce.codeChallenge);
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authUrl.searchParams.get('state'), 'state-1');
    assert.equal(authUrl.searchParams.get('nonce'), 'nonce-1');
    assert.equal(authUrl.searchParams.get('referrer'), 'grok-build');
});

test('does not reconvert complete CPA records that also contain an SSO field', () => {
    const payload = {
        email: 'cpa@example.com',
        password: 'not-persisted',
        sso: 'header.payload.signature',
        access_token: createJwt({ sub: 'cpa-user' }),
        refresh_token: 'cpa-refresh'
    };

    assert.deepEqual(extractXaiDeliveryAccounts(payload), []);
    assert.equal(normalizeXaiImportPayload(payload).length, 1);
});

test('builds stable credential identities without exposing raw tokens', () => {
    const keys = buildCredentialIdentityKeys({
        apiKey: 'xai-secret-api-key',
        refresh_token: 'secret-refresh-token',
        email: ' Grok@Example.com ',
        subject: 'subject-3'
    });

    assert.equal(keys.includes('email:grok@example.com'), true);
    assert.equal(keys.includes('sub:subject-3'), true);
    assert.equal(keys.some(key => key.includes('xai-secret-api-key')), false);
    assert.equal(keys.some(key => key.includes('secret-refresh-token')), false);
});

test('matches existing Grok credentials by refresh token, email, or subject', () => {
    const existing = [
        {
            id: 1,
            credentials: {
                refresh_token: 'refresh-existing',
                email: 'first@example.com',
                sub: 'subject-first'
            }
        },
        {
            id: 2,
            credentials: {
                refreshToken: 'refresh-second',
                email: 'second@example.com',
                subject: 'subject-second'
            }
        }
    ];

    assert.equal(findMatchingXaiCredential({
        refresh_token: 'refresh-existing'
    }, existing)?.id, 1);
    assert.equal(findMatchingXaiCredential({
        email: ' SECOND@example.com '
    }, existing)?.id, 2);
    assert.equal(findMatchingXaiCredential({
        sub: 'subject-first'
    }, existing)?.id, 1);
    assert.equal(findMatchingXaiCredential({
        refresh_token: 'not-present'
    }, existing), null);
});
