# MiniChat App

家庭聊天助手：iOS 原生 App + Mac mini 局域网后端。

- 项目目标、范围和开发约定：[CLAUDE.md](CLAUDE.md)
- 决策记录与旧系统数据：[docs/decisions.md](docs/decisions.md)
- 接口与数据结构：[docs/api.md](docs/api.md)

## 服务端（server）

零依赖：Node 24（`node:http`、`node:sqlite`、`node:test`）。接口见 [docs/api.md](docs/api.md)，部署见 [deploy/README.md](deploy/README.md)。

```bash
cd server
npm test                                            # 模拟上游，不消耗额度
./bin/add-user 测试                                  # 本地建用户，打印 token
node --env-file=../.env --disable-warning=ExperimentalWarning src/server.js   # 监听 :8790
```

## iOS App「小红」（ios/MiniChat）

SwiftUI，iOS 26+，零第三方依赖，xcodegen 生成工程（`MiniChat.xcodeproj` 不进 Git）。风格、音效、语音手势沿用「取件码」。

```bash
cd ios/MiniChat
./ios_install.sh          # 构建 Release、用临时 UDID 证书签名、装到已配对的 iPhone
./ios_install.sh --ota    # 改为发布到 https://apps.home.xtvv.com
python3 tools/make_sounds.py                      # 重新生成音效
swift tools/make_icon.swift Sources/Assets.xcassets/AppIcon.appiconset/icon.png   # 重新生成图标
```

模拟器调试（仅 Debug 构建）：启动参数 `-debugOpen <会话id>`、`-debugSend <文字>`、`-debugShow list|settings|typing`；服务器地址和 token 用 `xcrun simctl spawn <设备> defaults write com.xtvv.minichat serverURL|token …` 写入。

## 测速（bench）

在 Mac mini 上运行，使用真实的 key 和网络链路，结果才有参考价值。需要 Node 20.6 或更高版本，无需安装依赖。

```bash
cp .env.example .env    # 填入 CC_BASE_URL、CC_API_KEY、GEMINI_API_KEY
node --env-file=.env bench/ttft.mjs                 # 全部目标，10 个问题 × 3 轮
node --env-file=.env bench/ttft.mjs --runs 1        # 先快速跑一轮
node --env-file=.env bench/ttft.mjs --only cc-luna,cc-terra
```

- 测试目标在 `bench/targets.json`，可以增删（比如试试 CC 的其他 `reasoningEffort`）。
- 问题在 `bench/prompts.json`，都是日常问题。
- `first_p50`：第一个正文字符到达的中位数，不含思考内容。`headers_p50`：收到响应头的中位数，大致反映网络和排队开销。
- 原始数据写入 `bench/results/`（不进 Git）。
- Gemini 使用 `x-goog-api-key` 请求头传 key；如果用中转地址，设置 `GEMINI_BASE_URL`。
- 跑一次全部目标约 180 次请求，会消耗少量额度；`cc-sol` 可以用 `--only` 排除。
