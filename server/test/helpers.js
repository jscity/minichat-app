// 测试工具：模拟上游（CC / Gemini）、启动应用、读取 SSE。

import http from 'node:http';
import { once } from 'node:events';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { parseTier } from '../src/config.js';

export const SYSTEM_PROMPT = '测试用系统提示词';

// 模拟上游：每个请求交给 handlers 队列里的下一个函数处理；没有排队的用 defaultHandler。
export async function startMockUpstream() {
  const mock = {
    requests: [],
    queue: [],
    defaultHandler: (req, res, body) => ccStream(res, ['默认', '回答']),
    aborted: 0
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    mock.requests.push({ url: req.url, headers: req.headers, body });
    res.on('close', () => {
      if (!res.writableEnded) mock.aborted += 1;
    });
    const handle = mock.queue.shift() ?? mock.defaultHandler;
    await handle(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  mock.baseUrl = `http://127.0.0.1:${server.address().port}`;
  mock.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  return mock;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sseHead(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
}

// OpenAI 兼容格式：先发一段推理内容（应被丢弃），再发正文。
export async function ccStream(res, pieces, { finishReason = 'stop', delayMs = 0 } = {}) {
  sseHead(res);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思考中' } }] })}\n\n`);
  for (const piece of pieces) {
    if (delayMs) await sleep(delayMs);
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

export function geminiStream(res, pieces, { finishReason = 'STOP' } = {}) {
  sseHead(res);
  res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '想法', thought: true }] } }] })}\n\n`);
  pieces.forEach((piece, i) => {
    const last = i === pieces.length - 1;
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: piece }] }, ...(last ? { finishReason } : {}) }] })}\n\n`);
  });
  res.end();
}

export async function startApp({ env = {}, mock } = {}) {
  const store = openDb(':memory:');
  const config = {
    systemPrompt: SYSTEM_PROMPT,
    providers: {
      cc: { baseUrl: `${mock.baseUrl}/v1`, apiKey: 'cc-test-key' },
      gemini: { baseUrl: mock.baseUrl, apiKey: 'gg-test-key' }
    },
    tiers: {
      fast: parseTier('fast', 'cc:gpt-6-luna:low:4096'),
      deep: parseTier('deep', 'cc:gpt-6.1-sol:medium:8192'),
      gemini: parseTier('gemini', 'gemini:gemini-3.8-flash:low:4096')
    },
    historyMaxMessages: 24,
    historyMaxChars: 24000,
    upstreamTimeoutMs: 5000,
    pingIntervalMs: 15000,
    ...env
  };
  const logs = [];
  const log = { info: (line) => logs.push(line), warn: (line) => logs.push(line), error: (e) => logs.push(String(e)) };
  const { handler, chat } = createApp({ config, store, log });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const alice = store.createUser('爸爸');
  const bob = store.createUser('妈妈');

  async function api(method, path, { token = alice.token, body } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }

  // 发起 SSE 请求并读完，返回事件列表。stopAfter(event) 返回 true 时客户端主动断开。
  async function stream(path, body, { token = alice.token, stopAfter } = {}) {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
      return { status: res.status, body: await res.json(), events: [] };
    }
    const events = [];
    let aborted = false;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!event) continue;
          const parsed = { event, data: JSON.parse(data) };
          events.push(parsed);
          if (stopAfter?.(parsed)) {
            aborted = true;
            controller.abort();
            return { status: res.status, events, aborted };
          }
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
    if (aborted) return { status: res.status, events, aborted };
    const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    return { status: res.status, events, text };
  }

  // 等服务端把这次回复落库、释放会话（客户端断开后需要等一下）。
  async function settle(conversationId) {
    for (let i = 0; i < 100 && chat.isBusy(conversationId); i += 1) await sleep(10);
    await chat.drain();
  }

  async function close() {
    await chat.drain();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }

  return { baseUrl, store, chat, logs, alice, bob, api, stream, settle, close };
}
