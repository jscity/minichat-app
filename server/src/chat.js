// 一次回复的完整过程：组上下文 → 流式请求上游 → SSE 转发 → 落库。新消息和深入重答共用。

import crypto from 'node:crypto';
import { streamCompletion, UpstreamError, UPSTREAM_MESSAGES } from './upstream.js';

export const TITLE_FALLBACK_CHARS = 20;
const TITLE_MAX_CHARS = 30;
const TITLE_PROMPT = '用不超过 12 个字概括下面这段对话的主题，作为对话标题。只输出标题本身，不要引号、标点或解释。';

// 从最新往前取，条数和字符数双重上限；当前这条一定保留。连续同角色的消息合并，开头不能是助手消息。
export function buildHistory(rows, { maxMessages, maxChars }) {
  const usable = rows.filter((row) => row.content && row.content.trim());
  const picked = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const row = usable[i];
    if (picked.length > 0 && (picked.length >= maxMessages || chars + row.content.length > maxChars)) break;
    picked.unshift(row);
    chars += row.content.length;
  }
  while (picked.length && picked[0].role !== 'user') picked.shift();

  const merged = [];
  for (const row of picked) {
    const last = merged[merged.length - 1];
    if (last && last.role === row.role) last.content += `\n\n${row.content}`;
    else merged.push({ role: row.role, content: row.content });
  }
  return merged;
}

export function fallbackTitle(content) {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return Array.from(oneLine).slice(0, TITLE_FALLBACK_CHARS).join('') || '新对话';
}

function cleanTitle(text) {
  const line = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  const stripped = line.replace(/^(标题[:：]\s*)/, '').replace(/^[「『“"'《#*\s]+|[」』”"'》*。.！!？?\s]+$/g, '').trim();
  return Array.from(stripped).slice(0, TITLE_MAX_CHARS).join('');
}

function sseWrite(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
}

// 已有完整回复时直接回放，不再请求模型。
export function replayReply(res, conversation, userRow, replyRow) {
  startSse(res);
  sseWrite(res, 'start', {
    userMessage: { id: userRow.id, createdAt: userRow.created_at },
    assistantMessageId: replyRow.id,
    tier: replyRow.tier,
    model: replyRow.model,
    replay: true
  });
  if (replyRow.content) sseWrite(res, 'delta', { text: replyRow.content });
  sseWrite(res, 'done', {
    message: {
      id: replyRow.id,
      status: replyRow.status,
      finishReason: replyRow.finish_reason,
      firstTokenMs: replyRow.first_token_ms,
      totalMs: replyRow.total_ms
    },
    conversation: { updatedAt: conversation.updated_at }
  });
  res.end();
}

export class ChatService {
  constructor({ config, store, fetchImpl = fetch, log = console }) {
    this.config = config;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.busy = new Set();
    this.active = new Set();
    this.background = new Set();
  }

  isBusy(conversationId) {
    return this.busy.has(conversationId);
  }

  // 等待后台任务（自动标题）结束，测试和关机时用。
  async drain() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  abortAll() {
    for (const controller of this.active) controller.abort(new Error('shutdown'));
  }

  // 生成一条回复并以 SSE 返回。调用方先检查 isBusy。
  // keepOldOnEmptyFailure：深入重答时，新回复一个字都没有就失败，则保留原回复。
  async generate({ req, res, conversation, userRow, tier, keepOldOnEmptyFailure = false, startedAt = Date.now(), maybeTitle = false }) {
    const conversationId = conversation.id;
    this.busy.add(conversationId);
    const controller = new AbortController();
    this.active.add(controller);
    const assistantId = crypto.randomUUID();
    let text = '';
    let firstTokenMs = null;
    let clientClosed = false;
    let timedOut = false;

    const onClose = () => {
      if (res.writableEnded) return;
      clientClosed = true;
      controller.abort(new Error('client closed'));
    };
    res.on('close', onClose);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, this.config.upstreamTimeoutMs);
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, this.config.pingIntervalMs);

    const allRows = this.store.listMessageRows(conversationId);
    const upto = allRows.slice(0, allRows.findIndex((row) => row.id === userRow.id) + 1);
    const history = buildHistory(upto.filter((row) => row.reply_to !== userRow.id), {
      maxMessages: this.config.historyMaxMessages,
      maxChars: this.config.historyMaxChars
    });
    const inputChars = history.reduce((sum, m) => sum + m.content.length, 0);

    startSse(res);
    sseWrite(res, 'start', {
      userMessage: { id: userRow.id, createdAt: userRow.created_at },
      assistantMessageId: assistantId,
      tier: tier.id,
      model: tier.model
    });

    let status = 'complete';
    let finishReason = null;
    let errorCode = null;
    let errorDetail = '';
    try {
      const result = await streamCompletion({
        tier,
        providerConfig: this.config.providers[tier.provider],
        system: this.config.systemPrompt,
        messages: history,
        signal: controller.signal,
        fetchImpl: this.fetchImpl,
        onText: (chunk) => {
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
          text += chunk;
          sseWrite(res, 'delta', { text: chunk });
        }
      });
      finishReason = result.finishReason;
    } catch (error) {
      if (clientClosed) {
        status = 'incomplete';
      } else if (timedOut) {
        status = 'error';
        errorCode = 'upstream_timeout';
      } else {
        status = 'error';
        errorCode = error instanceof UpstreamError ? error.code : 'upstream_error';
        errorDetail = error instanceof UpstreamError ? error.detail : String(error?.message || error);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(ping);
      res.off('close', onClose);
      this.active.delete(controller);
    }

    const totalMs = Date.now() - startedAt;
    const keepOld = keepOldOnEmptyFailure && status !== 'complete' && !text;
    let updatedAt = conversation.updated_at;
    if (!keepOld) {
      try {
        updatedAt = this.store.saveAssistantMessage(conversationId, {
          id: assistantId,
          replyTo: userRow.id,
          content: text,
          status,
          tier: tier.id,
          model: tier.model,
          finishReason,
          errorCode,
          firstTokenMs,
          totalMs,
          inputChars,
          createdAt: Date.now()
        });
      } catch (error) {
        // 生成期间会话被删除等情况：回复无处保存，只记日志。
        this.log.warn?.(JSON.stringify({ event: 'save_failed', conversationId, error: String(error?.message || error) }));
      }
    }
    this.busy.delete(conversationId);

    this.log.info?.(JSON.stringify({
      event: 'reply', conversationId, tier: tier.id, model: tier.model, status, finishReason, errorCode,
      firstTokenMs, totalMs, inputChars, outputChars: text.length, kept: keepOld || undefined,
      detail: errorDetail ? errorDetail.slice(0, 300) : undefined
    }));

    if (status === 'complete') {
      sseWrite(res, 'done', {
        message: { id: assistantId, status, finishReason, firstTokenMs, totalMs },
        conversation: { updatedAt }
      });
      if (maybeTitle) this.scheduleTitle(conversationId, userRow.content, text);
    } else if (status === 'error') {
      sseWrite(res, 'error', { code: errorCode, message: UPSTREAM_MESSAGES[errorCode] ?? UPSTREAM_MESSAGES.upstream_error });
    }
    if (!res.writableEnded) res.end();
  }

  // 第一条回复完成后，用「快速」档在后台生成标题；失败就保留临时标题。
  scheduleTitle(conversationId, userText, replyText) {
    const tier = this.config.tiers.fast;
    const task = (async () => {
      let title = '';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        await streamCompletion({
          tier,
          providerConfig: this.config.providers[tier.provider],
          system: TITLE_PROMPT,
          messages: [{ role: 'user', content: `用户：${userText.slice(0, 1000)}\n\n助手：${replyText.slice(0, 1000)}` }],
          maxOutputTokens: 200,
          signal: controller.signal,
          fetchImpl: this.fetchImpl,
          onText: (chunk) => { title += chunk; }
        });
        const cleaned = cleanTitle(title);
        if (cleaned) this.store.setAutoTitle(conversationId, cleaned);
      } catch (error) {
        this.log.warn?.(JSON.stringify({ event: 'title_failed', conversationId, error: String(error?.detail || error?.message || error).slice(0, 200) }));
      } finally {
        clearTimeout(timer);
      }
    })();
    this.background.add(task);
    task.finally(() => this.background.delete(task));
  }
}
