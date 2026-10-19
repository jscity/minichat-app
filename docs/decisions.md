# 决策记录

## 2026-10：为什么新起项目

旧版 MiniChatV Home（React 网页 + Express + 独立审计服务）的问题不在加载速度（前端 gzip 后约 105 KB），而在复杂度：

- 后端用二十多个正则猜意图（金价、八卦、游戏、新闻、医疗/法律/财务、代码、数学……），据此选模型、输出长度、是否联网。
- 附带搜索流水线、自动续写、滚动摘要、长期记忆、5 种人设、3 家模型十几个型号、GPT-6 Astra 额度策略。
- 7 月以来约 15 个提交中有 10 个是升级模型、调路由、调输出长度；多会话这个日常最需要的功能一直没做。
- 会话只存在浏览器里，只有一个会话，新建会话会丢掉旧的。

结论：两端都新起。只从旧代码搬 CC 和 Gemini 的请求与流式解析，其余不带。旧系统冻结、继续运行作为备用。

## 旧系统实测数据（审计库，近 60 天，chat_request）

首字耗时 = 上游开始请求到第一个正文字符（不含搜索耗时；有搜索时用户实际等待还要再加搜索时间）。

| 模型 | 请求数 | p50 首字 | p90 首字 | 有搜索 | 平均搜索耗时 |
|---|---|---|---|---|---|
| gemini-3.7-flash | 666 | 5.0 s | 7.9 s | 4 | 1.6 s |
| gemini-3.8-flash | 386 | 8.1 s | 13.0 s | 6 | 0.8 s |
| gemini-3.1-pro-preview | 168 | 13.7 s | 19.4 s | 38 | 1.1 s |
| gpt-5.6-terra | 103 | 2.9 s | 5.7 s | 1 | 1.1 s |
| qwen38（本地 Ollama） | 37 | 44.4 s | 94.2 s | 2 | 1.5 s |
| gpt-6-sol | 11 | 10.4 s | 18.2 s | 3 | 0.9 s |
| gpt-6-astra | 9 | 2.5 s | 5.1 s | 1 | 0.9 s |
| gemma-4-e4b（本地） | 5 | 28.6 s | 47.7 s | 0 | - |
| gpt-5.6-sol | 2 | 11.4 s | 21.7 s | 1 | 1.3 s |
| gpt-6-luna | 1 | 2.5 s | 2.5 s | 0 | - |

被路由到 Gemini Pro 的原因（全部历史）：

| route_reason | 次数 |
|---|---|
| high_stakes（医疗/法律/财务正则） | 271 |
| deep_request | 133 |
| continue_response | 33 |
| coding | 32 |
| medium_input | 26 |
| 其他 | 27 |

### 由此得出的决定

| 决定 | 依据 |
|---|---|
| 默认档换成 CC | Terra p50 2.9 s，Gemini Flash 5–8 s |
| 不做自动路由 | 一半以上的 Pro 请求来自「高风险」正则，每次多等约 10 秒，且大概率有大量误判 |
| 第一版不做搜索 | Flash / Terra 上触发率不到 1% |
| 去掉本地模型 | qwen38 p90 94 s，基本不可用 |
| Gemini 只留 3.7 Flash 作备选 | 3.8 Flash 比 3.7 慢约 60%（可能与思考强度有关，待 bench 验证 minimal） |
| 深入档用 CC Sol | p50 约 10 s，只在用户手动选择时可接受 |

## 待定

- ~~「快速」档用 Luna 还是 Terra~~：已定 Luna，见下方 Bench 结果。
- ~~Gemini 慢是模型 / 思考强度，还是网络中转~~：是思考强度，见下方 Bench 结果。

## Bench 结果

### 2026-10-19 · Mac mini（家庭宽带，CC 走 CPA `api.4xia.win`，Gemini 直连官方）

```bash
cd /Users/macmini/services/minichat-app
node --env-file=.env bench/ttft.mjs --runs 3     # Node 22.22，10 个问题 × 3 轮 × 6 个目标，串行，全部成功
```

条件：系统提示词一句话、单轮无历史、输出上限 1024 token；CC 的 `reasoning_effort` 都是 `low`。

| 目标 | 模型 | 成功 | 首字 p50 | 首字 p90 | 首字最大 | 首字 >3s | 总耗时 p50 | 总耗时 p90 |
|---|---|---|---|---|---|---|---|---|
| cc-luna | gpt-6-luna (low) | 30/30 | 1.5 s | 2.6 s | 3.3 s | 2 | 3.8 s | 9.0 s |
| cc-sol | gpt-6-sol (low) | 30/30 | 1.5 s | 2.6 s | 2.8 s | 0 | 4.4 s | 7.5 s |
| gg-3.8-flash-low | gemini-3.8-flash (low) | 30/30 | 1.6 s | 2.1 s | 8.5 s | 2 | 3.6 s | 6.9 s |
| gg-3.7-flash-low | gemini-3.7-flash (low) | 30/30 | 1.7 s | 2.3 s | 4.0 s | 1 | 3.7 s | 6.3 s |
| cc-terra | gpt-5.6-terra (low) | 30/30 | 1.9 s | 6.0 s | 13.3 s | 7 | 6.9 s | 27.7 s |
| gg-3.8-flash-default | gemini-3.8-flash（不传 thinkingLevel） | 30/30 | 5.8 s | 7.2 s | 8.6 s | 30 | 7.4 s | 10.0 s |

说明：

- 原计划的 `gemini-3.8-flash` + `thinkingLevel: minimal` 被接口拒绝（HTTP 400 “Thinking level MINIMAL is not supported for this model”），换成「不传 thinkingLevel」（模型默认思考强度）做对照。
- 两家上游都在第一个正文到达时才返回响应头（`headers_p50` 与 `first_p50` 相同，差值 ≤ 62 ms），所以这个指标分不出网络开销和模型耗时。不过同一条链路上 3.8 low 和 3.8 默认相差约 4 秒，足以说明差别来自模型本身。
- 原始数据在 Mac mini 的 `bench/results/2026-10-19T01-28-15-869Z.json`（不进 Git）。

### 结论

1. **「快速」档用 Luna（`gpt-6-luna`，`reasoning_effort=low`）。** 首字 p50 1.5 s、p90 2.6 s，30 次中只有 2 次超过 3 秒。Terra 的 p50 接近（1.9 s），但长尾明显：p90 6.0 s，最慢 13.3 s，总耗时 p90 27.7 s。
2. **Gemini 3.8 变慢是因为思考强度。** 同一模型、同一链路，`low` 的 p50 是 1.6 s，默认强度是 5.8 s，30 次全部超过 3 秒。旧系统审计里 3.8 的 p50 是 8.1 s，量级与默认强度一致，再加上旧系统的长系统提示词和历史。旧系统是否真的给 3.8 发了 `low`，这次没有核实（不读它的 `.env`）。
3. **Gemini 备选档可以用 3.8 low 替代 3.7 low**，两者速度相当（1.6 s / 1.7 s）。服务端配置里写 `thinkingLevel=low`。
4. **Sol 在 `low` 下首字和 Luna 一样快**，旧系统 10 秒以上的耗时来自更高的推理强度。「深入」档用 Sol，推理强度在服务端配置，默认 `medium`，上线后以服务端记录的耗时为准再调。

### 2026-10-19 补测 · 最新型号与「深入」档推理强度

查询两家 `/v1/models`（同一把 key）：CC 新增 `gpt-6.1-sol`（2026-09-29 发布）；Luna 仍只有 `gpt-6-luna`。Gemini 新增 `gemini-4-argon`（2026-09-30 发布的旗舰模型，对应 Pro 级别，不是 Flash）；Flash 系列最新仍是 `gemini-3.8-flash`。

```bash
node --env-file=.env bench/ttft.mjs --runs 3 --only cc-sol-medium,cc-6.1-sol-medium,gg-4-argon-low
```

| 目标 | 模型 | 成功 | 首字 p50 | 首字 p90 | 首字最大 | 首字 >3s | 总耗时 p50 | 总耗时 p90 | 平均字数 |
|---|---|---|---|---|---|---|---|---|---|
| cc-sol-medium | gpt-6-sol (medium) | 30/30 | 2.0 s | 7.0 s | 8.4 s | 10 | 4.7 s | 8.8 s | 176 |
| cc-6.1-sol-medium | gpt-6.1-sol (medium) | 30/30 | 2.4 s | 5.2 s | 8.2 s | 9 | 6.3 s | 18.5 s | 340 |
| gg-4-argon-low | gemini-4-argon (low) | 29/30 | 8.6 s | 25.6 s | 44.0 s | 23 | 11.5 s | 30.4 s | 407 |

原始数据：Mac mini `bench/results/2026-10-19T02-40-17-326Z.json`。Argon 有 1 次 90 秒超时。

结论：

- 「深入」档用 **`gpt-6.1-sol`，`reasoning_effort=medium`**。首字和 6 Sol 相当（p50 2.4 s，p90 5.2 s，比 6 Sol 的 7.0 s 更稳），回答篇幅约是 6 Sol 的两倍，更符合「深入」的定位。总耗时更长，这是篇幅更长的结果。
- Gemini 4 Argon 首字 p50 8.6 s、p90 25.6 s，作为备选档太慢，不采用。Gemini 备选档用 `gemini-3.8-flash` + `thinkingLevel=low`。
