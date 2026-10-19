// HTTP 路由。接口定义见 docs/api.md。

import { ChatService, fallbackTitle, replayReply } from './chat.js';
import { DEFAULT_TIER } from './config.js';

const MAX_BODY_BYTES = 256 * 1024;
const LIMITS = { content: 20000, title: 100, folder: 30, clientMessageId: 100 };
const DEFAULT_TITLE = '新对话';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new HttpError(400, 'bad_request', message);
const notFound = (message = '会话不存在') => new HttpError(404, 'not_found', message);

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res, error) {
  sendJson(res, error.status, { error: { code: error.code, message: error.message } });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw badRequest('请求内容过大');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not object');
    return body;
  } catch {
    throw badRequest('请求格式不正确');
  }
}

function charLength(text) {
  return Array.from(text).length;
}

function requireText(value, field, label, max) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${label}不能为空`);
  const text = value.trim();
  if (charLength(text) > max) throw badRequest(`${label}不能超过 ${max} 字`);
  return text;
}

function optionalFolder(value) {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && !value.trim())) return null;
  return requireText(value, 'folder', '分类名', LIMITS.folder);
}

export function createApp({ config, store, fetchImpl = fetch, log = console }) {
  const chat = new ChatService({ config, store, fetchImpl, log });

  function resolveTier(id) {
    if (id === undefined || id === null) return undefined;
    const tier = typeof id === 'string' ? config.tiers[id] : undefined;
    if (!tier) throw badRequest('未知的档位');
    return tier;
  }

  function authenticate(req) {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const user = match ? store.userByToken(match[1].trim()) : null;
    if (!user) throw new HttpError(401, 'unauthorized', '登录已失效，请检查 token');
    return user;
  }

  function ownConversationRow(user, id) {
    const row = store.getConversationRow(user.id, id);
    if (!row) throw notFound();
    return row;
  }

  function assertNotBusy(conversationId) {
    if (chat.isBusy(conversationId)) throw new HttpError(409, 'busy', '上一条回复还在生成，请稍候');
  }

  // ---- 处理函数 ----

  function getTiers() {
    return {
      default: DEFAULT_TIER,
      tiers: Object.values(config.tiers).map((t) => ({ id: t.id, label: t.label, model: t.model }))
    };
  }

  function listConversations(user, url) {
    const params = url.searchParams;
    const limitRaw = params.get('limit');
    const limit = limitRaw === null ? 50 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1) throw badRequest('limit 不正确');
    const beforeRaw = params.get('before');
    const before = beforeRaw === null || beforeRaw === '' ? undefined : Number(beforeRaw);
    if (before !== undefined && !Number.isFinite(before)) throw badRequest('before 不正确');
    return store.listConversations(user.id, {
      folder: params.has('folder') ? params.get('folder').trim() : undefined,
      q: (params.get('q') ?? '').trim() || undefined,
      archived: params.get('archived') === '1',
      limit: Math.min(limit, 200),
      before
    });
  }

  function createConversation(user, body) {
    const title = body.title === undefined || body.title === null || body.title === ''
      ? null
      : requireText(body.title, 'title', '标题', LIMITS.title);
    const tier = resolveTier(body.tier) ?? config.tiers[DEFAULT_TIER];
    return store.createConversation(user.id, {
      title: title ?? DEFAULT_TITLE,
      titleSource: title ? 'user' : 'auto',
      folder: optionalFolder(body.folder) ?? null,
      tier: tier.id
    });
  }

  function patchConversation(user, id, body) {
    ownConversationRow(user, id);
    const fields = {};
    let touch = false;
    if (body.title !== undefined) {
      fields.title = requireText(body.title, 'title', '标题', LIMITS.title);
      fields.title_source = 'user';
      touch = true;
    }
    if (body.folder !== undefined) {
      fields.folder = optionalFolder(body.folder);
      touch = true;
    }
    for (const key of ['pinned', 'archived']) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') throw badRequest(`${key} 必须是 true 或 false`);
      fields[key] = body[key] ? 1 : 0;
    }
    if (body.tier !== undefined) fields.tier = resolveTier(body.tier).id;
    if (touch) fields.updated_at = Date.now();
    return store.updateConversation(user.id, id, fields);
  }

  async function postMessage(user, id, body, req, res, startedAt) {
    const conversation = ownConversationRow(user, id);
    const content = requireText(body.content, 'content', '消息内容', LIMITS.content);
    const clientMessageId = requireText(body.clientMessageId, 'clientMessageId', 'clientMessageId', LIMITS.clientMessageId);
    const tier = resolveTier(body.tier) ?? config.tiers[conversation.tier] ?? config.tiers[DEFAULT_TIER];
    assertNotBusy(id);

    // 幂等：同一个 clientMessageId 只存一条用户消息。
    const existing = store.userMessageByClientId(id, clientMessageId);
    if (existing) {
      const reply = store.replyTo(existing.id);
      if (reply && reply.status === 'complete') return replayReply(res, conversation, existing, reply);
      const maybeTitle = conversation.title_source === 'auto' && store.countUserMessages(id) === 1;
      return chat.generate({ req, res, conversation, userRow: existing, tier, startedAt, maybeTitle });
    }

    const userRow = store.insertUserMessage(id, { content, clientMessageId });
    const isFirst = store.countUserMessages(id) === 1;
    const fields = { updated_at: userRow.created_at };
    if (isFirst && conversation.title_source === 'auto') fields.title = fallbackTitle(content);
    store.updateConversation(user.id, id, fields);
    const fresh = store.getConversationRow(user.id, id);
    return chat.generate({ req, res, conversation: fresh, userRow, tier, startedAt, maybeTitle: isFirst && fresh.title_source === 'auto' });
  }

  async function regenerate(user, id, body, req, res, startedAt) {
    const conversation = ownConversationRow(user, id);
    const tier = resolveTier(body.tier) ?? config.tiers[conversation.tier] ?? config.tiers[DEFAULT_TIER];
    assertNotBusy(id);
    const userRow = store.lastUserMessage(id);
    if (!userRow) throw badRequest('会话里还没有可以重答的消息');
    return chat.generate({ req, res, conversation, userRow, tier, startedAt, keepOldOnEmptyFailure: true });
  }

  // ---- 路由 ----

  async function route(req, res) {
    const startedAt = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;

    if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('ok');
    }
    if (!path.startsWith('/api/')) throw new HttpError(404, 'not_found', '接口不存在');

    const user = authenticate(req);

    if (path === '/api/me' && method === 'GET') return sendJson(res, 200, { user });
    if (path === '/api/tiers' && method === 'GET') return sendJson(res, 200, getTiers());
    if (path === '/api/folders' && method === 'GET') return sendJson(res, 200, { items: store.listFolders(user.id) });

    if (path === '/api/conversations') {
      if (method === 'GET') return sendJson(res, 200, listConversations(user, url));
      if (method === 'POST') return sendJson(res, 201, createConversation(user, await readJson(req)));
    }

    const match = /^\/api\/conversations\/([^/]+)(?:\/(messages|regenerate))?$/.exec(path);
    if (match) {
      const [, id, action] = match;
      if (!action) {
        if (method === 'GET') {
          ownConversationRow(user, id);
          return sendJson(res, 200, { conversation: store.getConversation(user.id, id), messages: store.listMessages(id) });
        }
        if (method === 'PATCH') return sendJson(res, 200, patchConversation(user, id, await readJson(req)));
        if (method === 'DELETE') {
          if (!store.deleteConversation(user.id, id)) throw notFound();
          res.writeHead(204);
          return res.end();
        }
      }
      if (action === 'messages' && method === 'POST') return postMessage(user, id, await readJson(req), req, res, startedAt);
      if (action === 'regenerate' && method === 'POST') return regenerate(user, id, await readJson(req), req, res, startedAt);
    }

    throw new HttpError(404, 'not_found', '接口不存在');
  }

  async function handler(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      if (res.headersSent) {
        log.error?.(error);
        if (!res.writableEnded) res.end();
        return;
      }
      if (error instanceof HttpError) return sendError(res, error);
      log.error?.(error);
      sendError(res, new HttpError(500, 'internal', '服务器出错了，请稍后重试'));
    }
  }

  return { handler, chat };
}
