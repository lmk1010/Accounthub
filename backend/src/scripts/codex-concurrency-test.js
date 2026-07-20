#!/usr/bin/env node
import axios from 'axios';
import http from 'http';
import https from 'https';
import crypto from 'crypto';

const DEFAULT_URL = process.env.CODEX_URL || 'https://gateway.example.com/v1';
const DEFAULT_API_KEY = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '';

const help = () => console.log(`Codex Responses SSE 并发测试
用法:
  node backend/src/scripts/codex-concurrency-test.js --url https://gateway.example.com/v1 --api-key sk-xxx
可选:
  --levels 20,50,100 --rounds 1 --model gpt-5.3-codex
  --context-chars 10000 --timeout 180000 --prompt "请只回复 OK"
  --same-session --session-header-mode session_id
环境变量:
  CODEX_URL CODEX_API_KEY OPENAI_API_KEY`);

function parse(argv) {
  const opts = {
    url: process.env.CODEX_URL || DEFAULT_URL,
    apiKey: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || DEFAULT_API_KEY,
    levels: [20, 50, 100],
    model: 'gpt-5.3-codex',
    rounds: 1,
    timeout: 180000,
    prompt: '请只回复 OK',
    contextChars: 200,
    sameSession: false,
    sessionHeaderMode: 'session_id',
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') opts.url = argv[++i];
    else if (arg === '--api-key') opts.apiKey = argv[++i];
    else if (arg === '--levels') opts.levels = argv[++i].split(',').map(v => parseInt(v, 10)).filter(Boolean);
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--rounds') opts.rounds = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (arg === '--timeout') opts.timeout = Math.max(1000, parseInt(argv[++i], 10) || 180000);
    else if (arg === '--prompt') opts.prompt = argv[++i];
    else if (arg === '--context-chars') opts.contextChars = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (arg === '--same-session') opts.sameSession = true;
    else if (arg === '--session-header-mode') opts.sessionHeaderMode = String(argv[++i] || 'session_id').trim();
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

const pct = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
};

const avg = (values) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

const normalizeUrl = (url) => {
  const normalized = String(url || '').trim().replace(/\/$/, '');
  if (/\/v1\/responses\/?$/.test(normalized)) return normalized;
  if (/\/v1\/?$/.test(normalized)) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
};

function buildContext(targetChars) {
  if (!targetChars || targetChars <= 0) return '';
  const chunk = '这是用于 Codex SSE 并发压测的上下文片段，包含稳定重复内容，用来模拟 10K 级别输入。';
  let text = '';
  while (text.length < targetChars) text += chunk;
  return text.slice(0, targetChars);
}

function buildBody(model, prompt, sessionId, contextChars) {
  const context = buildContext(contextChars);
  const text = context
    ? `请先阅读下面上下文，再回答最后的问题。\n<context>\n${context}\n</context>\n问题：${prompt}`
    : prompt;

  return {
    model,
    stream: true,
    instructions: '你是压测回包测试助手，不要调用工具，只输出简短文本。',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    ],
    text: { verbosity: 'low' },
    reasoning: { effort: 'low' },
    store: false
  };
}

async function readStreamText(stream, limit = 4000) {
  let output = '';
  for await (const chunk of stream) {
    output += chunk.toString('utf8');
    if (output.length >= limit) break;
  }
  return output.slice(0, limit);
}

function parseSseChunk(state, chunkText, startedAt, metrics) {
  state.buffer += chunkText;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() || '';

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) {
      state.eventName = '';
      continue;
    }

    if (line.startsWith('event: ')) {
      state.eventName = line.slice(7).trim();
      continue;
    }

    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);

    if (data === '[DONE]') {
      metrics.done = true;
      continue;
    }

    metrics.eventCount++;

    try {
      const parsed = JSON.parse(data);
      const eventType = state.eventName || parsed.type || 'message';
      if (!metrics.firstEventType) metrics.firstEventType = eventType;

      if (
        !metrics.ttft
        && (
          eventType === 'response.output_text.delta'
          || eventType === 'response.output_text.done'
          || typeof parsed.delta === 'string'
          || typeof parsed.text === 'string'
        )
      ) {
        metrics.ttft = Date.now() - startedAt;
      }

      if (eventType === 'response.completed' || parsed.type === 'response.completed') {
        metrics.completed = true;
      }

      if (
        eventType === 'error'
        || eventType === 'response.failed'
        || parsed.type === 'response.failed'
        || parsed.error
      ) {
        metrics.sseError = typeof parsed.error === 'string'
          ? parsed.error
          : JSON.stringify(parsed.error || parsed);
      }
    } catch {
      metrics.nonJsonEvents++;
    }
  }
}

async function fire(client, opts, sharedSessionId) {
  const sessionId = opts.sameSession ? sharedSessionId : crypto.randomUUID();
  const headers = {
    'content-type': 'application/json',
    'accept': 'text/event-stream, application/json'
  };
  if (opts.sessionHeaderMode === 'session_id' || opts.sessionHeaderMode === 'both') {
    headers.session_id = sessionId;
  }
  if (opts.sessionHeaderMode === 'x-session-id' || opts.sessionHeaderMode === 'both') {
    headers['x-session-id'] = sessionId;
  }
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  const startedAt = Date.now();
  const body = buildBody(opts.model, opts.prompt, sessionId, opts.contextChars);
  const metrics = {
    ok: false,
    status: 'ERR',
    ms: 0,
    ttft: 0,
    bytes: 0,
    eventCount: 0,
    nonJsonEvents: 0,
    done: false,
    completed: false,
    firstEventType: '',
    sseError: '',
    contentType: ''
  };

  try {
    const res = await client.post(opts.url, body, {
      headers,
      timeout: opts.timeout,
      responseType: 'stream',
      validateStatus: () => true
    });

    metrics.status = res.status;
    metrics.contentType = String(res.headers?.['content-type'] || '');

    if (res.status < 200 || res.status >= 300) {
      metrics.error = (await readStreamText(res.data)).trim();
      metrics.ms = Date.now() - startedAt;
      return metrics;
    }

    if (!metrics.contentType.includes('text/event-stream')) {
      metrics.error = `unexpected content-type: ${metrics.contentType}; body=${(await readStreamText(res.data)).trim()}`;
      metrics.ms = Date.now() - startedAt;
      return metrics;
    }

    const state = { buffer: '', eventName: '' };
    for await (const chunk of res.data) {
      metrics.bytes += chunk.length;
      parseSseChunk(state, chunk.toString('utf8'), startedAt, metrics);
    }

    metrics.ms = Date.now() - startedAt;
    if (state.buffer.trim()) parseSseChunk(state, '\n', startedAt, metrics);

    metrics.ok = metrics.eventCount > 0 && (metrics.done || metrics.completed) && !metrics.sseError;
    if (!metrics.ok && !metrics.sseError && !metrics.error) {
      metrics.error = `invalid_sse eventCount=${metrics.eventCount} done=${metrics.done} completed=${metrics.completed}`;
    }
    if (metrics.sseError && !metrics.error) metrics.error = metrics.sseError;
    return metrics;
  } catch (error) {
    metrics.ms = Date.now() - startedAt;
    metrics.status = error.response?.status || error.code || 'ERR';
    metrics.error = error.message;
    return metrics;
  }
}

function summarize(level, round, elapsedMs, rows) {
  const successRows = rows.filter(row => row.ok);
  const latencies = rows.map(row => row.ms);
  const ttfts = successRows.map(row => row.ttft).filter(Boolean);
  const statuses = rows.reduce((map, row) => {
    const key = row.ok ? String(row.status) : `${row.status}:${row.error ? String(row.error).slice(0, 40) : 'failed'}`;
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map());

  return {
    并发: level,
    轮次: round,
    成功: `${successRows.length}/${rows.length}`,
    失败: rows.length - successRows.length,
    总耗时ms: elapsedMs,
    平均ms: avg(latencies),
    P50ms: pct(latencies, 0.5),
    P95ms: pct(latencies, 0.95),
    平均TTFTms: avg(ttfts),
    P95TTFTms: pct(ttfts, 0.95),
    RPS: Number((rows.length / Math.max(1, elapsedMs / 1000)).toFixed(2)),
    状态: [...statuses.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => `${key}:${value}`).join(' | ')
  };
}

async function runLevel(client, opts, level, round) {
  console.log(`\n开始压测: 并发=${level}, 轮次=${round}, contextChars=${opts.contextChars}, sessionMode=${opts.sameSession ? 'shared' : 'unique'}, headerMode=${opts.sessionHeaderMode}`);
  const startedAt = Date.now();
  const sharedSessionId = crypto.randomUUID();
  const rows = await Promise.all(Array.from({ length: level }, () => fire(client, opts, sharedSessionId)));
  const summary = summarize(level, round, Date.now() - startedAt, rows);
  console.log(summary);
  const failed = rows.filter(row => !row.ok).slice(0, 3).map(row => ({
    status: row.status,
    ms: row.ms,
    ttft: row.ttft,
    contentType: row.contentType,
    error: row.error ? String(row.error).slice(0, 220) : ''
  }));
  if (failed.length) console.log('失败样例:', failed);
  return summary;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) return help();
  opts.url = normalizeUrl(opts.url);

  const maxSockets = Math.max(...opts.levels, 100) * 2;
  const client = axios.create({
    proxy: false,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets })
  });

  const all = [];
  for (const level of opts.levels) {
    for (let round = 1; round <= opts.rounds; round++) {
      all.push(await runLevel(client, opts, level, round));
    }
  }

  console.log('\n汇总结果:');
  console.table(all);
}

main().catch(error => {
  console.error('压测脚本执行失败:', error.message);
  process.exit(1);
});
