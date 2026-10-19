import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstream, startApp, ccStream, geminiStream, sleep, SYSTEM_PROMPT } from './helpers.js';

let mock;
let app;

beforeEach(async () => {
  mock = await startMockUpstream();
  // 默认处理器用于后台标题请求。
  mock.defaultHandler = (req, res) => ccStream(res, ['红烧肉做法']);
  app = await startApp({ mock });
});
afterEach(async () => {
  await app.close();
  await mock.close();
});

async function newConversation(body = {}) {
  return (await app.api('POST', '/api/conversations', { body })).body;
}

function send(convId, content, clientMessageId, extra = {}, opts = {}) {
  return app.stream(`/api/conversations/${convId}/messages`, { content, clientMessageId, ...extra }, opts);
}

const isChatSystem = (text) => typeof text === 'string' && text.startsWith(SYSTEM_PROMPT);
const chatRequests = () => mock.requests.filter((r) => isChatSystem(r.body.messages?.[0]?.content) || isChatSystem(r.body.systemInstruction?.parts?.[0]?.text));
// 历史里的消息内容（去掉第一条带日期的系统提示词）
const sentContents = (req) => req.body.messages.slice(1).map((m) => m.content);

test('流式回复：事件顺序、正文、落库、上游请求格式', async () => {
  const conv = await newConversation();
  mock.queue.push((req, res) => ccStream(res, ['先', '焯水', '。']));
  const result = await send(conv.id, '红烧肉怎么做？', 'c1');

  assert.equal(result.status, 200);
  assert.deepEqual(result.events.map((e) => e.event), ['start', 'delta', 'delta', 'delta', 'done']);
  assert.equal(result.text, '先焯水。');
  const [start] = result.events;
  assert.equal(start.data.tier, 'fast');
  assert.equal(start.data.model, 'gpt-6-luna');
  const done = result.events.at(-1).data;
  assert.equal(done.message.id, start.data.assistantMessageId);
  assert.equal(done.message.status, 'complete');
  assert.equal(done.message.finishReason, 'stop');
  assert.ok(Number.isInteger(done.message.firstTokenMs));
  assert.ok(done.message.totalMs >= done.message.firstTokenMs);

  const upstream = mock.requests[0];
  assert.equal(upstream.url, '/v1/chat/completions');
  assert.equal(upstream.headers.authorization, 'Bearer cc-test-key');
  assert.equal(upstream.body.model, 'gpt-6-luna');
  assert.equal(upstream.body.stream, true);
  assert.equal(upstream.body.reasoning_effort, 'low');
  assert.equal(upstream.body.max_completion_tokens, 4096);
  assert.equal(upstream.body.messages[0].role, 'system');
  assert.match(upstream.body.messages[0].content, new RegExp(`^${SYSTEM_PROMPT}\\n\\n今天是 \\d{4}年\\d{1,2}月\\d{1,2}日星期.（北京时间）。$`));
  assert.deepEqual(upstream.body.messages.slice(1), [{ role: 'user', content: '红烧肉怎么做？' }]);

  await app.settle(conv.id);
  const detail = (await app.api('GET', `/api/conversations/${conv.id}`)).body;
  assert.equal(detail.messages.length, 2);
  const [user, assistant] = detail.messages;
  assert.equal(user.role, 'user');
  assert.equal(user.clientMessageId, 'c1');
  assert.equal(user.id, start.data.userMessage.id);
  assert.equal(assistant.content, '先焯水。');
  assert.equal(assistant.status, 'complete');
  assert.equal(assistant.replyTo, user.id);
  assert.equal(assistant.model, 'gpt-6-luna');
  assert.equal(assistant.firstTokenMs, done.message.firstTokenMs);
  assert.ok(!assistant.content.includes('思考中'), '推理内容不应保存');
  assert.equal(detail.conversation.preview, '先焯水。');
  assert.equal(detail.conversation.updatedAt, done.conversation.updatedAt);
});

test('第一条消息先用前 20 字做标题，回复后后台生成标题；手动标题不被覆盖', async () => {
  const conv = await newConversation();
  mock.queue.push((req, res) => ccStream(res, ['好的']));
  const long = '请告诉我红烧肉怎么做才能不腻而且颜色好看还入味呢谢谢';
  const result = await send(conv.id, long, 'c1');
  assert.equal(result.events.at(-1).event, 'done');
  // 回复刚完成时还是临时标题
  await app.settle(conv.id);
  const titled = (await app.api('GET', `/api/conversations/${conv.id}`)).body.conversation;
  assert.equal(titled.title, '红烧肉做法');
  const titleRequest = mock.requests.at(-1);
  assert.equal(titleRequest.body.model, 'gpt-6-luna');
  assert.match(titleRequest.body.messages[1].content, /红烧肉/);

  const manual = await newConversation({ title: '我的标题' });
  mock.queue.push((req, res) => ccStream(res, ['好的']));
  await send(manual.id, '你好', 'c2');
  await app.settle(manual.id);
  assert.equal((await app.api('GET', `/api/conversations/${manual.id}`)).body.conversation.title, '我的标题');
  assert.equal(mock.requests.length, 3, '手动标题的会话不应请求生成标题');
});

test('标题生成失败时保留前 20 字的临时标题', async () => {
  const conv = await newConversation();
  mock.queue.push((req, res) => ccStream(res, ['好的']));
  mock.queue.push((req, res) => { res.writeHead(500); res.end('boom'); });
  await send(conv.id, '一二三四五六七八九十一二三四五六七八九十多出来的字', 'c1');
  await app.settle(conv.id);
  assert.equal((await app.api('GET', `/api/conversations/${conv.id}`)).body.conversation.title, '一二三四五六七八九十一二三四五六七八九十');
});

test('clientMessageId 幂等：重复提交不产生重复消息，已完成的回复直接回放', async () => {
  const conv = await newConversation({ title: '幂等' });
  mock.queue.push((req, res) => ccStream(res, ['第一次', '回答']));
  const first = await send(conv.id, '问题', 'same-id');
  await app.settle(conv.id);
  const requestsBefore = mock.requests.length;

  const retry = await send(conv.id, '问题', 'same-id');
  assert.equal(retry.status, 200);
  assert.equal(retry.text, '第一次回答');
  assert.equal(retry.events[0].data.assistantMessageId, first.events[0].data.assistantMessageId);
  assert.equal(retry.events[0].data.userMessage.id, first.events[0].data.userMessage.id);
  assert.equal(retry.events.at(-1).data.message.status, 'complete');
  assert.equal(mock.requests.length, requestsBefore, '回放不应请求上游');

  const detail = (await app.api('GET', `/api/conversations/${conv.id}`)).body;
  assert.equal(detail.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(detail.messages.length, 2);
});

test('clientMessageId 幂等：上次出错时重试会重新生成并替换', async () => {
  const conv = await newConversation({ title: '重试' });
  mock.queue.push((req, res) => { res.writeHead(502); res.end('bad gateway'); });
  const failed = await send(conv.id, '问题', 'retry-id');
  assert.equal(failed.events.at(-1).event, 'error');
  await app.settle(conv.id);

  mock.queue.push((req, res) => ccStream(res, ['这次', '成功']));
  const retry = await send(conv.id, '问题', 'retry-id');
  assert.equal(retry.text, '这次成功');
  await app.settle(conv.id);

  const messages = (await app.api('GET', `/api/conversations/${conv.id}`)).body.messages;
  assert.deepEqual(messages.map((m) => [m.role, m.status, m.content]), [
    ['user', 'complete', '问题'],
    ['assistant', 'complete', '这次成功']
  ]);
  // 重试时历史里只有这条用户消息一次，没有旧的错误回复
  assert.deepEqual(mock.requests.at(-1).body.messages.slice(1), [{ role: 'user', content: '问题' }]);
});

test('客户端中途断开：停止上游，已生成部分存为 incomplete', async () => {
  const conv = await newConversation({ title: '断开' });
  mock.queue.push((req, res) => ccStream(res, ['第一段', '第二段', '第三段', '第四段'], { delayMs: 150 }));
  const result = await send(conv.id, '讲个长故事', 'c1', {}, { stopAfter: (e) => e.event === 'delta' });
  assert.ok(result.aborted);
  await app.settle(conv.id);
  await sleep(50);

  const messages = (await app.api('GET', `/api/conversations/${conv.id}`)).body.messages;
  const assistant = messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.status, 'incomplete');
  assert.ok(assistant.content.startsWith('第一段'));
  assert.ok(!assistant.content.includes('第四段'));
  assert.equal(mock.aborted, 1, '上游连接应被中止');
  assert.equal(app.chat.isBusy(conv.id), false);
});

test('上游 HTTP 出错：发送 error 事件，保存为 error', async () => {
  const conv = await newConversation({ title: '出错' });
  mock.queue.push((req, res) => { res.writeHead(500); res.end('{"error":"boom"}'); });
  const result = await send(conv.id, '你好', 'c1');
  const last = result.events.at(-1);
  assert.equal(last.event, 'error');
  assert.equal(last.data.code, 'upstream_error');
  assert.ok(last.data.message);
  assert.ok(!JSON.stringify(result.events).includes('boom'), '上游原始错误不下发给客户端');
  await app.settle(conv.id);
  const assistant = (await app.api('GET', `/api/conversations/${conv.id}`)).body.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.status, 'error');
  assert.equal(assistant.errorCode, 'upstream_error');
  assert.equal(assistant.content, '');
});

test('上游流中途报错：已生成部分存为 error', async () => {
  const conv = await newConversation({ title: '中途出错' });
  mock.queue.push((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '一半' } }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`);
  });
  const result = await send(conv.id, '你好', 'c1');
  assert.deepEqual(result.events.map((e) => e.event), ['start', 'delta', 'error']);
  await app.settle(conv.id);
  const assistant = (await app.api('GET', `/api/conversations/${conv.id}`)).body.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.status, 'error');
  assert.equal(assistant.content, '一半');
});

test('上游连接提前结束（没有结束标记）算出错', async () => {
  const conv = await newConversation({ title: '提前结束' });
  mock.queue.push((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '半句' } }] })}\n\n`);
  });
  const result = await send(conv.id, '你好', 'c1');
  assert.equal(result.events.at(-1).event, 'error');
});

test('上游超时：upstream_timeout', async () => {
  await app.close();
  app = await startApp({ mock, env: { upstreamTimeoutMs: 200 } });
  const conv = await newConversation({ title: '超时' });
  mock.queue.push(() => {}); // 永不响应
  const result = await send(conv.id, '你好', 'c1');
  const last = result.events.at(-1);
  assert.equal(last.event, 'error');
  assert.equal(last.data.code, 'upstream_timeout');
  await app.settle(conv.id);
  const assistant = (await app.api('GET', `/api/conversations/${conv.id}`)).body.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.errorCode, 'upstream_timeout');
});

test('回复被长度截断：finishReason = length（CC 和 Gemini）', async () => {
  const conv = await newConversation({ title: '截断' });
  mock.queue.push((req, res) => ccStream(res, ['很长'], { finishReason: 'length' }));
  const cc = await send(conv.id, '写长文', 'c1');
  assert.equal(cc.events.at(-1).data.message.finishReason, 'length');
  assert.equal(cc.events.at(-1).data.message.status, 'complete');
  await app.settle(conv.id);

  mock.queue.push((req, res) => geminiStream(res, ['很', '长'], { finishReason: 'MAX_TOKENS' }));
  const gg = await send(conv.id, '再写', 'c2', { tier: 'gemini' });
  assert.equal(gg.text, '很长');
  assert.equal(gg.events[0].data.model, 'gemini-3.8-flash');
  assert.equal(gg.events.at(-1).data.message.finishReason, 'length');
  await app.settle(conv.id);

  const geminiRequest = mock.requests.at(-1);
  assert.equal(geminiRequest.url, '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
  assert.equal(geminiRequest.headers['x-goog-api-key'], 'gg-test-key');
  assert.deepEqual(geminiRequest.body.generationConfig, { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } });
  assert.ok(isChatSystem(geminiRequest.body.systemInstruction.parts[0].text));
  assert.deepEqual(geminiRequest.body.contents.map((c) => c.role), ['user', 'model', 'user']);

  const saved = (await app.api('GET', `/api/conversations/${conv.id}`)).body.messages.at(-1);
  assert.equal(saved.finishReason, 'length');
  assert.equal(saved.tier, 'gemini');
  assert.ok(!saved.content.includes('想法'), 'Gemini 思考内容不应保存');
});

test('历史消息按条数和字符数裁剪，当前消息总在', async () => {
  await app.close();
  app = await startApp({ mock, env: { historyMaxMessages: 4, historyMaxChars: 30 } });
  const conv = await newConversation({ title: '裁剪' });
  for (let i = 1; i <= 4; i += 1) {
    mock.queue.push((req, res) => ccStream(res, [`答${i}`]));
    await send(conv.id, `问${i}`, `c${i}`);
    await app.settle(conv.id);
  }
  // 条数上限 4：答2 问3 答3 问4，去掉开头的助手消息后为 问3 答3 问4
  assert.deepEqual(sentContents(mock.requests.at(-1)), ['问3', '答3', '问4']);

  // 字符上限 30：一条长消息挤掉更早的历史，但当前消息即使很长也保留
  mock.queue.push((req, res) => ccStream(res, ['好']));
  await send(conv.id, '长'.repeat(28), 'c5');
  await app.settle(conv.id);
  assert.deepEqual(sentContents(mock.requests.at(-1)), ['长'.repeat(28)]);

  mock.queue.push((req, res) => ccStream(res, ['好']));
  await send(conv.id, '超'.repeat(50), 'c6');
  await app.settle(conv.id);
  assert.deepEqual(sentContents(mock.requests.at(-1)), ['超'.repeat(50)]);
});

test('深入重答：用指定档位回答最后一条用户消息，替换原回答', async () => {
  const conv = await newConversation({ title: '重答' });
  mock.queue.push((req, res) => ccStream(res, ['快速回答']));
  await send(conv.id, '问题', 'c1');
  await app.settle(conv.id);

  mock.queue.push((req, res) => ccStream(res, ['深入', '回答']));
  const result = await app.stream(`/api/conversations/${conv.id}/regenerate`, { tier: 'deep' });
  assert.equal(result.text, '深入回答');
  assert.equal(result.events[0].data.model, 'gpt-6.1-sol');
  const upstream = mock.requests.at(-1).body;
  assert.equal(upstream.model, 'gpt-6.1-sol');
  assert.equal(upstream.reasoning_effort, 'medium');
  assert.equal(upstream.max_completion_tokens, 8192);
  assert.deepEqual(upstream.messages.slice(1), [{ role: 'user', content: '问题' }], '旧回答不应进入上下文');
  await app.settle(conv.id);

  const messages = (await app.api('GET', `/api/conversations/${conv.id}`)).body.messages;
  assert.deepEqual(messages.map((m) => [m.role, m.content, m.tier ?? null]), [
    ['user', '问题', null],
    ['assistant', '深入回答', 'deep']
  ]);
});

test('深入重答失败且没有内容时保留原回答', async () => {
  const conv = await newConversation({ title: '重答失败' });
  mock.queue.push((req, res) => ccStream(res, ['原回答']));
  await send(conv.id, '问题', 'c1');
  await app.settle(conv.id);

  mock.queue.push((req, res) => { res.writeHead(500); res.end(); });
  const result = await app.stream(`/api/conversations/${conv.id}/regenerate`, { tier: 'deep' });
  assert.equal(result.events.at(-1).event, 'error');
  await app.settle(conv.id);
  const messages = (await app.api('GET', `/api/conversations/${conv.id}`)).body.messages;
  assert.deepEqual(messages.map((m) => m.content), ['问题', '原回答']);
});

test('深入重答：没有用户消息返回 400，未知档位返回 400', async () => {
  const conv = await newConversation({ title: '空' });
  const empty = await app.stream(`/api/conversations/${conv.id}/regenerate`, { tier: 'deep' });
  assert.equal(empty.status, 400);
  const unknown = await send(conv.id, '你好', 'c1', { tier: 'gpt-6-sol' });
  assert.equal(unknown.status, 400);
  assert.equal(chatRequests().length, 0);
});

test('消息校验：内容为空、超长、缺 clientMessageId 返回 400', async () => {
  const conv = await newConversation({ title: '校验' });
  for (const body of [
    { content: '   ', clientMessageId: 'a' },
    { content: '字'.repeat(20001), clientMessageId: 'b' },
    { content: '你好' }
  ]) {
    const res = await app.stream(`/api/conversations/${conv.id}/messages`, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 50));
  }
  assert.equal(mock.requests.length, 0);
});

test('同一会话正在生成时再发返回 409 busy', async () => {
  const conv = await newConversation({ title: '并发' });
  mock.queue.push((req, res) => ccStream(res, ['慢', '慢', '来'], { delayMs: 100 }));
  const first = send(conv.id, '第一条', 'c1');
  await sleep(50);
  const second = await send(conv.id, '第二条', 'c2');
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'busy');
  const regen = await app.stream(`/api/conversations/${conv.id}/regenerate`, {});
  assert.equal(regen.status, 409);
  assert.equal((await first).text, '慢慢来');
  await app.settle(conv.id);
  const messages = (await app.api('GET', `/api/conversations/${conv.id}`)).body.messages;
  assert.equal(messages.length, 2);
});

test('会话的 tier 作为默认档位，消息可单独指定档位', async () => {
  const conv = await newConversation({ title: '档位', tier: 'deep' });
  mock.queue.push((req, res) => ccStream(res, ['a']));
  const r1 = await send(conv.id, '一', 'c1');
  assert.equal(r1.events[0].data.tier, 'deep');
  await app.settle(conv.id);
  mock.queue.push((req, res) => ccStream(res, ['b']));
  const r2 = await send(conv.id, '二', 'c2', { tier: 'fast' });
  assert.equal(r2.events[0].data.tier, 'fast');
});
