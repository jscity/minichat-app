// SQLite 数据访问。表结构见 docs/api.md。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  title_source   TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
  folder         TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  tier           TEXT NOT NULL DEFAULT 'fast',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON conversations(user_id, archived, pinned DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'incomplete', 'error')),
  client_message_id  TEXT,
  reply_to           TEXT REFERENCES messages(id) ON DELETE CASCADE,
  tier               TEXT,
  model              TEXT,
  finish_reason      TEXT,
  error_code         TEXT,
  first_token_ms     INTEGER,
  total_ms           INTEGER,
  input_chars        INTEGER,
  created_at         INTEGER NOT NULL,
  UNIQUE (conversation_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_created ON messages(conversation_id, created_at);
`;

export const PREVIEW_CHARS = 60;

// 消息按「轮次」排序：助手消息跟在它回复的用户消息后面，即使是后来重新生成的。
const turnOrder = (dir) => `
  COALESCE((SELECT u.created_at FROM messages u WHERE u.id = m.reply_to), m.created_at) ${dir},
  CASE m.role WHEN 'user' THEN 0 ELSE 1 END ${dir},
  m.rowid ${dir}`;

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return new Store(db);
}

function toConversation(row) {
  return {
    id: row.id,
    title: row.title,
    folder: row.folder ?? null,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    tier: row.tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preview: (row.preview ?? '').slice(0, PREVIEW_CHARS)
  };
}

function toMessage(row) {
  const base = { id: row.id, role: row.role, content: row.content, status: row.status, createdAt: row.created_at };
  if (row.role === 'user') return { ...base, clientMessageId: row.client_message_id };
  return {
    ...base,
    replyTo: row.reply_to,
    tier: row.tier,
    model: row.model,
    finishReason: row.finish_reason,
    errorCode: row.error_code,
    firstTokenMs: row.first_token_ms,
    totalMs: row.total_ms
  };
}

const CONVERSATION_COLUMNS = `
  c.*,
  (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY ${turnOrder('DESC')} LIMIT 1) AS preview`;

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---- 用户 ----

  createUser(name) {
    const token = crypto.randomBytes(24).toString('base64url');
    const user = { id: crypto.randomUUID(), name };
    this.db.prepare('INSERT INTO users (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, name, hashToken(token), Date.now());
    return { user, token };
  }

  userByToken(token) {
    const row = this.db.prepare('SELECT id, name FROM users WHERE token_hash = ?').get(hashToken(token));
    return row ? { id: row.id, name: row.name } : null;
  }

  // ---- 会话 ----

  createConversation(userId, { title, titleSource, folder, tier }) {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO conversations (id, user_id, title, title_source, folder, tier, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, title, titleSource, folder, tier, now, now);
    return this.getConversation(userId, id);
  }

  // 只返回属于该用户的会话，别人的会话当作不存在。
  getConversationRow(userId, id) {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId) ?? null;
  }

  getConversation(userId, id) {
    const row = this.db.prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE c.id = ? AND c.user_id = ?`).get(id, userId);
    return row ? toConversation(row) : null;
  }

  listConversations(userId, { folder, q, archived, limit, before }) {
    const where = ['c.user_id = ?', 'c.archived = ?'];
    const params = [userId, archived ? 1 : 0];
    if (folder !== undefined) {
      if (folder === '') where.push('c.folder IS NULL');
      else { where.push('c.folder = ?'); params.push(folder); }
    }
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push(`(c.title LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'))`);
      params.push(like, like);
    }
    const base = `SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE ${where.join(' AND ')}`;

    const pinned = before === undefined
      ? this.db.prepare(`${base} AND c.pinned = 1 ORDER BY c.updated_at DESC`).all(...params)
      : [];
    const rest = before === undefined
      ? this.db.prepare(`${base} AND c.pinned = 0 ORDER BY c.updated_at DESC LIMIT ?`).all(...params, limit + 1)
      : this.db.prepare(`${base} AND c.pinned = 0 AND c.updated_at < ? ORDER BY c.updated_at DESC LIMIT ?`).all(...params, before, limit + 1);

    const hasMore = rest.length > limit;
    const page = rest.slice(0, limit);
    return {
      items: [...pinned, ...page].map(toConversation),
      nextBefore: hasMore ? page[page.length - 1].updated_at : null
    };
  }

  updateConversation(userId, id, fields) {
    const sets = [];
    const params = [];
    for (const [column, value] of Object.entries(fields)) {
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length) {
      this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params, id, userId);
    }
    return this.getConversation(userId, id);
  }

  // 自动标题只在标题仍是自动来源时写入，避免覆盖用户手动改过的标题。
  setAutoTitle(conversationId, title) {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'").run(title, conversationId);
  }

  touchConversation(conversationId, at = Date.now()) {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at, conversationId);
    return at;
  }

  deleteConversation(userId, id) {
    return this.db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  listFolders(userId) {
    return this.db.prepare(`SELECT folder AS name, COUNT(*) AS count FROM conversations
      WHERE user_id = ? AND archived = 0 AND folder IS NOT NULL GROUP BY folder ORDER BY folder`).all(userId)
      .map((row) => ({ name: row.name, count: row.count }));
  }

  // ---- 消息 ----

  listMessageRows(conversationId) {
    return this.db.prepare(`SELECT m.* FROM messages m WHERE m.conversation_id = ? ORDER BY ${turnOrder('ASC')}`).all(conversationId);
  }

  listMessages(conversationId) {
    return this.listMessageRows(conversationId).map(toMessage);
  }

  userMessageByClientId(conversationId, clientMessageId) {
    return this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ? AND role = 'user'")
      .get(conversationId, clientMessageId) ?? null;
  }

  lastUserMessage(conversationId) {
    const rows = this.listMessageRows(conversationId).filter((row) => row.role === 'user');
    return rows[rows.length - 1] ?? null;
  }

  replyTo(userMessageId) {
    return this.db.prepare("SELECT * FROM messages WHERE reply_to = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1")
      .get(userMessageId) ?? null;
  }

  countUserMessages(conversationId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'").get(conversationId).n;
  }

  insertUserMessage(conversationId, { content, clientMessageId }) {
    const row = { id: crypto.randomUUID(), createdAt: Date.now() };
    this.db.prepare(`INSERT INTO messages (id, conversation_id, role, content, status, client_message_id, created_at)
      VALUES (?, ?, 'user', ?, 'complete', ?, ?)`).run(row.id, conversationId, content, clientMessageId, row.createdAt);
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id);
  }

  // 保存助手回复，并删除同一条用户消息之前的回复（只保留一个版本）。
  saveAssistantMessage(conversationId, message) {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE reply_to = ? AND role = 'assistant'").run(message.replyTo);
      this.db.prepare(`INSERT INTO messages (id, conversation_id, role, content, status, reply_to, tier, model,
          finish_reason, error_code, first_token_ms, total_ms, input_chars, created_at)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        message.id, conversationId, message.content, message.status, message.replyTo, message.tier, message.model,
        message.finishReason ?? null, message.errorCode ?? null, message.firstTokenMs ?? null, message.totalMs ?? null,
        message.inputChars ?? null, message.createdAt
      );
      return this.touchConversation(conversationId, message.createdAt);
    });
  }
}
