import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstream, startApp } from './helpers.js';

let mock;
let app;

before(async () => {
  mock = await startMockUpstream();
  app = await startApp({ mock });
});
after(async () => {
  await app.close();
  await mock.close();
});

test('healthz 不需要鉴权', async () => {
  const res = await fetch(`${app.baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('没有 token 或 token 错误返回 401', async () => {
  for (const token of [null, 'wrong-token']) {
    const res = await app.api('GET', '/api/me', { token });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthorized');
    assert.ok(res.body.error.message);
  }
});

test('/api/me 返回当前用户', async () => {
  const res = await app.api('GET', '/api/me');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.user, { id: app.alice.user.id, name: '爸爸' });
});

test('/api/tiers 只给档位 id、显示名和模型名', async () => {
  const res = await app.api('GET', '/api/tiers');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    default: 'fast',
    tiers: [
      { id: 'fast', label: '快速', model: 'gpt-6-luna' },
      { id: 'deep', label: '深入', model: 'gpt-6.1-sol' },
      { id: 'gemini', label: 'Gemini', model: 'gemini-3.8-flash' }
    ]
  });
});

test('未知接口返回 404 JSON', async () => {
  const res = await app.api('GET', '/api/nothing');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

test('会话的增、查、改、删', async () => {
  const created = await app.api('POST', '/api/conversations', { body: { folder: '做饭' } });
  assert.equal(created.status, 201);
  const conv = created.body;
  assert.equal(conv.title, '新对话');
  assert.equal(conv.folder, '做饭');
  assert.equal(conv.tier, 'fast');
  assert.equal(conv.pinned, false);
  assert.equal(conv.archived, false);
  assert.equal(conv.preview, '');

  const got = await app.api('GET', `/api/conversations/${conv.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.conversation.id, conv.id);
  assert.deepEqual(got.body.messages, []);

  const renamed = await app.api('PATCH', `/api/conversations/${conv.id}`, { body: { title: '  红烧肉  ', pinned: true, tier: 'deep' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, '红烧肉');
  assert.equal(renamed.body.pinned, true);
  assert.equal(renamed.body.tier, 'deep');

  const uncategorized = await app.api('PATCH', `/api/conversations/${conv.id}`, { body: { folder: null } });
  assert.equal(uncategorized.body.folder, null);

  const deleted = await app.api('DELETE', `/api/conversations/${conv.id}`);
  assert.equal(deleted.status, 204);
  assert.equal((await app.api('GET', `/api/conversations/${conv.id}`)).status, 404);
  assert.equal((await app.api('DELETE', `/api/conversations/${conv.id}`)).status, 404);
});

test('参数校验返回 400', async () => {
  const cases = [
    ['POST', '/api/conversations', { tier: 'gpt-6-luna' }],
    ['POST', '/api/conversations', { title: 'x'.repeat(101) }],
    ['POST', '/api/conversations', { folder: '分'.repeat(31) }]
  ];
  for (const [method, path, body] of cases) {
    const res = await app.api(method, path, { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'bad_request');
  }
  const conv = (await app.api('POST', '/api/conversations', { body: {} })).body;
  for (const body of [{ title: '' }, { pinned: 'yes' }, { tier: 'unknown' }]) {
    const res = await app.api('PATCH', `/api/conversations/${conv.id}`, { body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const bad = await fetch(`${app.baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${app.alice.token}`, 'Content-Type': 'application/json' },
    body: '{not json'
  });
  assert.equal(bad.status, 400);
});

test('访问别人的会话一律 404，且不改动数据', async () => {
  const conv = (await app.api('POST', '/api/conversations', { body: { title: '爸爸的会话' } })).body;
  const other = { token: app.bob.token };

  assert.equal((await app.api('GET', `/api/conversations/${conv.id}`, other)).status, 404);
  assert.equal((await app.api('PATCH', `/api/conversations/${conv.id}`, { ...other, body: { title: '改掉' } })).status, 404);
  assert.equal((await app.api('DELETE', `/api/conversations/${conv.id}`, other)).status, 404);
  const msg = await app.stream(`/api/conversations/${conv.id}/messages`, { content: '你好', clientMessageId: 'x1' }, other);
  assert.equal(msg.status, 404);
  const regen = await app.stream(`/api/conversations/${conv.id}/regenerate`, {}, other);
  assert.equal(regen.status, 404);

  const bobList = await app.api('GET', '/api/conversations', other);
  assert.ok(!bobList.body.items.some((c) => c.id === conv.id));

  const still = await app.api('GET', `/api/conversations/${conv.id}`);
  assert.equal(still.body.conversation.title, '爸爸的会话');
  assert.equal(still.body.messages.length, 0);
});

test('列表：置顶在前、分页、分类、搜索、归档', async () => {
  const fresh = await startApp({ mock });
  try {
    const make = async (title, extra = {}) => (await fresh.api('POST', '/api/conversations', { body: { title, ...extra } })).body;
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await make(`会话${i}`, i % 2 ? { folder: '工作' } : {})).id);
      await new Promise((r) => setTimeout(r, 3));
    }
    await fresh.api('PATCH', `/api/conversations/${ids[0]}`, { body: { pinned: true } });

    const page1 = await fresh.api('GET', '/api/conversations?limit=2');
    assert.deepEqual(page1.body.items.map((c) => c.title), ['会话0', '会话4', '会话3']);
    assert.ok(page1.body.nextBefore);
    const page2 = await fresh.api('GET', `/api/conversations?limit=2&before=${page1.body.nextBefore}`);
    assert.deepEqual(page2.body.items.map((c) => c.title), ['会话2', '会话1']);
    assert.equal(page2.body.nextBefore, null);

    const work = await fresh.api('GET', `/api/conversations?folder=${encodeURIComponent('工作')}`);
    assert.deepEqual(work.body.items.map((c) => c.title), ['会话3', '会话1']);
    const none = await fresh.api('GET', '/api/conversations?folder=');
    assert.deepEqual(none.body.items.map((c) => c.title), ['会话0', '会话4', '会话2']);

    const search = await fresh.api('GET', `/api/conversations?q=${encodeURIComponent('话3')}`);
    assert.deepEqual(search.body.items.map((c) => c.title), ['会话3']);
    const literal = await fresh.api('GET', `/api/conversations?q=${encodeURIComponent('%')}`);
    assert.equal(literal.body.items.length, 0);

    const folders = await fresh.api('GET', '/api/folders');
    assert.deepEqual(folders.body, { items: [{ name: '工作', count: 2 }] });

    await fresh.api('PATCH', `/api/conversations/${ids[3]}`, { body: { archived: true } });
    const active = await fresh.api('GET', '/api/conversations');
    assert.ok(!active.body.items.some((c) => c.id === ids[3]));
    const archived = await fresh.api('GET', '/api/conversations?archived=1');
    assert.deepEqual(archived.body.items.map((c) => c.id), [ids[3]]);
    assert.deepEqual((await fresh.api('GET', '/api/folders')).body, { items: [{ name: '工作', count: 1 }] });
  } finally {
    await fresh.close();
  }
});

test('置顶、归档不改变 updatedAt，改名会更新', async () => {
  const conv = (await app.api('POST', '/api/conversations', { body: {} })).body;
  await new Promise((r) => setTimeout(r, 5));
  const pinned = (await app.api('PATCH', `/api/conversations/${conv.id}`, { body: { pinned: true, archived: true } })).body;
  assert.equal(pinned.updatedAt, conv.updatedAt);
  const renamed = (await app.api('PATCH', `/api/conversations/${conv.id}`, { body: { title: '新名字' } })).body;
  assert.ok(renamed.updatedAt > conv.updatedAt);
});
