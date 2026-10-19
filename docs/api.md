# 接口与数据结构（v1）

状态：已定稿（2026-10-19），按此实现。改动接口时同步更新本文件。

## 约定

- 基础地址：`https://ai.home.xtvv.com`，接口都在 `/api/` 下。
- 鉴权：除 `/healthz` 外，所有请求带 `Authorization: Bearer <token>`。token 无效返回 `401`。
- 请求和响应都是 JSON（UTF-8），流式接口除外。
- id 用服务端生成的 UUID 字符串。时间用毫秒时间戳（整数）。
- 错误格式统一：`{ "error": { "code": "not_found", "message": "会话不存在" } }`，`message` 可以直接展示给用户。
- 只能访问自己的会话；访问别人的会话一律返回 `404`（不暴露是否存在）。

错误码：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `bad_request` | 参数缺失或不合法（如内容为空、超长、未知档位） |
| 401 | `unauthorized` | 没有 token 或 token 无效 |
| 404 | `not_found` | 会话不存在或不属于当前用户；未知路由 |
| 409 | `busy` | 这个会话正在生成回复，稍后再发 |
| 500 | `internal` | 服务端异常 |

流式过程中的错误通过 SSE `error` 事件下发，code 为 `upstream_error` 或 `upstream_timeout`。

字段限制：消息内容 1–20000 字；标题 1–100 字；分类名 1–30 字。超出返回 `400`。

## 健康检查与基础信息

### `GET /healthz`

返回 `200 ok`，不需要鉴权。

### `GET /api/me`

```json
{ "user": { "id": "…", "name": "爸爸" } }
```

### `GET /api/tiers`

客户端用来展示档位。客户端只发 `id`，模型名仅用于展示。

```json
{
  "default": "fast",
  "tiers": [
    { "id": "fast", "label": "快速", "model": "gpt-6-luna" },
    { "id": "deep", "label": "深入", "model": "gpt-6.1-sol" },
    { "id": "gemini", "label": "Gemini", "model": "gemini-3.8-flash" }
  ]
}
```

档位 id 和显示名固定为上面三个；每个档位对应的 provider / 模型 / 推理强度 / 输出上限只写在服务端环境变量里，改模型不需要发新版 App。没有配置的档位不出现在列表里。

## 会话

会话对象：

```json
{
  "id": "…",
  "title": "红烧肉做法",
  "folder": "做饭",
  "pinned": false,
  "archived": false,
  "tier": "fast",
  "createdAt": 1760800000000,
  "updatedAt": 1760800500000,
  "preview": "先焯水，再用冰糖炒糖色……"
}
```

- `folder` 为 `null` 表示未分类。
- `preview` 是最后一条消息的前 60 个字，没有消息时为空字符串。
- `updatedAt` 在新消息写入、改名、改分类时更新；置顶、归档和切换档位不改变它，避免列表顺序乱跳。

### `GET /api/conversations`

参数（都可选）：

| 参数 | 说明 |
|---|---|
| `folder` | 只看某个分类；传空字符串表示「未分类」 |
| `q` | 搜索标题和消息内容（第一版用 LIKE，量大了再换 FTS5） |
| `archived` | `1` 时只返回已归档的会话；默认不返回已归档的 |
| `limit` | 默认 50，最大 200 |
| `before` | 分页游标：上一页返回的 `nextBefore` |

排序：置顶在前，然后按 `updatedAt` 倒序。

分页：第一页（不带 `before`）返回全部置顶会话，再加最多 `limit` 条未置顶会话；之后的页只返回 `updatedAt < before` 的未置顶会话。还有更多时 `nextBefore` 是本页最后一条未置顶会话的 `updatedAt`，否则为 `null`。

```json
{ "items": [ { "…会话对象…" } ], "nextBefore": 1760700000000 }
```

### `POST /api/conversations`

```json
{ "title": "可选", "folder": "可选", "tier": "可选，默认 fast" }
```

返回 `201` 和新会话对象。不传标题时为「新对话」，发第一条消息后自动替换（见下文）。App 也可以不先建会话：在新会话界面发第一条消息时再调用这个接口。

### `GET /api/conversations/:id`

```json
{
  "conversation": { "…会话对象…" },
  "messages": [
    { "id": "…", "role": "user", "content": "红烧肉怎么做？", "status": "complete", "clientMessageId": "…", "createdAt": 1760800000000 },
    {
      "id": "…", "role": "assistant", "content": "……", "status": "complete",
      "replyTo": "…", "tier": "fast", "model": "gpt-6-luna", "finishReason": "stop", "errorCode": null,
      "firstTokenMs": 2100, "totalMs": 6800, "createdAt": 1760800002000
    }
  ]
}
```

消息按 `createdAt` 正序，返回全部消息。

### `PATCH /api/conversations/:id`

可改字段：`title`、`folder`（`null` 或空字符串表示取消分类）、`pinned`、`tier`、`archived`。只传要改的字段。返回更新后的会话对象。

手动改过标题后，后台自动标题不会再覆盖它。

### `DELETE /api/conversations/:id`

直接删除会话及其消息，返回 `204`，不可恢复。App 端做二次确认；想保留但不想看到的用归档（`PATCH {"archived": true}`）。

### `GET /api/folders`

```json
{ "items": [ { "name": "做饭", "count": 12 }, { "name": "工作", "count": 5 } ] }
```

分类就是会话上的一个字符串字段，不单独建表；列表由当前用户未归档的会话汇总得到，按名称排序。

## 消息（流式）

### `POST /api/conversations/:id/messages`

```json
{ "content": "红烧肉怎么做才不腻？", "tier": "可选，不传用会话的 tier", "clientMessageId": "App 生成的 UUID，必填" }
```

处理流程：

1. 校验后立即把用户消息写入数据库。同一个会话同时只能有一个回复在生成，否则返回 `409 busy`。
2. `clientMessageId` 用于幂等：同一会话里重复提交同一个 id（比如网络断了重试），不会产生重复的用户消息。
   - 这条消息已经有 `complete` 的回复：不再请求模型，按正常格式回放那条回复（`start` → 一个包含全文的 `delta` → `done`）。
   - 还没有回复，或回复是 `incomplete` / `error`：重新生成，新回复替换旧回复。
3. 取最近的历史消息（按条数和字符数双重上限，默认 24 条 / 24000 字，从最新往前取，至少包含当前这条），跳过内容为空的消息，加上系统提示词，请求上游模型。
4. 以 SSE 流式返回（`Content-Type: text/event-stream`）。

事件：

```text
event: start
data: {"userMessage":{"id":"…","createdAt":…},"assistantMessageId":"…","tier":"fast","model":"gpt-6-luna"}

event: delta
data: {"text":"先"}

event: delta
data: {"text":"焯水……"}

event: done
data: {"message":{"id":"…","status":"complete","finishReason":"stop","firstTokenMs":2100,"totalMs":6800},"conversation":{"updatedAt":…}}
```

出错时：

```text
event: error
data: {"code":"upstream_timeout","message":"模型响应超时，请重试或切换档位。"}
```

- 等待期间每 15 秒发一行 SSE 注释（`: ping`），防止代理断开空闲连接。
- 客户端中途断开：服务端停止上游请求，把已生成的部分存为 `status: "incomplete"`。
- 上游出错或超时：已生成的部分（如有）存为 `status: "error"` 并记录 `errorCode`，然后发送 `error` 事件。
- 回复被长度上限截断：`finishReason: "length"`，客户端可提示「回答较长，已截断」。不做自动续写。
- 推理 / 思考内容不下发给客户端，也不保存。
- 会话的第一条回复完成后，如果标题没有手动改过，服务端在后台用「快速」档生成一个简短标题（不阻塞回复）。生成前标题暂用第一条消息的前 20 个字。App 下次刷新列表时拿到新标题。

### `POST /api/conversations/:id/regenerate`

```json
{ "tier": "deep" }
```

用指定档位（不传则用会话的 tier）重新回答会话里最后一条用户消息，返回格式同上（SSE，`start` 里的 `userMessage` 是被重答的那条）。用于「深入重答」。

- 只保留一个版本：新回复保存时删除这条用户消息原来的回复。
- 如果新回复一个字都没生成就失败了，保留原来的回复，只发送 `error` 事件。
- 会话里没有用户消息时返回 `400`。

## 数据结构（SQLite）

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,     -- sha256(token)，明文 token 只在创建时显示一次
  created_at  INTEGER NOT NULL
);

CREATE TABLE conversations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  title_source   TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
  folder         TEXT,                  -- NULL = 未分类
  pinned         INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  tier           TEXT NOT NULL DEFAULT 'fast',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_conv_user_updated ON conversations(user_id, archived, pinned DESC, updated_at DESC);

CREATE TABLE messages (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'incomplete', 'error')),
  client_message_id  TEXT,              -- 仅用户消息
  reply_to           TEXT REFERENCES messages(id) ON DELETE CASCADE,  -- 助手消息对应的用户消息
  tier               TEXT,              -- 以下仅助手消息
  model              TEXT,
  finish_reason      TEXT,
  error_code         TEXT,
  first_token_ms     INTEGER,
  total_ms           INTEGER,
  input_chars        INTEGER,
  created_at         INTEGER NOT NULL,
  UNIQUE (conversation_id, client_message_id)
);
CREATE INDEX idx_msg_conv_created ON messages(conversation_id, created_at);
```

- 助手消息上的耗时字段就是请求日志，用来持续检查「快速档首字 p50 ≤ 3 秒」，替代旧的独立审计服务。
- 用户管理第一版用命令行脚本：`server/bin/add-user <名字>`，打印 token，填进 App 设置。

## 系统提示词

一个固定的提示词，放在 `server/prompts/system.md`，所有档位、所有用户共用，启动时读取。改它只需重启服务，不需要改接口或发版。

- 人格：「小红」，以旧系统 SAVAGE 为基础，加上陪伴者的部分（先接住情绪、可以表达感受、替对方保守秘密），日常问题尽量短。选型过程见 `docs/persona/` 和 [decisions.md](decisions.md)。
- 每次请求时在末尾追加一行当天日期，例如「今天是 2026年10月19日星期一（北京时间）。」，时区由 `TIME_ZONE` 配置，默认 `Asia/Shanghai`。固定部分在前，日期在后，便于上游做前缀缓存。

## 服务端配置（环境变量）

```env
PORT=8790
DB_PATH=/app/data/minichat.db

CC_BASE_URL=https://api.4xia.win/v1
CC_API_KEY=
GEMINI_API_KEY=
# GEMINI_BASE_URL=https://generativelanguage.googleapis.com

# 格式：provider:model:推理强度:输出上限（token）。留空则不提供该档位。
TIER_FAST=cc:gpt-6-luna:low:4096
TIER_DEEP=cc:gpt-6.1-sol:medium:8192
TIER_GEMINI=gemini:gemini-3.8-flash:low:4096

HISTORY_MAX_MESSAGES=24
HISTORY_MAX_CHARS=24000
UPSTREAM_TIMEOUT_MS=120000
# TIME_ZONE=Asia/Shanghai        # 系统提示词里的「今天是…」按这个时区
```

- CC 的推理强度写入 `reasoning_effort`，Gemini 的写入 `generationConfig.thinkingConfig.thinkingLevel`。
- 模型选择依据见 [decisions.md](decisions.md) 的 Bench 结果：快速档 Luna low（首字 p50 1.5 s），深入档 6.1 Sol medium（p50 2.4 s），Gemini 备选 3.8 Flash low（p50 1.6 s；3.8 不支持 `minimal`）。
