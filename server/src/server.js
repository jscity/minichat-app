// 入口：读取配置、打开数据库、启动 HTTP 服务。

import http from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = openDb(config.dbPath);
const { handler, chat } = createApp({ config, store });

const server = http.createServer(handler);
// 流式回复可能持续数分钟，不使用默认的请求超时。
server.requestTimeout = 0;
server.listen(config.port, config.host, () => {
  const tiers = Object.values(config.tiers).map((t) => `${t.id}=${t.provider}:${t.model}:${t.effort}`).join(' ');
  console.log(`minichat server listening on ${config.host}:${config.port} (${tiers})`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  server.close();
  chat.abortAll();
  const deadline = setTimeout(() => process.exit(0), 5000);
  deadline.unref();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await chat.drain();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
