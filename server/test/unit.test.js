import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTier, loadConfig } from '../src/config.js';
import { buildHistory, fallbackTitle } from '../src/chat.js';
import { parseChunk } from '../src/upstream.js';
import { openDb } from '../src/db.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('档位配置解析', () => {
  assert.deepEqual(parseTier('deep', 'cc:gpt-6.1-sol:medium:8192'), {
    id: 'deep', label: '深入', provider: 'cc', model: 'gpt-6.1-sol', effort: 'medium', maxOutputTokens: 8192
  });
  assert.equal(parseTier('gemini', ''), null);
  assert.equal(parseTier('fast', 'cc:gpt-6-luna').maxOutputTokens, 4096);
  assert.throws(() => parseTier('fast', 'openai:gpt'), /provider/);

  const config = loadConfig({ TIER_FAST: 'cc:gpt-6-luna:low:4096', TIER_GEMINI: '' });
  assert.deepEqual(Object.keys(config.tiers), ['fast']);
  assert.equal(config.port, 8790);
  assert.ok(config.systemPrompt.length > 0);
  assert.throws(() => loadConfig({}), /TIER_FAST/);
});

test('历史裁剪：合并连续同角色消息，跳过空内容', () => {
  const rows = [
    { role: 'user', content: '一' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '二' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '三' }
  ];
  assert.deepEqual(buildHistory(rows, { maxMessages: 24, maxChars: 1000 }), [
    { role: 'user', content: '一\n\n二' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '三' }
  ]);
});

test('临时标题取前 20 个字，折叠空白', () => {
  assert.equal(fallbackTitle('  你好\n\n世界  '), '你好 世界');
  assert.equal(fallbackTitle('😀'.repeat(25)), '😀'.repeat(20));
});

test('流式解析丢弃推理 / 思考内容', () => {
  assert.deepEqual(parseChunk('cc', { choices: [{ delta: { reasoning_content: 'x' } }] }), { text: '', finishReason: '' });
  assert.deepEqual(parseChunk('cc', { choices: [{ delta: { content: [{ type: 'text', text: 'a' }] }, finish_reason: 'stop' }] }), { text: 'a', finishReason: 'stop' });
  assert.deepEqual(parseChunk('gemini', { candidates: [{ content: { parts: [{ text: 't', thought: true }, { text: 'b' }] }, finishReason: 'SAFETY' }] }), { text: 'b', finishReason: 'safety' });
  assert.throws(() => parseChunk('cc', { error: { message: 'bad' } }), (e) => e.code === 'upstream_error');
});

test('bin/add-user 打印 token，数据库只存哈希', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minichat-'));
  const dbPath = path.join(dir, 'test.db');
  try {
    const output = execFileSync(path.join(SERVER_DIR, 'bin', 'add-user'), ['爸爸'], {
      env: { ...process.env, DB_PATH: dbPath, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
      encoding: 'utf8'
    });
    const token = /token：(\S+)/.exec(output)[1];
    const store = openDb(dbPath);
    assert.equal(store.userByToken(token).name, '爸爸');
    assert.equal(store.userByToken('nope'), null);
    const raw = store.db.prepare('SELECT token_hash FROM users').get().token_hash;
    assert.notEqual(raw, token);
    store.close();

    assert.throws(() => execFileSync(path.join(SERVER_DIR, 'bin', 'add-user'), [], { env: { ...process.env, DB_PATH: dbPath }, stdio: 'pipe' }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
