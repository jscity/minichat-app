# 部署到 Mac mini

目标：`https://ai.home.xtvv.com` → Caddy → `127.0.0.1:8790` → 容器 `minichat-app`（Compose 项目 `minichat-app`）。

| 项目 | 值 |
|---|---|
| 服务器目录 | `/Users/macmini/services/minichat-app` |
| 容器 | `minichat-app`，`user 501:20`，只读根文件系统，`cap_drop ALL` |
| 端口 | `127.0.0.1:8790`，不开放公网 |
| 数据库 | `data/minichat.db`（WAL 模式，备份时连同 `-wal`、`-shm` 一起） |
| 配置 | `.env`（权限 600，不进 Git；格式见仓库根目录 `.env.example`） |
| 系统提示词 | `server/prompts/system.md`，只读挂载，改完 `docker compose restart` |

不要碰旧系统：`minichatv-home`（8787 / 8788、`chat.home.xtvv.com`）保持原样。

## 首次部署

在开发机仓库根目录：

```sh
rsync -a --delete \
  --exclude .git --exclude .env --exclude data --exclude bench/results --exclude ios \
  --exclude 'node_modules' --exclude .DS_Store \
  ./ macmini:/Users/macmini/services/minichat-app/
ssh macmini 'cd /Users/macmini/services/minichat-app && grep -c "^TIER_FAST=" .env'   # 确认 .env 里有档位配置
ssh macmini 'cd /Users/macmini/services/minichat-app && /usr/local/bin/docker compose up -d --build'
ssh macmini 'curl -fsS http://127.0.0.1:8790/healthz'
```

`.env` 里除了 key，还需要 `.env.example` 中「以下仅 server 使用」的档位等配置。

加家庭成员（每人一个 token，只显示一次，填进 App 设置）：

```sh
ssh macmini 'cd /Users/macmini/services/minichat-app && /usr/local/bin/docker compose exec minichat-app bin/add-user 爸爸'
```

入口：

1. AdGuard Home 添加 DNS 重写 `ai.home.xtvv.com -> 192.168.123.123`（管理页面操作）。
2. 备份并修改 Caddyfile，加入 [Caddyfile.snippet](Caddyfile.snippet) 中的 `@ai` 段，然后 `caddy validate` 和 `caddy reload`。
3. 验证：

```sh
curl -fsS https://ai.home.xtvv.com/healthz
curl -sS -H "Authorization: Bearer <token>" https://ai.home.xtvv.com/api/tiers
# 流式：确认 delta 是一段段到达，而不是最后一次性出现
curl -sS -N -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"content":"你好","clientMessageId":"deploy-check-1"}' \
  https://ai.home.xtvv.com/api/conversations/<会话id>/messages
```

部署后同步更新「服务器管理」：`00_总览/服务清单.md`、`00_总览/域名与入口清单.md`、`30_应用服务/minichat-app/README.md`，并在协作日志追加记录。

## 更新

```sh
rsync …（同上）
ssh macmini 'cd /Users/macmini/services/minichat-app && /usr/local/bin/docker compose up -d --build'
```

只改系统提示词：同步 `server/prompts/system.md` 后 `docker compose restart`。只改档位或模型：改 `.env` 后 `docker compose up -d`。

## 日常查看

```sh
ssh macmini
cd /Users/macmini/services/minichat-app
/usr/local/bin/docker compose ps
/usr/local/bin/docker compose logs --tail 50      # 每条回复一行 JSON：档位、模型、状态、首字、总耗时
```

首字耗时统计（快速档 p50 是否 ≤ 3 秒）：

```sh
sqlite3 data/minichat.db "SELECT tier, model, COUNT(*), AVG(first_token_ms) FROM messages
  WHERE role='assistant' AND status='complete' AND created_at > (strftime('%s','now','-7 days')*1000) GROUP BY 1,2"
```

## 回滚

`docker compose down`；删除 Caddyfile 中 `@ai` 段（或恢复备份）后 reload；删除 AdGuard 重写。`data/` 保留即可，重新部署后会话还在。
