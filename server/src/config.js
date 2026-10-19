// 从环境变量读取配置。档位格式：provider:model:推理强度:输出上限，例如 cc:gpt-6-luna:low:4096。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TIER_LABELS = { fast: '快速', deep: '深入', gemini: 'Gemini' };
export const DEFAULT_TIER = 'fast';

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseTier(id, spec) {
  if (!spec || !spec.trim()) return null;
  const [provider, model, effort = '', maxTokens = ''] = spec.trim().split(':').map((s) => s.trim());
  if (!['cc', 'gemini'].includes(provider) || !model) {
    throw new Error(`TIER_${id.toUpperCase()} 格式应为 provider:model:推理强度:输出上限，provider 只能是 cc 或 gemini`);
  }
  return { id, label: TIER_LABELS[id], provider, model, effort, maxOutputTokens: int(maxTokens, 4096) };
}

export function loadConfig(env = process.env) {
  const tiers = {};
  for (const id of Object.keys(TIER_LABELS)) {
    const tier = parseTier(id, env[`TIER_${id.toUpperCase()}`]);
    if (tier) tiers[id] = tier;
  }
  if (!tiers[DEFAULT_TIER]) throw new Error('必须配置 TIER_FAST');

  const systemPromptPath = env.SYSTEM_PROMPT_PATH || path.join(SERVER_DIR, 'prompts', 'system.md');
  return {
    port: int(env.PORT, 8790),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || path.join(SERVER_DIR, 'data', 'minichat.db'),
    systemPrompt: fs.readFileSync(systemPromptPath, 'utf8').trim(),
    providers: {
      cc: { baseUrl: (env.CC_BASE_URL || '').replace(/\/+$/, ''), apiKey: env.CC_API_KEY || '' },
      gemini: {
        baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
        apiKey: env.GEMINI_API_KEY || ''
      }
    },
    tiers,
    historyMaxMessages: int(env.HISTORY_MAX_MESSAGES, 24),
    historyMaxChars: int(env.HISTORY_MAX_CHARS, 24000),
    upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 120000),
    timeZone: env.TIME_ZONE || 'Asia/Shanghai',
    pingIntervalMs: int(env.SSE_PING_MS, 15000)
  };
}
