#!/usr/bin/env node
// 人格对比：每个系统提示词 × 每个问题 × 每个档位各问一次，结果写成 JSON，供人工比较。
// 复用服务端的上游调用代码，请求格式与线上一致。
//
// 用法：node --env-file=.env bench/persona.mjs [--tiers fast,deep] [--out docs/persona/results.json]
//   系统提示词：docs/persona/*.md；问题：docs/persona/prompts.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTier } from '../server/src/config.js';
import { streamCompletion } from '../server/src/upstream.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERSONA_DIR = path.join(ROOT, 'docs', 'persona');
const CONCURRENCY = 4;

const args = { tiers: ['fast', 'deep'], out: path.join(PERSONA_DIR, 'results.json') };
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i] === '--tiers') args.tiers = process.argv[i + 1].split(',');
  else if (process.argv[i] === '--out') args.out = process.argv[i + 1];
  else throw new Error(`未知参数：${process.argv[i]}`);
}

const providers = {
  cc: { baseUrl: (process.env.CC_BASE_URL || '').replace(/\/+$/, ''), apiKey: process.env.CC_API_KEY || '' },
  gemini: { baseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''), apiKey: process.env.GEMINI_API_KEY || '' }
};
const tiers = args.tiers.map((id) => parseTier(id, process.env[`TIER_${id.toUpperCase()}`]));
const personas = fs.readdirSync(PERSONA_DIR).filter((f) => f.endsWith('.md')).sort()
  .map((file) => ({ id: file.replace(/\.md$/, ''), system: fs.readFileSync(path.join(PERSONA_DIR, file), 'utf8').trim() }));
const prompts = JSON.parse(fs.readFileSync(path.join(PERSONA_DIR, 'prompts.json'), 'utf8'));

const jobs = [];
for (const persona of personas) for (const tier of tiers) prompts.forEach((prompt, index) => jobs.push({ persona, tier, prompt, index }));

const results = [];
let done = 0;
async function worker() {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const startedAt = Date.now();
    let text = '';
    let firstTokenMs = null;
    let error = null;
    let finishReason = null;
    try {
      ({ finishReason } = await streamCompletion({
        tier: job.tier,
        providerConfig: providers[job.tier.provider],
        system: job.persona.system,
        messages: [{ role: 'user', content: job.prompt }],
        signal: AbortSignal.timeout(120000),
        onText: (chunk) => { if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt; text += chunk; }
      }));
    } catch (e) {
      error = e.detail || e.message;
    }
    results.push({ persona: job.persona.id, tier: job.tier.id, model: job.tier.model, promptIndex: job.index, prompt: job.prompt, text, firstTokenMs, totalMs: Date.now() - startedAt, finishReason, error });
    done += 1;
    console.log(`[${done}] ${job.persona.id} ${job.tier.id} #${job.index + 1} ${error ? `失败：${error}` : `${text.length} 字，首字 ${firstTokenMs} ms`}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
results.sort((a, b) => a.promptIndex - b.promptIndex || a.persona.localeCompare(b.persona) || a.tier.localeCompare(b.tier));
fs.writeFileSync(args.out, JSON.stringify({ createdAt: new Date().toISOString(), personas, prompts, results }, null, 2));
console.log(`写入 ${path.relative(process.cwd(), args.out)}`);
