# DSH-Feishu Bridge

通过飞书/Lark 官方 Bot API WebSocket 长连接，将飞书作为 **DeepSeek Harness（DSH）** 的受控聊天入口。使用 CardKit v2 原生元素流式 API 输出。

本项目由 [pi-feishu-bridge](https://github.com/zxsctxx/pi-feishu-bridge)（Pi agent 扩展）移植而来：飞书层（WebSocket 客户端、CardKit 流式卡片、访问控制、消息队列、澄清卡）原样复用，Agent 对接层替换为参考 [dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) 的 DSH 对接逻辑（`ctx.agents` 服务 + `session/event` 事件流）。

## 架构

```
飞书用户 → 飞书 WebSocket → dsh-feishu-bridge → ctx.agents → dsh agent loop → LLM
                                 ↑                                  │
                                 └──── session/event ───────────────┘
                                      (assistant/chunk → CardKit 流式卡片)
```

- **入站**：飞书消息 → 访问控制 → 斜杠命令/消息队列 → `createUserMessage` → `agent.followup()`
- **出站**：监听 `session/event`：`assistant/chunk`（text/reasoning delta）、`tool/call`、`tool/result`、`assistant/message`、`turn/end` → 单卡流式刷新，`turn/end` 封卡
- **会话**：一个插件实例 = 一个共享 dsh Agent（由 `preset`/`cwd` 决定），多个飞书 chat 通过互斥队列共享（对齐 pi-feishu-bridge 的安全边界哲学——**不伪造多租户隔离**，多租户请分别启动 DSH profile）

## 主要能力

- **流式卡片输出** — CardKit 原生流式刷新，thinking 与工具步骤面板实时展示
- **自动降级保障** — CardKit 不可用时自动降级为静态卡片或纯文本，答案必达
- **信息页脚** — 每轮回答末尾展示模型、耗时、token、缓存命中、stop_reason 等
- **访问控制** — allowlist 白名单 + 群聊 @ 校验，未授权请求无法进入 Agent
- **弹性容错** — 限频、网络超时、消息撤回等异常自动恢复或优雅终止
- **媒体收发** — 文本/富文本/图片/文件/音频/视频，支持 Reaction 输入指示
- **实用工具** — `send_to_feishu` / `send_image_to_feishu` / `send_file_to_feishu` / `ask_feishu`（注册进共享 agent 的 scoped 工具集）
- **会话管理** — `/new` 清空上下文；`/resume` 列出/恢复持久化会话；`/model` 切换模型（fork 重建）；`/stop` 中断

## 安装

### 方式一：本地路径安装到 DSH profile

```bash
# 构建
cd /path/to/dsh-feishu-bridge
npm install && npm run build

# 安装到 profile（等价于在 profile 目录执行 pnpm add，本地路径以链接方式安装）
dsh plugin --profile feishu add /path/to/dsh-feishu-bridge

# 启用插件：把插件行插入 profile 的 patch 层（dsh 首次创建 profile 时自动生成）
#   $DSH_HOME/profiles/feishu/cordis.patch.yml 添加：
#   - insert:
#       - id: feishu-bridge
#         name: dsh-feishu-bridge

# 启动（环境变量提供飞书凭据）
export FEISHU_APP_ID="你的AppID" FEISHU_APP_SECRET="你的AppSecret"
dsh --profile feishu
```

### 方式二：--patch 开发模式

```bash
cd /path/to/deepseek-harness
export FEISHU_APP_ID="xxx" FEISHU_APP_SECRET="xxx"
pnpm dsh web --patch /path/to/dsh-feishu-bridge/cordis.yml
```

## 配置

配置来源优先级：**cordis.yml config 字段 → `FEISHU_*` 环境变量**（覆盖同名项）。

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `appId` / `appSecret` | 必填 | 飞书应用凭据（或 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`） |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `provider` / `model` | 宿主默认 | LLM 路由；缺省沿用宿主默认模型 |
| `preset` | 宿主默认 | Agent preset id（工具集/prompt 等） |
| `cwd` | `process.cwd()` | Agent 工作目录 |
| `registerBridgeTools` | `true` | 是否把飞书工具注册进共享 agent |
| `flushIntervalMs` | 200 | 流式刷新节流间隔(ms) |
| `showThinking` | `false` | 默认不展示推理正文 |
| `accessPolicy` | `allowlist` | 默认白名单；开发可显式设 `open` |
| `allowedChatIds` / `allowedOpenIds` | `[]` | 见下方匹配规则 |
| `requireMentionInGroup` | `false` | 生产群聊建议 `true` |
| `clarifyTimeoutSec` | 300 | `ask_feishu` 默认等待时间 |
| `taskTimeoutSec` | 900 | 单轮 Agent 硬超时（秒），超时 abort 并终态封卡 |
| `sameChatBusyPolicy` | `queue` | 同 chat 忙时：`queue` 排队；`interrupt` 打断当前并只跑最新消息 |
| `sessionIdleTimeout` | 1800000 | Agent 闲置超时(ms)，超时 dispose，下条消息自动恢复 |
| `footer` | 两行默认 | 终态卡片页脚布局（`lines` 二维数组） |
| `debug` | `false` | 调试日志（也可 `FEISHU_DEBUG=1`） |

全部字段与默认值见 `src/config.ts` 的 Schema 注释。

### 如何配置 allowlist 才能对话

1. 先启动 Bot，用你的账号给 Bot 发任意消息。
2. 若未授权，Bot 会回复你的 **open_id**（`ou_…`）和当前 **chat_id**（`oc_…`）。
3. 把 `allowedOpenIds` / `allowedChatIds` 写入 DSH 的 cordis 配置（或环境变量）后 `/feishu config reload`。

匹配规则：

| 配置 | 效果 |
|------|------|
| 只配 `allowedOpenIds` | 该用户在任意会话可聊 |
| 只配 `allowedChatIds` | 该会话内任意用户可聊 |
| **两者都配** | 必须**同时**匹配（更严） |
| 都为空 | 全部拒绝 |

私聊一般只写 `allowedOpenIds` 即可；群聊建议两者都写，并开启 `requireMentionInGroup`。

## 飞书命令

| 命令 | 作用 |
|------|------|
| `/new` | 新建 DSH 会话（清空上下文；旧会话仍持久化，可 `/resume` 找回） |
| `/resume` | 列出/恢复历史会话（`/resume` 列表；`/resume 3` 按序号；`/resume <sessionId>` 匹配） |
| `/stop` | 中断当前处理，清空排队 |
| `/queue` | 查看队列状态 |
| `/model` | 查看/切换模型（`/model deepseek/deepseek-chat`） |
| `/status` | 查看 DSH 状态（会话/模型/token 统计） |
| `/feishu status` / `monitor [reset]` / `config [reload]` / `doctor` / `help` | 飞书连接管理 |
| `/help` | 显示帮助 |

## 本地开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run（复用 pi-feishu-bridge 的纯逻辑测试）
npm run build       # tsc
```

## 设计说明（与 pi-feishu-bridge 的差异）

| 层 | pi-feishu-bridge（Pi） | dsh-feishu-bridge（DSH） |
|---|---|---|
| 插件形态 | Pi extension（`pi.registerTool` 等） | Cordis 插件（`inject: ['agents']` + `Config` Schema） |
| 入站投递 | `pi.sendUserMessage()` | `createUserMessage()` + `agent.followup()` |
| 出站事件 | `message_update` / `tool_execution_*` / `agent_settled` | `session/event`（`assistant/chunk` / `tool/call` / `turn/end`） |
| 会话管理 | 单 Pi session 共享 | 单共享 dsh Agent（确定性 sessionId，重启可 resume） |
| 模型切换 | `pi.setModel()` | fork + `agents.create`（带 seed，模型路由持久化） |
| 工具注册 | `pi.registerTool` | `defineTool` 注册进 agent scoped `ctx.tools` |

## License

[MIT](./LICENSE)