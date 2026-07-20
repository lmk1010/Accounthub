import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    getXaiRegistrationEnvironment,
    normalizeXaiRegistrationOptions,
    parseRegistrationRunnerEvent,
    sanitizeRegistrationLogLine
} from '../src/services/xai-registration.service.js';

test('ships a deployable Grok registration runtime with the backend', () => {
    const environment = getXaiRegistrationEnvironment();

    assert.equal(environment.registerEngineReady, true);
    assert.equal(environment.converterReady, true);
    assert.match(environment.registerEnginePath, /src[/\\]vendor[/\\]xai-registration-engine$/);
    assert.match(environment.converterScriptPath, /src[/\\]vendor[/\\]xai-registration-converter/);
});

test('ships resilient xAI email selectors and readable UTF-8 registration logs', () => {
    const environment = getXaiRegistrationEnvironment();
    const engineSource = readFileSync(
        `${environment.registerEnginePath}/grok_register_ttk.py`,
        'utf8'
    );

    assert.match(engineSource, /def fill_email_and_submit\(timeout=45/);
    assert.match(engineSource, /input\[placeholder\*="mail" i\]/);
    assert.match(engineSource, /def _wait_email_page_advanced/);
    assert.match(engineSource, /等待邮箱输入框: url=/);
    assert.match(engineSource, /已创建邮箱:/);
    assert.doesNotMatch(engineSource, /鑾|宸插垱|閭|澶辫触|鐢ㄦ埛/);
});

test('reads Hotmail verification codes through Microsoft Graph before IMAP fallback', () => {
    const environment = getXaiRegistrationEnvironment();
    const enginePath = `${environment.registerEnginePath}/grok_register_ttk.py`;
    const engineSource = readFileSync(enginePath, 'utf8');
    const functionStart = engineSource.indexOf('def hotmail_get_oai_code(');
    const graphCall = engineSource.indexOf('_hotmail_graph_get_code(', functionStart);
    const imapCall = engineSource.indexOf('_hotmail_imap_get_code(', functionStart);

    assert.notEqual(functionStart, -1);
    assert.notEqual(graphCall, -1);
    assert.notEqual(imapCall, -1);
    assert.ok(graphCall < imapCall);

    const probe = String.raw`
import ast
import datetime
import json
import re
import sys
import time

source = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(source)
selected = {
    "_config_bool",
    "_hotmail_graph_recipient_blob",
    "_hotmail_graph_get_code",
    "extract_verification_code",
}
module = ast.Module(
    body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in selected],
    type_ignores=[],
)
ast.fix_missing_locations(module)
namespace = {
    "config": {
        "hotmail_recent_seconds": 900,
        "hotmail_graph_last_n": 10,
        "hotmail_require_recipient_match": True,
    },
    "datetime": datetime,
    "re": re,
    "time": time,
}
exec(compile(module, sys.argv[1], "exec"), namespace)

received_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
messages = [
    {
        "id": "message-1",
        "subject": "ZZZ-999 xAI verification",
        "from": {"emailAddress": {"address": "verify@x.ai"}},
        "toRecipients": [{"emailAddress": {"address": "other@outlook.com"}}],
        "receivedDateTime": received_at,
        "bodyPreview": "Your code is ZZZ-999",
        "body": {"content": "Your code is ZZZ-999"},
    },
    {
        "id": "message-2",
        "subject": "ABC-123 xAI verification",
        "from": {"emailAddress": {"address": "verify@x.ai"}},
        "toRecipients": [{"emailAddress": {"address": "main@outlook.com"}}],
        "receivedDateTime": received_at,
        "bodyPreview": "Your code is ABC-123",
        "body": {"content": "Your code is ABC-123"},
    },
]
captured = {}

class Response:
    def __init__(self, payload):
        self.status_code = 200
        self.text = ""
        self.payload = payload

    def json(self):
        return self.payload

def http_get(url, **kwargs):
    captured.setdefault("calls", []).append({
        "url": url,
        "authorization": kwargs["headers"]["Authorization"],
        "select": kwargs["params"]["$select"],
    })
    if url.endswith("/message-2"):
        return Response({
            "internetMessageHeaders": [
                {"name": "X-Original-To", "value": "main+alias@outlook.com"},
            ],
        })
    return Response({"value": messages})

namespace["http_get"] = http_get
code = namespace["_hotmail_graph_get_code"](
    "main@outlook.com",
    "main+alias@outlook.com",
    "graph-token",
)
assert code == "ABC-123", code
print(json.dumps(captured))
`;
    const result = spawnSync('python3', ['-c', probe, enginePath], {
        encoding: 'utf8',
        timeout: 10000
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const captured = JSON.parse(result.stdout.trim());
    assert.equal(
        captured.calls[0].url,
        'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages'
    );
    assert.equal(captured.calls[0].authorization, 'Bearer graph-token');
    assert.doesNotMatch(captured.calls[0].select, /internetMessageHeaders/);
    assert.equal(
        captured.calls.at(-1).url,
        'https://graph.microsoft.com/v1.0/me/messages/message-2'
    );
    assert.equal(captured.calls.at(-1).select, 'internetMessageHeaders');
});

test('normalizes Grok registration task limits and email settings', () => {
    const options = normalizeXaiRegistrationOptions({
        count: 200,
        threads: 25,
        poolId: '12',
        emailProvider: 'outlook',
        hotmailAccounts: 'mail@example.com----password----client----refresh',
        fastMode: false
    });

    assert.equal(options.count, 50);
    assert.equal(options.threads, 10);
    assert.equal(options.poolId, 12);
    assert.equal(options.email.provider, 'outlookmail');
    assert.match(options.email.hotmail.accounts, /mail@example\.com/);
    assert.equal(options.fastMode, false);
});

test('parses structured runner events without treating regular logs as events', () => {
    assert.deepEqual(
        parseRegistrationRunnerEvent('@@ACCOUNTHUB_EVENT@@{"type":"progress","registered":2}'),
        { type: 'progress', registered: 2 }
    );
    assert.equal(parseRegistrationRunnerEvent('[W1] regular log'), null);
    assert.equal(parseRegistrationRunnerEvent('@@ACCOUNTHUB_EVENT@@not-json'), null);
});

test('redacts JWT and token values from registration logs', () => {
    const jwt = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyLTEiLCJlbWFpbCI6ImFAYi5jb20ifQ.signature123';
    const sanitized = sanitizeRegistrationLogLine(`access_token=${jwt} refresh_token=secret-refresh`);

    assert.equal(sanitized.includes(jwt), false);
    assert.equal(sanitized.includes('secret-refresh'), false);
    assert.match(sanitized, /REDACTED/);
});
