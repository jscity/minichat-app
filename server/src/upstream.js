// 上游模型的请求格式与流式解析（CC = OpenAI 兼容 chat/completions，Gemini = streamGenerateContent）。
// 推理 / 思考内容一律丢弃，只回调正文。

export class UpstreamError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export const UPSTREAM_MESSAGES = {
  upstream_error: '模型服务出错，请重试或切换档位。',
  upstream_timeout: '模型响应超时，请重试或切换档位。'
};

export function buildUpstreamRequest(tier, providerConfig, { system, messages, maxOutputTokens }) {
  const maxTokens = maxOutputTokens ?? tier.maxOutputTokens;
  if (tier.provider === 'gemini') {
    return {
      url: `${providerConfig.baseUrl}/v1beta/models/${encodeURIComponent(tier.model)}:streamGenerateContent?alt=sse`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': providerConfig.apiKey },
      body: {
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: {
          maxOutputTokens: maxTokens,
          ...(tier.effort ? { thinkingConfig: { thinkingLevel: tier.effort } } : {})
        }
      }
    };
  }
  return {
    url: `${providerConfig.baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${providerConfig.apiKey}`
    },
    body: {
      model: tier.model,
      stream: true,
      max_completion_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
      ...(tier.effort ? { reasoning_effort: tier.effort } : {})
    }
  };
}

// 统一成 stop / length / 其他小写原因。
export function normalizeFinishReason(provider, reason) {
  if (typeof reason !== 'string' || !reason.trim()) return '';
  const value = reason.trim().toLowerCase();
  if (provider === 'gemini') {
    if (value === 'stop') return 'stop';
    if (value === 'max_tokens') return 'length';
    return value;
  }
  return value;
}

// 解析一条 SSE data，返回 { text, finishReason }。
export function parseChunk(provider, chunk) {
  if (chunk?.error) {
    throw new UpstreamError('upstream_error', UPSTREAM_MESSAGES.upstream_error, chunk.error.message || JSON.stringify(chunk.error));
  }
  if (provider === 'gemini') {
    const candidate = chunk?.candidates?.[0];
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts.filter((p) => !p?.thought && typeof p?.text === 'string').map((p) => p.text).join('');
    return { text, finishReason: normalizeFinishReason(provider, candidate?.finishReason) };
  }
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta?.content;
  const text = typeof delta === 'string'
    ? delta
    : Array.isArray(delta) ? delta.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
  return { text, finishReason: normalizeFinishReason(provider, choice?.finish_reason) };
}

// 流式请求上游。onText 收到每段正文；返回 { finishReason }。
// signal 被中止时抛出 AbortError（由调用方区分客户端断开还是超时）。
export async function streamCompletion({ tier, providerConfig, system, messages, maxOutputTokens, signal, onText, fetchImpl = fetch }) {
  if (!providerConfig?.baseUrl || !providerConfig?.apiKey) {
    throw new UpstreamError('upstream_error', UPSTREAM_MESSAGES.upstream_error, `${tier.provider} 未配置地址或 key`);
  }
  const { url, headers, body } = buildUpstreamRequest(tier, providerConfig, { system, messages, maxOutputTokens });
  const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new UpstreamError('upstream_error', UPSTREAM_MESSAGES.upstream_error, `HTTP ${response.status} ${detail.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = '';
  let gotText = false;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      if (!finishReason) finishReason = 'stop';
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new UpstreamError('upstream_error', UPSTREAM_MESSAGES.upstream_error, '无法解析的流式数据');
    }
    const parsed = parseChunk(tier.provider, chunk);
    if (parsed.finishReason) finishReason = parsed.finishReason;
    if (parsed.text) {
      gotText = true;
      onText(parsed.text);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
  } finally {
    reader.releaseLock?.();
  }

  if (!finishReason) throw new UpstreamError('upstream_error', UPSTREAM_MESSAGES.upstream_error, '上游连接提前结束');
  if (!gotText) throw new UpstreamError('upstream_error', UPSTREAM_MESSAGES.upstream_error, '上游没有返回正文');
  return { finishReason };
}
