import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
    convertXaiSsoDeliveries,
    sanitizeConvertedXaiRecord
} from '../src/services/xai-sso-import.service.js';

test('removes password and SSO fields from converted credentials', () => {
    const result = sanitizeConvertedXaiRecord({
        email: 'buyer@example.com',
        password: 'secret',
        sso: 'session-cookie',
        sso_cookie: 'session-cookie-2',
        access_token: 'access',
        refresh_token: 'refresh'
    });

    assert.equal('password' in result, false);
    assert.equal('sso' in result, false);
    assert.equal('sso_cookie' in result, false);
    assert.equal(result.access_token, 'access');
    assert.equal(result.refresh_token, 'refresh');
});

test('converts three-part delivery accounts with the configured converter runtime', async () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), 'xai-sso-converter-test-'));
    const converterPath = path.join(fixtureDir, 'converter.py');
    writeFileSync(converterPath, `
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--sso")
parser.add_argument("--email")
parser.add_argument("--cpa-auth-dir")
args = parser.parse_args()
sso = Path(args.sso).read_text(encoding="utf-8").strip()
out = Path(args.cpa_auth_dir)
out.mkdir(parents=True, exist_ok=True)
(out / ("xai-" + args.email + ".json")).write_text(json.dumps({
    "type": "xai",
    "auth_kind": "oauth",
    "email": args.email,
    "access_token": "header.payload.signature",
    "refresh_token": "refresh-value",
    "base_url": "https://cli-chat-proxy.grok.com/v1",
    "sso": sso,
    "password": "must-not-persist"
}), encoding="utf-8")
`, { encoding: 'utf8', mode: 0o700 });

    try {
        const result = await convertXaiSsoDeliveries([{
            email: 'buyer@example.com',
            password: 'account-password',
            sso: 'session-cookie'
        }], {
            converterScriptPath: converterPath,
            pythonCommand: process.env.PYTHON || 'python3'
        });

        assert.equal(result.failures.length, 0);
        assert.equal(result.records.length, 1);
        assert.equal(result.records[0].email, 'buyer@example.com');
        assert.equal(result.records[0].refresh_token, 'refresh-value');
        assert.equal('sso' in result.records[0], false);
        assert.equal('password' in result.records[0], false);
    } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
    }
});
