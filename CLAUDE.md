# MiniChat App

给家人用的聊天助手：iOS 原生 App + Mac mini 上的精简后端。打开就能用、回复快、按话题保存对话、语音转文字输入。

开始任何工作前先读完本文件。新增功能前，对照下面的「目标」和「明确不做」。

## 目标

- 流式聊天，第一个字尽快出现。
- 多会话：新建、切换、改名、分类、置顶、搜索；旧会话永不丢失（服务器为准，手机做缓存）。
- 语音转文字后作为普通文本发送（按住说话，松开发送）。
- 家庭成员各自独立的会话，每人一个 token。
- 两档模型：「快速」（默认）和「深入」（手动选择或点「深入重答」）。

## 明确不做

除非用户明确改变范围，否则不做、也不预留复杂扩展点：

- 语音对话 / TTS、图片生成、图片理解。
- 记忆系统、会话摘要（以后再议，届时基于服务器上的会话数据做）。
- 按关键词或正则自动判断意图来切换模型、联网搜索或输出长度。需要判断的地方交给用户手动选择。
- 联网搜索（旧系统统计触发率不到 1%；以后如需要，做成手动开关）。
- 多种人设（SOUL）切换、主题切换、解锁界面。只有一个固定人格「小红」（以旧系统 SAVAGE 为基础，加上陪伴者的部分），写在 `server/prompts/system.md`。
- 智能体、工具调用、插件。
- 本地模型（Ollama/QQ，旧系统 p50 首字 44 秒）。

**加功能的判断标准：它是否让聊天更快、更稳、或者更容易找回旧对话？三者都不是就不加。**

## 成功标准

- 打开 App 1 秒内可以输入。
- 「快速」档首字 p50 ≤ 3 秒（以 `bench/` 实测和服务端记录为准）。
- 会话不丢；网络中断后重试不产生重复消息。
- 几个月不需要调路由或改模型配置以外的东西。

## 架构与部署

```
MacBook（开发）                     Mac mini（局域网服务器）
├─ Xcode 编译 iOS App               ├─ server/：Node + SQLite，Docker Compose 项目 minichat-app
├─ 用户自己的签名脚本打包 .ipa       │   只绑定 127.0.0.1:8790，由 Caddy 提供新域名
└─ 上传到 Mac mini 做 OTA 分发       ├─ OTA：Caddy 静态目录提供 .ipa + manifest.plist
                                    └─ data/：SQLite 数据库（不进 Git）
```

- 新域名：`ai.home.xtvv.com`。OTA（`itms-services://`）要求 HTTPS，且设备必须信任该证书；若使用自签名 CA，家人设备需要安装并在「证书信任设置」里完全信任。App 访问 API 同理（ATS）。
- 签名和 OTA 打包流程以用户现有脚本为准，不要另起一套。
- iOS：SwiftUI，最低 iOS 26（本机中文识别 `SpeechAnalyzer` 需要），本地缓存用一个 JSON 文件（同「取件码」），`URLSession.bytes` 读 SSE。界面、音效和语音手势沿用「取件码」的 Pip-Boy 风格（源码 `~/Documents/哔哔小子/ios/Pickup`）：默认语音输入，打字是备选。
- 签名与安装：`ios/MiniChat/ios_install.sh`（直装已配对 iPhone）/ `--ota`（发布到 apps.home.xtvv.com），证书为临时 UDID 证书，只有描述文件里登记的设备能装。xiaoxi 的手机用她自己的证书：`MINICHAT_VARIANT=xiaoxi ./ios_install.sh --ota`（Bundle ID `com.xtvv.minichat.xiaoxi`）。

## 旧系统：不要动

旧版 MiniChatV Home（仓库 `jscity/minichatv-home`）仍在 Mac mini 上运行，作为备用：

- 目录 `/Users/macmini/services/minichatv-home`，端口 8787 / 8788，旧域名。
- **不要修改、停止、重建它，不要读写它的 `.env` 和 `data/`。** 新服务不得占用它的端口、容器名或 Compose 项目名。
- 可以只读参考它的代码：`minichat/api/providers.js` 和 `minichat/api/chat.js` 里三家模型的请求格式与流式解析（只搬 CC 和 Gemini）。
- 它的审计库 `minichat-audit/data/audit.db` 可只读查询，用于对比。

## 关键决策

依据见 [docs/decisions.md](docs/decisions.md)。

- 「快速」档（默认）用 CC `gpt-6-luna`（low）；「深入」档用 CC `gpt-6.1-sol`（medium）；Gemini `gemini-3.8-flash`（low）仅作手动备选。依据见 2026-10-19 的 bench 结果。
- 客户端只发档位 id（如 `fast` / `deep`），不发模型名；档位到模型的映射只在服务端配置里。
- 服务端为会话的唯一真实来源；每条助手消息记录模型、首字耗时、总耗时，替代旧的独立审计服务。
- 上下文只取最近若干条消息（按条数和字符数双重上限），不做摘要。

接口与数据结构见 [docs/api.md](docs/api.md)（v1 已定稿）。

## 目录

```
bench/    首字耗时测速脚本（零依赖）
docs/     决策记录、接口定义
server/   后端（Node 24 零依赖，见 README）
ios/      iOS App「小红」（ios/MiniChat，xcodegen）
deploy/   Mac mini 部署说明与 Caddy 配置片段（compose 在仓库根目录）
```

## 开发约定

- 依赖尽量少。服务端用 Node 24、ESM JavaScript、`node:test`；SQLite 优先用内置 `node:sqlite`，不行再换 `better-sqlite3`。
- 每个服务端改动配套测试，提交前跑通 `npm test`。
- 不提交任何 API key、token、家庭成员数据、`.env`、数据库文件。示例配置写进 `.env.example`。
- 界面文案用简体中文。
- 环境变量命名直白：Gemini 的 key 叫 `GEMINI_API_KEY`（旧系统误用了 `OPENAI_API_KEY`，不要沿用）。

## 当前阶段

- [x] 1. 在 Mac mini 上跑 `bench/`，确定「快速」档模型，把结果补进 `docs/decisions.md`。
- [x] 2. 用户确认 `docs/api.md`，定稿为 v1（删除 = 直接删除 + 归档；深入重答替换原回答；一个固定系统提示词；域名 `ai.home.xtvv.com`）。
- [x] 3. 服务端第一版：鉴权、会话增删改查与归档、分类、档位、流式消息、深入重答、自动标题、`bin/add-user`、33 个测试。2026-10-19 已部署到 `https://ai.home.xtvv.com`（Mac mini `/Users/macmini/services/minichat-app`，容器 `minichat-app`），HTTPS 流式验证通过。
- [x] 4. 人格设计：三份草稿对比后选定 B（SAVAGE + 陪伴者），命名「小红」，放开情绪表达，日常问题尽量短；系统提示词末尾自动加当天日期。过程见 `docs/persona/`、`docs/decisions.md`。
- [x] 5. iOS 第一版「小红」（2026-10-19）：设置（粘贴服务器地址 + token）、会话列表（置顶 / 改名 / 归档 / 删除）、聊天、档位切换、深入重答、语音输入（按住说话松开发送、上滑取消、双击连续说）、打字备选。已直装并 OTA 发布。
- [ ] 6. 分类和搜索界面、归档列表；真机试用后的调整。
