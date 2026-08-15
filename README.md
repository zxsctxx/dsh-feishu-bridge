# DSH-Feishu Bridge

通过飞书/Lark 官方 Bot API WebSocket 长连接，将飞书作为 **DeepSeek Harness（DSH）** 的受控聊天入口。使用 CardKit v2 原生元素流式 API 输出。

## 架构

```
飞书用户 → 飞书 WebSocket → dsh-feishu-bridge → ctx.agents → dsh agent loop → LLM
                                 ↑                                  │
                                 └──── session/event ───────────────┘
                                      (assistant/chunk → CardKit 流式卡片)
```

- **入站**：飞书消息 → 访问控制 → 斜杠命令/消息队列 → `createUserMessage` → `agent.followup()`
- **出站**：监听 `session/event`：`assistant/chunk`（text/reasoning delta）、`tool/call`、`tool/result`、`assistant/message`、`turn/end` → 单卡流式刷新，`turn/end` 封卡
- **会话**：**每个飞书 chat 一个独立的 dsh Agent**（含独立上下文、模型路由与工具状态；sessionId 由 chatId 确定性派生，重启后自动恢复各自会话）。处理调度全局串行：同一时刻只处理一个 chat 的消息，其余进入互斥队列等待，保证单活动会话的卡片状态一致

## 主要能力

- **流式卡片输出** — CardKit 原生流式刷新，thinking 与工具步骤面板实时展示（推理正文默认折叠，设 `showThinking: true` 显示）
- **自动降级保障** — CardKit 不可用时自动降级为静态卡片，再降为纯文本，尽可能送达；用户原消息已撤回时不再打扰
- **信息页脚** — 终态卡片默认展示状态、用时、首 token 平均延迟、输出速率与缓存命中/输入/输出/上下文占用（`footer.lines` 可自定义布局，可选 model、token、stop_reason、cost 等字段）
- **访问控制** — allowlist 白名单 + 群聊 @ 校验，未授权请求无法进入 Agent
- **弹性容错** — 飞书 API 限频（429）与瞬时错误自动退避重试，WebSocket 断线自动重连，回复目标被撤回时回退为新建消息或优雅终止
- **媒体收发** — 文本/富文本/图片/文件的收发；音频/视频消息识别为占位文本并尝试下载；支持 Reaction 输入指示（处理中 Typing、失败 CrossMark）
- **实用工具** — `send_to_feishu` / `send_image_to_feishu` / `send_file_to_feishu` / `ask_feishu`（注册进各 chat agent 的 scoped 工具集）
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

# 启动（环境变量提供飞书凭据；bash / PowerShell 语法）
export FEISHU_APP_ID="你的AppID" FEISHU_APP_SECRET="你的AppSecret"
# Windows PowerShell 等价写法：
#   $env:FEISHU_APP_ID="你的AppID"; $env:FEISHU_APP_SECRET="你的AppSecret"
dsh --profile feishu
```

> 注：`dsh plugin --profile feishu add` 首次运行会初始化该 profile（bundle 为 `@deepseek-ai/dsh-base`），它是 **headless 运行、无 Web GUI**；如希望保留 Web GUI，可改用 `web` profile 并编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`。

### 方式二：--patch 开发模式

`dsh` 的 `--patch` 接受的是 **patch 列表**（与 `cordis.patch.yml` 同格式），不是完整条目列表——不能直接传本仓库根目录的 `cordis.yml`。仓库提供了现成的 [feishu.patch.yml](feishu.patch.yml)：

```bash
# 构建
cd /path/to/dsh-feishu-bridge
npm install && npm run build

# 安装依赖到目标 profile（以 web profile 为例）
dsh plugin --profile web add /path/to/dsh-feishu-bridge

# 启动（--patch 叠加插件，不改动 profile 文件）
dsh --profile web --patch /path/to/dsh-feishu-bridge/feishu.patch.yml
```

## 飞书侧准备

1. 在飞书开放平台创建**企业自建应用**，开启「机器人」能力并发布版本。
2. 开通 **WebSocket 长连接**（无需公网回调地址），订阅事件 `im.message.receive_v1`（私聊/群聊消息）。
3. 按需为应用开通权限并授予数据权限：读取/发送消息、上传/下载媒体、Reaction（表情回应）、创建卡片等。

## 配置

配置来源优先级：**cordis.yml config 字段 → `FEISHU_*` 环境变量**（覆盖同名项）。

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `appId` / `appSecret` | 必填 | 飞书应用凭据（或 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`） |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `provider` / `model` | 宿主默认 | LLM 路由；缺省沿用宿主默认模型 |
| `preset` | 宿主默认 | Agent preset id（工具集/prompt 等） |
| `cwd` | `process.cwd()` | Agent 工作目录 |
| `registerBridgeTools` | `true` | 是否把飞书工具注册进每个 chat 的 agent |
| `flushIntervalMs` | 200 | 流式刷新节流间隔(ms) |
| `showThinking` | `false` | 默认不展示推理正文 |
| `accessPolicy` | `allowlist` | 默认白名单；开发可显式设 `open` |
| `allowedChatIds` / `allowedOpenIds` | `[]` | 见下方匹配规则 |
| `requireMentionInGroup` | `false` | 生产群聊建议 `true` |
| `clarifyTimeoutSec` | 300 | `ask_feishu` 默认等待时间 |
| `taskTimeoutSec` | 900 | 单轮 Agent 硬超时（秒），超时 abort 并终态封卡 |
| `sameChatBusyPolicy` | `queue` | 同 chat 忙时：`queue` 排队；`interrupt` 打断当前并只跑最新消息 |
| `sessionIdleTimeout` | 1800000 | Agent 闲置超时(ms)，超时 dispose，下条消息自动恢复 |
| `footer` | 两行默认 | 终态卡片页脚布局（`lines` 二维数组）；默认 `status/elapsed/ttft/speed` + `cache_hit/input/output/context`，可选 `model`/`stop_reason`/`cost` 等字段 |
| `debug` | `false` | 调试日志（也可 `FEISHU_DEBUG=1`） |
| `encryptKey` / `verificationToken` | `""` | 飞书事件加密密钥 / 校验令牌（可选） |
| `printStrategy` / `printStep` / `printFrequencyMs` | `delay` / `4` / `70` | CardKit 流式打印频率控制 |
| `panelExpanded` / `streamingPanelExpanded` | `false` | 过程面板默认展开 |
| `maxToolSteps` / `maxThinkingRounds` | `20` / `20` | 过程面板展示上限 |
| `maxReasoningChars` / `maxToolDetailChars` / `maxToolOutputChars` / `maxAnswerElementChars` | `3500` / `500` / `800` / `30000` | 推理/工具详情展示上限与单卡续卡上限 |

> 说明：`maxQueue` / `processingTimeoutMs` 在当前版本存在但**未启用**（保留兼容）。

全部字段与默认值见 `src/config.ts` 的 Schema 注释。

### 如何配置 allowlist 才能对话

1. 先启动 Bot，用你的账号给 Bot 发任意消息。
2. 若未授权，Bot 会回复你的 **open_id**（`ou_…`）和当前 **chat_id**（`oc_…`）。
3. 把 `allowedOpenIds` / `allowedChatIds` 写入组合配置（如 `$DSH_HOME/profiles/feishu/cordis.patch.yml` 的 `feishu-bridge.config`）。**DSH 会在配置保存后自动热重载插件，无需额外操作**；`/feishu config reload` 仅用于手动触发。**环境变量必须在进程启动前设置**，运行中修改不会生效。

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
| `/resume` | 列出/恢复历史会话（`/resume` 列表；`/resume 3` 按序号；`/resume <id 前缀>` 前缀匹配；需宿主启用会话持久化） |
| `/stop` | 中断当前处理，清空排队 |
| `/queue` | 查看队列状态 |
| `/model` | 查看/切换模型（`/model deepseek/deepseek-chat`） |
| `/status` | 查看 DSH 状态（会话/模型/token 统计） |
| `/feishu status` / `monitor [reset]` / `config [reload]` / `doctor` / `help` | 飞书连接管理（配置改动会自动热重载，`config reload` 仅手动触发） |
| `/help` | 显示帮助 |

## 本地开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run（纯逻辑与 DSH 对接层测试）
npm run build       # tsc
```

## License

[MIT](./LICENSE)