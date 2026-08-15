/**
 * dsh-feishu-bridge — DeepSeek Harness (dsh) 的飞书 IM 渠道插件
 *
 * 将飞书/Lark 作为 dsh agent 的前端协议驱动：
 * - 入站：飞书 WebSocket → 访问控制/命令路由/消息队列 → createUserMessage → agent.followup
 * - 出站：监听 dsh `session/event` → CardKit 流式卡片（参考 dsh-qqbot 的 outbound 逻辑）
 * - 会话：一个插件实例 = 一个共享 dsh Agent（preset/cwd 可配置），
 *   多飞书 chat 经互斥队列共享（对齐 pi-feishu-bridge 的安全边界哲学）。
 *
 * 消息流程：用户消息 → 占位卡 → chunk/tool 事件原卡更新 → turn/end 封卡。
 */
import type { Context } from "@deepseek-ai/cordis";
import { FeishuClient } from "./feishu-client.js";
import { applyEnvOverrides, ConfigSchema, formatConfigProblems, validateConfig, type BridgeConfig } from "./config.js";
import type { InboundMessageContext, InboundResource, Logger } from "./types.js";
import { accessRiskWarning, evaluateAccess, formatAccessDeniedMessage } from "./access/policy.js";
import { StreamingCardManager } from "./streaming/card-manager.js";
import { MetricsCollector } from "./monitoring/metrics.js";
import { formatDoctor, runDoctor } from "./monitoring/doctor.js";
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from "./version.js";
import { ClarifyManager } from "./clarify/manager.js";
import { warn, error, describeError } from "./log.js";
import { MessageQueueManager, type QueuedMessage } from "./queue.js";
import { DshSessionManager } from "./dsh/session-manager.js";
import { DshEventAdapter, type SettleHooks } from "./dsh/event-adapter.js";
import { registerBridgeTools, type ToolDeps } from "./tools.js";
import { dispatchCommand } from "./commands/index.js";
import { buildWorkspaceCard, verifyWorkspaceCardPayload } from "./cardkit/workspace.js";

// ── Cordis 插件元数据 ──
export const name = "feishu-bridge";
// agentPresets 仅为可选增强（session-manager.composePreset 内部降级），
// 不声明为必选 inject：宿主未提供该服务时插件照常运行
export const inject = ["agents"];
export const Config = ConfigSchema;

export type { BridgeConfig } from "./config.js";

// ─── 常量 ─────────────────────────────────────────────

/** 工具名到友好名称的映射 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  bash: "Shell",
  pwsh: "PowerShell",
  read: "读取文件",
  edit: "编辑文件",
  write: "写入文件",
  grep: "搜索",
  glob: "匹配文件",
  ask_feishu: "向用户提问",
  send_to_feishu: "发送消息",
  send_image_to_feishu: "发送图片",
  send_file_to_feishu: "发送文件",
};

/** 友好化工具名 */
function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] ?? name;
}

/** 控制台 Logger（DSH 宿主无内置 logger 服务时兜底；debug 受 config.debug / FEISHU_DEBUG 控制） */
function createLogger(config: BridgeConfig): Logger {
  return {
    info: (msg: string, ...args: unknown[]) => console.log(`[feishu-bridge] ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) => warn(msg, ...args),
    error: (msg: string, ...args: unknown[]) => error(msg, ...args),
    debug: (msg: string, ...args: unknown[]) => {
      if (config.debug || process.env.FEISHU_DEBUG === "1") console.debug(`[feishu-bridge] ${msg}`, ...args);
    },
  };
}

// ── 插件主体 ──
export async function apply(ctx: Context, rawConfig: BridgeConfig): Promise<void> {
  const config = applyEnvOverrides(rawConfig);
  const logger = createLogger(config);
  const agents = ctx.agents;

  // 诊断：/preset 依赖的可选服务是否就绪（agent-presets 行由 profile bundle/patch 提供）
  try {
    const presets = (ctx as unknown as { get?: (k: string) => unknown }).get?.("agentPresets");
    logger.info(`agentPresets service: ${presets ? "available" : "unavailable"}`);
  } catch {
    logger.info("agentPresets service: unavailable");
  }

  // ── 飞书层状态 ──
  let client: FeishuClient | null = null;
  let streaming: StreamingCardManager | null = null;
  let clarify: ClarifyManager | null = null;
  const metrics = new MetricsCollector();
  const queues = new MessageQueueManager({
    // per-chat 并行：每个 chat 按自己的 agent 空闲状态独立放行
    isAgentIdle: (chatId: string) => manager.isIdleFor(chatId),
  });
  /** 各 chat 的任务硬超时定时器（turn/end 时清理） */
  const taskTimeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── DSH 会话层 ──
  const toolDeps = (chatId: string): ToolDeps => ({
    get client() { return client; },
    get config() { return config; },
    get streaming() { return streaming; },
    get clarify() { return clarify; },
    // per-chat：工具默认发送目标绑定其所属 chat，而非全局"最近活跃"
    get latestChatId() { return chatId; },
    downgradeHeadings,
  });
  const manager = new DshSessionManager(
    ctx,
    agents,
    config,
    logger,
    (agentCtx, chatId) => registerBridgeTools(agentCtx, toolDeps(chatId)),
  );
  const settleHooks: SettleHooks = {
    onSettled: async (chatId, phase) => {
      // 任务已终态：清除残留的任务超时定时器（P2-1：避免 900s 后误触发）
      clearTaskTimeout(chatId);
      queues.setProcessing(chatId, false);
      streaming?.release(chatId);
      // turn/end emit 时 agent 可能尚未收敛为 idle；等待收敛后再放行队列，
      // 否则 flushAllQueues 会因 isAgentIdle=false 跳过且无独立触发器（P1-3）
      await waitAgentIdle(chatId);
      flushAllQueues();
      flashStatus(phase === "completed" ? "飞书: ✅ 完成" : "飞书: ⏹ 结束");
    },
  };
  const adapter = new DshEventAdapter(manager, () => streaming, () => client, queues, config, logger, settleHooks);

  // ── 任务超时 ──

  function clearTaskTimeout(chatId: string): void {
    const timer = taskTimeoutTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      taskTimeoutTimers.delete(chatId);
    }
  }

  function armTaskTimeout(chatId: string): void {
    clearTaskTimeout(chatId);
    const sec = config.taskTimeoutSec ?? 900;
    taskTimeoutTimers.set(chatId, setTimeout(() => {
      void (async () => {
        try {
          warn(`task timeout after ${sec}s chatId=${chatId}`);
          flashStatus("飞书: ⏰ 任务超时");
          if (streaming?.sessionFor(chatId)) {
            await streaming.abort(chatId, `任务超时（${sec}s）`, "timeout");
          }
          manager.cancel(chatId);
          await client?.stopTyping(chatId, false).catch(() => {});
          // 取消后 agent 会走 turn/end → settle 释放；兜底放开本 chat 队列
          queues.setProcessing(chatId, false);
          flushAllQueues();
        } catch (err) {
          warn(`task timeout handler failed: ${describeError(err)}`);
        }
      })();
    }, sec * 1000));
    const timer = taskTimeoutTimers.get(chatId);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as NodeJS.Timeout).unref?.();
    }
  }

  // ── 工具函数 ──

  /** 入站媒体统一本地路径标签（便于模型/tool 直接读盘） */
  function formatInboundResourceLabel(type: InboundResource["type"], localPath: string, fileName?: string): string {
    const name = fileName || localPath.split(/[\\/]/).pop() || localPath;
    switch (type) {
      case "image":
        return `[image: ${name}]\n[Image: source: ${localPath}]`;
      case "audio":
        return `[audio: ${name}]\n[File: source: ${localPath}]`;
      case "video":
        return `[video: ${name}]\n[File: source: ${localPath}]`;
      default:
        return `[file: ${name}]\n[File: source: ${localPath}]`;
    }
  }

  /**
   * Markdown 标题降级：所有出站文本的标题层级 +2，最小 H6。
   * 规则：只处理行首 # 开头、不在代码块内的标题行。
   */
  function downgradeHeadings(text: string): string {
    const lines = text.split("\n");
    const result: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
      if (line.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        result.push(line);
        continue;
      }

      if (inCodeBlock) {
        result.push(line);
        continue;
      }

      const match = line.match(/^(#{1,6})\s/);
      if (match) {
        const level = match[1].length;
        const newLevel = Math.min(level + 2, 6);
        result.push("#".repeat(newLevel) + line.slice(level));
      } else {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  /** 状态栏瞬态消息：DSH 无 UI 状态栏，改走日志 */
  function flashStatus(message: string): void {
    logger.debug(message);
  }

  async function dismissWorkspaceCard(messageId: string, chatId: string, text: string): Promise<void> {
    const activeClient = client;
    if (!activeClient || !messageId) {
      await activeClient?.sendMessage(chatId, text);
      return;
    }
    try {
      await activeClient.updateTextCard(messageId, "✅ " + text);
      return;
    } catch (error) {
      logger.warn("workspace card replacement failed: " + describeError(error));
    }
    // PATCH 失败时保留原卡片，不撤回消息；额外发送结果避免用户无反馈。
    await activeClient.sendMessage(chatId, text);
  }

  async function handleWorkspaceCardAction(action: { value: Record<string, unknown>; senderOpenId: string; chatId: string; messageId: string }): Promise<void> {
    try {
      if (!action.chatId) throw new Error("无法确认卡片所属 chat，请重新发送 /workspace");
      const payload = verifyWorkspaceCardPayload(config.appSecret, action.value, action.chatId);
      if (!manager.isWorkspaceCardAdmin(action.senderOpenId)) throw new Error("无权操作工作区卡片");
      if (payload.action === "list") {
        await client?.sendCard(action.chatId, buildWorkspaceCard(config.appSecret, action.chatId, manager.getEffectiveWorkspace(action.chatId), manager.listWorkspaces()));
        return;
      }
      if (payload.action === "use") {
        if (!payload.workspaceId) throw new Error("卡片缺少工作区 ID");
        if (!manager.isIdleFor(action.chatId)) throw new Error("当前 chat 正在处理中，请等待完成或先执行 /stop");
        await prepareSessionControl(action.chatId);
        const result = await manager.switchWorkspace(action.chatId, payload.workspaceId, payload.mode ?? "reset");
        const context = result.preservedContext ? "旧上下文已复制。" : "已创建新的会话，未复制旧上下文。";
        await dismissWorkspaceCard(action.messageId, action.chatId, result.changed ? "已切换工作区：" + result.workspace.title + "\n路径：" + result.workspace.path + "\n" + context : "当前已经是工作区：" + result.workspace.title);
        return;
      }
      if (!manager.isIdleFor(action.chatId)) throw new Error("当前 chat 正在处理中，请等待完成或先执行 /stop");
      await prepareSessionControl(action.chatId);
      const result = await manager.resetWorkspace(action.chatId);
      await dismissWorkspaceCard(action.messageId, action.chatId, result.changed ? "已恢复默认工作区：" + result.workspace.title + "\n路径：" + result.workspace.path : "当前 chat 没有单独的工作区选择，仍使用：" + result.workspace.title);
    } catch (error) {
      logger.warn("workspace card action failed: " + describeError(error));
      if (action.chatId) await client?.sendMessage(action.chatId, "工作区卡片操作失败：" + describeError(error));
    }
  }

  // ── 飞书客户端 ──

  function startFeishuClient(): void {
    try {
      if (client) {
        client.disconnect();
        client = null;
      }

      if (!config.appId || !config.appSecret) {
        logger.error("缺少 appId/appSecret，飞书客户端未启动。");
        const problems = validateConfig(config);
        if (problems.length > 0) logger.error(`配置问题:\n${formatConfigProblems(problems)}`);
        return;
      }

      client = new FeishuClient(config);
      streaming = new StreamingCardManager(client.createCardKitClient(metrics), client, {
        flushIntervalMs: Math.max(80, config.flushIntervalMs ?? 200),
        showThinking: config.showThinking ?? false,
        printStrategy: config.printStrategy ?? "delay",
        printStep: config.printStep ?? 4,
        panelExpanded: config.panelExpanded ?? false,
        maxToolSteps: config.maxToolSteps ?? 20,
        maxThinkingRounds: config.maxThinkingRounds ?? 20,
        streamingPanelExpanded: config.streamingPanelExpanded ?? false,
        maxAnswerElementChars: Math.max(1000, config.maxAnswerElementChars ?? 30000),
        maxReasoningChars: Math.max(200, config.maxReasoningChars ?? 3500),
        maxToolDetailChars: Math.max(50, config.maxToolDetailChars ?? 500),
        maxToolOutputChars: Math.max(50, config.maxToolOutputChars ?? 800),
        printFrequencyMs: Math.max(20, Math.min(1000, config.printFrequencyMs ?? 70)),
        footer: config.footer,
      }, metrics);
      clarify = new ClarifyManager(client.createCardKitClient(metrics));

      client.setOnMessage((context) => {
        void handleFeishuMessage(context);
      });
      client.setOnStatusChange((status) => {
        logger.info(`feishu status: ${status}`);
      });
      client.setOnCardAction((action) => { void clarify?.handleAction(action); });
      client.setOnWorkspaceAction((action) => { void handleWorkspaceCardAction(action); });

      void client.connect().then(() => {
        const warning = accessRiskWarning(config);
        if (warning) logger.warn(warning);
      }).catch((err) => {
        logger.error(`飞书连接错误: ${describeError(err)}`);
      });
      logger.info(`${PRODUCT_NAME} ${PRODUCT_VERSION} 启动 (appId=****${config.appId.slice(-4)} domain=${config.domain})`);
    } catch (err) {
      logger.error(`startFeishuClient failed: ${describeError(err)}`);
    }
  }

  // ── 处理飞书入站消息 → 排队或直接处理 ────────

  async function handleFeishuMessage(context: InboundMessageContext): Promise<void> {
    const decision = evaluateAccess(context, config);
    if (!decision.allowed) {
      logger.warn(`access denied reason=${decision.reason ?? "unknown"} chatId=${context.chatId} openId=${context.senderOpenId}`);
      await client?.sendMessage(context.chatId, formatAccessDeniedMessage(context, decision.reason), context.messageId);
      return;
    }

    const { chatId, messageId: msgId, text, chatType, resources } = context;
    const content = text.trim();
    if (!content && resources.length === 0) return;

    // ── 拦截斜杠命令 ──
    if (content.startsWith("/")) {
      await handleSlashCommand(chatId, msgId, content, context.senderOpenId, chatType);
      return;
    }

    // ── 入队 / 同 chat 打断 ──
    const incoming: QueuedMessage = { msgId, text: content, resources, chatType };
    const outcome = queues.enqueue(
      chatId,
      incoming,
      config.sameChatBusyPolicy ?? "queue",
      streaming?.sessionFor(chatId) !== null,
    );

    if (outcome.action === "interrupted") {
      clearTaskTimeout(chatId);
      await clarify?.abort();
      if (streaming?.sessionFor(chatId)) {
        await streaming.abort(chatId, "被同会话新消息打断", "user_abort");
      }
      manager.cancel(chatId);
      client?.stopTyping(chatId, false).catch(() => {});
      await client?.sendMessage(
        chatId,
        outcome.dropped > 0
          ? `已打断上一条任务，并丢弃 ${outcome.dropped} 条排队，开始处理最新消息。`
          : "已打断上一条任务，开始处理最新消息。",
        msgId,
      );
      flashStatus("飞书: ⚡ 打断并切换到新消息");
      if (!outcome.agentBusy) await dequeueAndProcess(chatId);
      return;
    }

    if (outcome.action === "queued") {
      await client?.sendMessage(chatId, `已排队 (前面还有 ${outcome.pending - 1} 条)`, msgId);
      flashStatus(`飞书: 📥 排队中 (${outcome.pending})`);
      return;
    }

    await dequeueAndProcess(chatId);
  }

  /** 从队列取出下一条消息并开始处理 */
  async function dequeueAndProcess(chatId: string): Promise<void> {
    const item = queues.dequeue(chatId);
    if (!item) return;

    flashStatus(`飞书: 📩 ${item.text.substring(0, 20)}${item.text.length > 20 ? "..." : ""}`);

    try {
      // 下载入站媒体，并统一为本地路径标签
      const resourceParts: string[] = [];
      for (const res of item.resources) {
        const localPath = await client!.downloadResource(item.msgId, res.fileKey, res.type, res.fileName);
        if (localPath) {
          resourceParts.push(formatInboundResourceLabel(res.type, localPath, res.fileName));
        }
      }

      // 添加 Typing Reaction 并创建本 chat 的流式卡片
      await client!.startTyping(chatId, item.msgId);
      await streaming?.start(chatId, item.msgId);
      armTaskTimeout(chatId);

      // 发送给 dsh Agent（per-chat：每个 chat 独立 agent 与上下文）
      const fullContent = [item.text, ...resourceParts].filter(Boolean).join("\n");
      await manager.sendMessage(chatId, fullContent);
    } catch (err) {
      // 媒体下载或投递失败：告知用户而非静默丢弃，并释放队列
      clearTaskTimeout(chatId);
      queues.setProcessing(chatId, false);
      warn(`failed to dispatch message chatId=${chatId}: ${describeError(err)}`);
      client?.stopTyping(chatId, false).catch(() => {});
      await client?.sendMessage(chatId, `消息处理失败：${describeError(err)}`, item.msgId).catch(() => {});
      flushAllQueues();
    }
  }

  // ── 斜杠命令处理 ──────────────────────────────────────

  /** 为 /new /resume 做前置清理：中断流式、清空本聊天队列、取消 Agent */
  async function prepareSessionControl(chatId: string): Promise<void> {
    clearTaskTimeout(chatId);
    await clarify?.abort();
    if (streaming?.sessionFor(chatId)) await streaming.abort(chatId, "会话控制命令中断当前任务");
    client?.stopTyping(chatId, false).catch(() => {});
    queues.reset(chatId);
    manager.cancel(chatId);
  }

  /** 处理从飞书发来的斜杠命令（不会发给 LLM，直接扩展层执行） */
  async function handleSlashCommand(
    chatId: string,
    msgId: string,
    text: string,
    senderOpenId: string,
    chatType: "p2p" | "group",
  ): Promise<void> {
    await dispatchCommand(
      {
        manager,
        senderOpenId,
        chatType,
        get client() { return client; },
        get config() { return config; },
        get streaming() { return streaming; },
        get clarify() { return clarify; },
        metrics,
        queues,
        prepareSessionControl: () => prepareSessionControl(chatId),
        flashStatus,
        clearTaskTimeout,
      },
      chatId,
      msgId,
      text,
    );
  }

  function flushAllQueues(): void {
    if (!client || client.getStatus() !== "connected") return;
    // per-chat 并行：放行所有可处理的 chat（各 agent 独立判断空闲）
    for (const chatId of queues.chatsAwaitingFlush()) {
      void dequeueAndProcess(chatId).catch((err) => {
        queues.setProcessing(chatId, false);
        warn(`flush failed chatId=${chatId}: ${describeError(err)}`);
      });
    }
  }

  /** 等待指定 chat 的 agent 收敛到 idle；带超时防挂起 */
  async function waitAgentIdle(chatId: string, timeoutMs = 5000): Promise<void> {
    const agent = manager.recordFor(chatId)?.agent;
    if (!agent || agent.status === "idle") return;
    await Promise.race([
      agent.whenIdle(),
      new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs); }),
    ]);
  }

  // ── 出站：dsh session/event → 飞书卡片 ──
  adapter.attach(ctx);

  // ── 会话闲置回收（对齐 dsh-qqbot IdleEvictor） ──
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  // ── 生命周期 ──
  ctx.effect(() => {
    const problems = validateConfig(config);
    if (problems.length > 0) {
      logger.warn(`启动检查:\n${formatConfigProblems(problems)}`);
    }

    startFeishuClient();

    // 闲置回收：超过 sessionIdleTimeout 且 agent 空闲的 chat 会话 dispose，
    // 下次消息自动 resume（per-chat：逐个 chat 独立回收）
    const idleTimeout = config.sessionIdleTimeout ?? 30 * 60 * 1000;
    idleTimer = setInterval(() => {
      void manager.evictIdle(idleTimeout).then((evicted) => {
        if (evicted.length > 0) {
          logger.info(`evicted idle sessions: ${evicted.join(", ")}`);
        }
      }).catch((err) => {
        warn(`idle eviction failed: ${describeError(err)}`);
      });
    }, Math.min(idleTimeout, 60_000));
    if (typeof idleTimer === "object" && idleTimer && "unref" in idleTimer) {
      (idleTimer as NodeJS.Timeout).unref?.();
    }

    return async () => {
      for (const chatId of [...taskTimeoutTimers.keys()]) clearTaskTimeout(chatId);
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      await clarify?.abort();
      await streaming?.terminateAll("dsh-feishu-bridge 已卸载");
      if (client) {
        client.disconnect();
        client = null;
      }
      streaming = null;
      clarify = null;
      await manager.disposeAll();
      logger.info("dsh-feishu-bridge 已停止");
    };
  }, "feishu-bridge.lifecycle");
}