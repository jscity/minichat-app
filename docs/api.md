# 接口与数据结构草案（v0）

状态：草案，待用户确认后实现。改动接口时同步更新本文件。

## 约定

- 基础地址：`https://<新域名>`，接口都在 `/api/` 下。
- 鉴权：除 `/healthz` 外，所有请求带 `Authorization: Bearer <token>`。token 无效返回 `401`。
- 请求和响应都是 JSON（UTF-8），流式接口除外。
- id 用服务端生成的 UUID 字符串。时间用毫秒时间戳（整数）。
- 错误格式统一：`{ "error": { "code": "not_found", "message": "会话不存在" } }`，`message` 可以直接展示给用户。
- 只能访问自己的会话；访问别人的会话一律返回 `404`（不暴露是否存在）。

## 健康检查与基础信息

### `GET /healthz`

返回 `200 ok`，不需要鉴权。

### `GET /api/me`

```json
{ "user": { "id": "u_…", "name": "爸爸" } }
```

### `GET /api/tiers`

客户端用来展示档位。客户端只发 `id`，模型名仅用于展示。

```json
{
  "default": "fast",
  "tiers": [
    { "id": "fast", "label": "快速", "model": "gpt-6-luna" },
    { "id": "deep", "label": "深入", "model": "gpt-6-sol" },
    { "id": "gemini", "label": "Gemini", "model": "gemini-3.7-flash" }
  ]
}
```

档位到 provider / 模型 / 输出上限 / 推理强度的映射只写在服务端配置里（环境变量），改模型不需要发新版 App。

## 会话

### `GET /api/conversations`

参数（都可选）：

| 参数 | 说明 |
|---|---|
| `folder` | 只看某个分类；传空字符串表示「未分类」 |
| `q` | 搜索标题和消息内容（第一版用 LIKE，量大了再换 FTS5） |
| `limit` | 默认 50，最大 200 |
| `before` | 分页游标：上一页最后一条的 `updatedAt` |

排序：置顶在前，然后按 `updatedAt` 倒序。不返回已归档的会话（`archived=1` 时只返回已归档）。

```json
{
  "items": [
    {
      "id": "…",
      "title": "红烧肉做法",
      "folder": "做饭",
      "pinned": false,
      "tier": "fast",
      "createdAt": 1760800000000,
      "updatedAt": 1760800500000,
      "preview": "先焯水，再用冰糖炒糖色……"
    }
  ],
  "nextBefore": 1760700000000
}
```

### `POST /api/conversations`

```json
{ "title": "可选", "folder": "可选", "tier": "可选，默认 fast" }
```

返回新会话对象（同列表项格式）。App 也可以不先建会话：直接在新会话界面发第一条消息时再调用这个接口。

### `GET /api/conversations/:id`

```json
{
  "conversation": { "…同列表项…" },
  "messages": [
    { "id": "…", "role": "user", "content": "红烧肉怎么做？", "status": "complete", "createdAt": 1760800000000 },
    {
      "id": "…", "role": "assistant", "content": "……", "status": "complete",
      "tier": "fast", "model": "gpt-6-luna", "firstTokenMs": 2100, "totalMs": 6800,
      "createdAt": 1760800002000
    }
  ]
}
```

### `PATCH /api/conversations/:id`

可改字段：`title`、`folder`（`null` 表示取消分类）、`pinned`、`tier`、`archived`。返回更新后的会话对象。

### `DELETE /api/conversations/:id`

直接删除会话及其消息，返回 `204`。App 端做二次确认；想保留但不想看到的用归档。

### `GET /api/folders`

```json
{ "items": [ { "name": "做饭", "count": 12 }, { "name": "工作", "count": 5 } ] }
```

分类就是会话上的一个字符串字段，不单独建表；列表由现有会话汇总得到。

## 消息（流式）

### `POST /api/conversations/:id/messages`

```json
{ "content": "红烧肉怎么做才不腻？", "tier": "可选，不传用会话的 tier", "clientMessageId": "App 生成的 UUID" }
```

处理流程：

1. 校验后立即把用户消息写入数据库。
2. `clientMessageId` 用于幂等：同一会话里重复提交同一个 id（比如网络断了重试），不会产生重复的用户消息。如果这条消息已经有完成的回复，直接返回那条回复，不再请求模型。
3. 取最近的历史消息（按条数和字符数双重上限，默认 24 条 / 24000 字），加上系统提示词，请求上游模型。
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

- 客户端中途断开：服务端停止上游请求，把已生成的部分存为 `status: "incomplete"`。
- 上游出错：已生成的部分（如有）存为 `status: "error"`，并发送 `error` 事件。
- 回复被长度上限截断：`finishReason: "length"`，客户端可提示「回答较长，已截断」。第一版不做自动续写。
- 推理 / 思考内容不下发给客户端。
- 第一条回复完成后，服务端在后台用「快速」档生成一个简短标题（不阻塞回复）；生成前标题暂用第一条消息的前 20 个字。App 下次刷新列表时拿到新标题。

### `POST /api/conversations/:id/regenerate`

```json
{ "tier": "deep" }
```

用指定档位重新回答会话里最后一条用户消息，返回格式同上（SSE）。第一版直接**替换**最后一条助手消息，不保留多个版本。用于「深入重答」。

## 数据结构（SQLite）

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,     -- sha256(token)，明文 token 只在创建时显示一次
  created_at  INTEGER NOT NULL
);

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  folder      TEXT,                     -- NULL = 未分类
  pinned      INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  tier        TEXT NOT NULL DEFAULT 'fast',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
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

## 服务端配置（环境变量草案）

```env
PORT=8790
DB_PATH=/app/data/minichat.db

CC_BASE_URL=
CC_API_KEY=
GEMINI_API_KEY=

TIER_FAST=cc:gpt-6-luna          # 以 bench 结果为准
TIER_DEEP=cc:gpt-6-sol
TIER_GEMINI=gemini:gemini-3.7-flash

HISTORY_MAX_MESSAGES=24
HISTORY_MAX_CHARS=24000
UPSTREAM_TIMEOUT_MS=120000
```

## 待用户确认

1. 删除会话是直接删除，还是先进「最近删除」保留 30 天？（草案：直接删除 + 归档功能）
2. 「深入重答」替换旧回答，还是保留两个版本可切换？（草案：替换）
3. 系统提示词：一个固定的默认提示词就够了吗？（草案：是，放在 `server/prompts/system.md`）
4. 新域名用什么？
