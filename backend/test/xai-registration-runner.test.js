import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import test from 'node:test';
import { fileURLToPath } from 'url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(TEST_DIR, '..');
const RUNNER = path.join(BACKEND_DIR, 'src/scripts/xai-registration-runner.py');
const FIXTURE_DIR = path.join(TEST_DIR, 'fixtures/xai-registration');

test('runner isolates the engine, generates JSON, and removes sensitive temporary files', () => {
    const taskDir = mkdtempSync(path.join(tmpdir(), 'xai-registration-runner-test-'));
    const optionsPath = path.join(taskDir, '.options.json');
    writeFileSync(optionsPath, JSON.stringify({
        count: 2,
        threads: 1,
        proxy: '',
        fastMode: true,
        browserReuse: true,
        email: {
            provider: 'cloudmail',
            domains: 'example.com',
            cloudmail: {
                url: 'https://mail.example.com',
                adminEmail: 'admin@example.com',
                password: 'secret'
            }
        }
    }));

    try {
        const result = spawnSync('python3', [
            RUNNER,
            '--task-dir',
            taskDir,
            '--register-engine',
            path.join(FIXTURE_DIR, 'register-engine'),
            '--converter-script',
            path.join(FIXTURE_DIR, 'sso_to_auth_json.py'),
            '--options-file',
            optionsPath
        ], {
            encoding: 'utf8',
            timeout: 10000
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /@@ACCOUNTHUB_EVENT@@/);
        assert.match(result.stdout, /"type": "result"/);
        assert.equal(existsSync(optionsPath), false);
        assert.equal(existsSync(path.join(taskDir, 'accounts.txt')), false);
        assert.equal(existsSync(path.join(taskDir, 'registration-engine')), false);

        const firstRecord = JSON.parse(
            readFileSync(path.join(taskDir, 'auths', 'xai-user1@example.com.json'), 'utf8')
        );
        const secondRecord = JSON.parse(
            readFileSync(path.join(taskDir, 'auths', 'xai-user2@example.com.json'), 'utf8')
        );
        assert.equal(firstRecord.email, 'user1@example.com');
        assert.equal(secondRecord.email, 'user2@example.com');
    } finally {
        rmSync(taskDir, { recursive: true, force: true });
    }
});
