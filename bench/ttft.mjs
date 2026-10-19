#!/usr/bin/env node
// 首字耗时测速：对 targets.json 里的每个模型配置，用 prompts.json 里的问题串行请求，
// 统计首个正文字符到达的时间（不含思考/推理内容）。零依赖，需要 Node 20.6+。
//
// 用法：
//   node --env-file=.env bench/ttft.mjs [--runs 3] [--only cc-luna,cc-terra]
//        [--targets bench/targets.json] [--prompts bench/prompts.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = '你是一个家庭聊天助手。用简体中文回答，直接、清楚、简洁。';
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 1024;

function parseArgs(argv) {
  const args = {
    runs: 3,
    only: null,
    targets: path.join(BENCH_DIR, 'targets.json'),
    prompts: path.join(BENCH_DIR, 'prompts.json')
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--runs') { args.runs = Math.max(1, Number.parseInt(value, 10) || 1); i += 1; }
    else if (key === '--only') { args.only = new Set(value.split(',').map((s) => s.trim()).filter(Boolean)); i += 1; }
    else if (key === '--targets') { args.targets = value; i += 1; }
    else if (key === '--prompts') { args.prompts = value; i += 1; }
    else throw new Error(`未知参数：${key}`);
  }
  return args;
}

function providerConfig(provider) {
  if (provider === 'cc') {
    const baseUrl = (process.env.CC_BASE_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.CC_API_KEY || '';
    if (!baseUrl || !apiKey) return null;
    return { kind: 'openai', baseUrl, apiKey };
  }
  if (provider === 'gemini') {
    const baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    const apiKey = process.env.GEMINI_API_KEY || '';
    if (!apiKey) return null;
    return { kind: 'gemini', baseUrl, apiKey };
  }
  throw new Error(`未知 provider：${provider}`);
}

function buildRequest(target, config, prompt) {
  if (config.kind === 'gemini') {
    return {
      url: `${config.baseUrl}/v1beta/models/${target.model}:streamGenerateContent?alt=sse`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...(target.thinkingLevel ? { thinkingConfig: { thinkingLevel: target.thinkingLevel } } : {})
        }
      }
    };
  }
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: {
      model: target.model,
      stream: true,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      ...(target.reasoningEffort ? { reasoning_effort: target.reasoningEffort } : {})
    }
  };
}

// 从一条 SSE data 里取出正文文本；思考/推理内容不计入首字。
export function extractText(kind, chunk) {
  if (chunk?.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
  if (kind === 'gemini') {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.filter((part) => !part?.thought && typeof part?.text === 'string').map((part) => part.text).join('');
  }
  const delta = chunk?.choices?.[0]?.delta?.content;
  if (typeof delta === 'string') return delta;
  if (Array.isArray(delta)) return delta.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  return '';
}

async function runOnce(target, config, prompt) {
  const { url, headers, body } = buildRequest(target, config, prompt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();
  const result = { headersMs: null, firstTextMs: null, totalMs: null, outputChars: 0, error: null };

  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    result.headersMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const text = extractText(config.kind, JSON.parse(data));
        if (!text) continue;
        if (result.firstTextMs === null) result.firstTextMs = Math.round(performance.now() - startedAt);
        result.outputChars += text.length;
      }
    }
    if (result.firstTextMs === null) throw new Error('没有收到正文内容');
  } catch (error) {
    result.error = error.name === 'AbortError' ? `超时 ${REQUEST_TIMEOUT_MS}ms` : String(error.message || error);
  } finally {
    clearTimeout(timer);
    result.totalMs = Math.round(performance.now() - startedAt);
  }
  return result;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function formatMs(value) {
  return value === null ? '-' : `${(value / 1000).toFixed(1)}s`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompts = JSON.parse(fs.readFileSync(args.prompts, 'utf8'));
  const allTargets = JSON.parse(fs.readFileSync(args.targets, 'utf8'));
  const targets = [];
  for (const target of allTargets) {
    if (args.only && !args.only.has(target.id)) continue;
    const config = providerConfig(target.provider);
    if (!config) {
      console.warn(`跳过 ${target.id}：缺少 ${target.provider === 'cc' ? 'CC_BASE_URL / CC_API_KEY' : 'GEMINI_API_KEY'}`);
      continue;
    }
    targets.push({ ...target, config });
  }
  if (!targets.length) throw new Error('没有可测的目标');

  const total = targets.length * prompts.length * args.runs;
  console.log(`测速：${targets.length} 个目标 × ${prompts.length} 个问题 × ${args.runs} 轮 = ${total} 次请求（串行）\n`);

  const rows = [];
  let done = 0;
  for (let run = 1; run <= args.runs; run += 1) {
    for (const [promptIndex, prompt] of prompts.entries()) {
      // 同一个问题依次问各个目标，并在每轮打乱顺序，减少时间段和缓存带来的偏差。
      const order = [...targets].sort(() => Math.random() - 0.5);
      for (const target of order) {
        const result = await runOnce(target, target.config, prompt);
        done += 1;
        rows.push({ target: target.id, model: target.model, run, promptIndex, ...result });
        const status = result.error ? `失败：${result.error}` : `首字 ${formatMs(result.firstTextMs)}，总计 ${formatMs(result.totalMs)}`;
        console.log(`[${done}/${total}] ${target.id} #${promptIndex + 1} ${status}`);
      }
    }
  }

  console.log('\n结果（首字 = 第一个正文字符到达，不含思考内容）\n');
  const table = targets.map((target) => {
    const mine = rows.filter((row) => row.target === target.id);
    const ok = mine.filter((row) => !row.error);
    const first = ok.map((row) => row.firstTextMs);
    return {
      target: target.id,
      model: target.model,
      ok: `${ok.length}/${mine.length}`,
      first_p50: formatMs(percentile(first, 50)),
      first_p90: formatMs(percentile(first, 90)),
      headers_p50: formatMs(percentile(ok.map((row) => row.headersMs), 50)),
      total_p50: formatMs(percentile(ok.map((row) => row.totalMs), 50)),
      avg_chars: ok.length ? Math.round(ok.reduce((sum, row) => sum + row.outputChars, 0) / ok.length) : 0,
      _sort: percentile(first, 50) ?? Number.POSITIVE_INFINITY
    };
  }).sort((a, b) => a._sort - b._sort).map(({ _sort, ...row }) => row);
  console.table(table);

  const outDir = path.join(BENCH_DIR, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ systemPrompt: SYSTEM_PROMPT, maxOutputTokens: MAX_OUTPUT_TOKENS, summary: table, rows }, null, 2));
  console.log(`\n原始数据：${path.relative(process.cwd(), outFile)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
