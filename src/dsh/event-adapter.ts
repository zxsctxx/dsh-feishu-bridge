/**
 * DshEventAdapter — dsh `session/event` → 飞书流式卡片事件适配
 *
 * 事件流（参考 dsh-qqbot outbound 与 pi-feishu-bridge 的 Pi 事件映射）：
 *
 *   assistant/chunk (text-delta)    → StreamingCardManager.onTextDelta
 *   assistant/chunk (reasoning-delta)→ onThinkingDelta（受 showThinking 控制）
 *   assistant/chunk (finish)        → footer.stopReason
 *   tool/call                       → onToolStart
 *   tool/result                     → onToolEnd
 *   assistant/message               → footer.model（usage 在 settle 时全量累计）
 *   turn/end                        → 封卡 settle + 释放队列
 *
 * 只处理本插件共享 agent 的 session（按 session.header.id 过滤），
 * 不影响宿主 Web GUI 等其他会话。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { FeishuClient } from "../feishu-client.js";
import type { StreamingCardManager } from "../streaming/card-manager.js";
import type { MessageQueueManager } from "../queue.js";
import type { Logger } from "../types.js";
import type { DshSessionManager } from "./session-manager.js";
import { warn } from "../log.js";

/** settle 后的回调（释放队列、停止 Typing、刷新状态栏） */
export interface SettleHooks {
  onSettled(chatId: string, phase: string): Promise<void>;
}

/** 安全解析模型返回的 JSON 参数串 */
function safeParseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/** 从 ContentBlock[] 提取纯文本 */
function extractBlocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    const b = block as { type?: string; text?: string; content?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool-result" && Array.isArray(b.content)) {
      const inner = extractBlocksText(b.content);
      if (inner) parts.push(inner);
    }
  }
  return parts.join("\n").trim();
}

export class DshEventAdapter {
  constructor(
    private readonly manager: DshSessionManager,
    private readonly streaming: () => StreamingCardManager | null,
    private readonly client: () => FeishuClient | null,
    private readonly queues: MessageQueueManager,
    private readonly config: { showThinking?: boolean; debug?: boolean },
    private readonly logger: Logger,
    private readonly hooks: SettleHooks,
  ) {}

  /** 注册到 ctx.on('session/event') 的处理器 */
  attach(ctx: Context): void {
    ctx.on("session/event", (session: { header: { id: SessionId } }, event: SessionEvent) => {
      try {
        this.handle(session.header.id, event);
      } catch (err) {
        this.logger.error(`dsh-feishu-bridge: event handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private handle(sessionId: SessionId, event: SessionEvent): void {
    // 只处理本插件管理过的 agent 会话（含 /new、/model fork 后仍可能到达
    // 的旧会话 turn/end 封口事件）；宿主 Web GUI 等其他会话不受影响
    if (!this.manager.isOwnedSession(sessionId)) return;
    // 事件定位所属 chat（per-chat 并行：卡片按 chat 更新）
    const chatId = this.manager.chatIdForSession(sessionId);
    if (!chatId) return;
    this.logger.debug(`session/event ${event.type} seq=${event.seq} chat=${chatId}`);

    switch (event.type) {
      case "assistant/chunk": {
        this.handleChunk(chatId, event);
        break;
      }
      case "tool/call": {
        this.handleToolCall(chatId, event);
        break;
      }
      case "tool/result": {
        this.handleToolResult(chatId, event);
        break;
      }
      case "assistant/message": {
        this.handleAssistantMessage(chatId, event);
        break;
      }
      case "request/header": {
        this.handleRequestHeader(chatId, event);
        break;
      }
      case "turn/end": {
        void this.handleTurnEnd(chatId, event);
        break;
      }
      default:
        break;
    }
  }

  private handleChunk(chatId: string, event: SessionEvent): void {
    if (event.type !== "assistant/chunk") return;
    const chunk = event.data.chunk;
    const streaming = this.streaming();
    if (!streaming || !streaming.sessionFor(chatId)) return;

    switch (chunk.type) {
      case "text-delta":
        streaming.onTextDelta(chatId, chunk.text);
        break;
      case "reasoning-delta":
        // 总是转发：轮次计数/面板标题与 showThinking 无关；正文显隐由渲染层控制
        streaming.onThinkingDelta(chatId, chunk.text);
        break;
      case "finish": {
        const reason = chunk.reason;
        if (reason && typeof reason === "object" && "kind" in reason) {
          const session = streaming.sessionFor(chatId);
          if (session) session.footer.stopReason = String((reason as { kind: unknown }).kind);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleToolCall(chatId: string, event: SessionEvent): void {
    if (event.type !== "tool/call") return;
    const streaming = this.streaming();
    if (!streaming) return;
    const { callId, name, arguments: rawArgs } = event.data;
    streaming.onToolStart(chatId, callId, name, safeParseArguments(rawArgs));
  }

  private handleToolResult(chatId: string, event: SessionEvent): void {
    if (event.type !== "tool/result") return;
    const streaming = this.streaming();
    if (!streaming) return;
    const { message, error } = event.data;
    const text = extractBlocksText(message?.content);
    streaming.onToolEnd(chatId, message.source.callId, text || (error ? "工具执行失败" : "(空结果)"), !!error);
  }

  private handleAssistantMessage(chatId: string, event: SessionEvent): void {
    if (event.type !== "assistant/message") return;
    const streaming = this.streaming();
    const session = streaming?.sessionFor(chatId);
    if (!session) return;
    const message = event.data.message;
    const source = message?.source as { provider?: string; model?: string } | undefined;
    if (source?.model) {
      // 显示名优先（settings.yaml name），缺省回退 model id
      session.footer.model = this.manager.resolveModelLabel(source.provider ?? "", source.model);
    }
    if (session.footer.apiCalls !== undefined) {
      session.footer.apiCalls += 1;
    }
  }

  /** request/header：记录实际请求的模型与思考强度（footer「模型 + effort」） */
  private handleRequestHeader(chatId: string, event: SessionEvent): void {
    if (event.type !== "request/header") return;
    const streaming = this.streaming();
    const session = streaming?.sessionFor(chatId);
    if (!session) return;
    const config = (event.data as { header?: { config?: unknown } }).header?.config as
      | { provider?: string; model?: string; reasoningEffort?: string }
      | undefined;
    if (!config?.model) return;
    session.footer.model = this.manager.resolveModelLabel(config.provider ?? "", config.model);
    if (config.reasoningEffort) {
      session.footer.reasoningEffort = config.reasoningEffort;
    }
  }

  private async handleTurnEnd(chatId: string, event: SessionEvent): Promise<void> {
    if (event.type !== "turn/end") return;
    const reason = event.data.reason;
    const streaming = this.streaming();

    if (reason.kind === "error") {
      // 打印完整错误对象：reason.error 常为 LlmError.failure，可能无 message 字段
      this.logger.error(`turn/end error: ${JSON.stringify(reason.error)}`);
      streaming?.recordError(chatId, reason.error.message ?? "LLM 调用失败");
      await this.settle(chatId, "llm_error");
      return;
    }

    if (reason.kind === "aborted") {
      // 无论卡片是否已被命令层先行封卡，统一走 settle()：
      // terminal 卡片 finalize 幂等，非 terminal 卡片先封卡再 settle，
      // 保证 onSettled 一定执行（否则处理中 chat 的队列会悬挂）
      const active = streaming?.sessionFor(chatId);
      if (active && !active.terminal) {
        await streaming?.abort(chatId, "任务已中断", "user_abort");
      }
      await this.settle(chatId);
      return;
    }

    await this.settle(chatId);
  }

  /** 封卡：footer 全量累计 → settle → 释放队列 */
  private async settle(chatId: string, errorKind?: "llm_error"): Promise<void> {
    const streaming = this.streaming();
    const session = streaming?.sessionFor(chatId);
    if (!session || !streaming) return;

    // events 已随 session/event 提交落盘，settle 时全量累计即可（无需 pending）
    const usage = this.manager.getTokenUsage(session.chatId);
    session.footer.inputTokens = usage.input;
    session.footer.outputTokens = usage.output;
    session.footer.cacheRead = usage.cacheRead;
    session.footer.cacheWrite = usage.cacheWrite;
    // 上下文 = 最近一次请求 inputTokens / 模型广告窗口（request/context 路由元数据）
    const latest = this.manager.getLatestRequestStats(session.chatId);
    session.footer.contextTokens = latest.inputTokens || null;
    session.footer.contextWindow = latest.contextWindow;
    session.footer.contextPercent = latest.contextWindow
      ? (latest.inputTokens / latest.contextWindow) * 100
      : null;
    // 流式质量指标（首 token 平均延迟 / 输出速率）
    const metrics = this.manager.getStreamMetrics(session.chatId);
    session.footer.ttftAvgMs = metrics.ttftAvgMs;
    session.footer.outputSpeedTps = metrics.outputSpeedTps;

    try {
      const settled = errorKind === "llm_error"
        ? await streaming.abort(chatId, "LLM 调用失败", "llm_error")
        : await streaming.settle(chatId);
      if (!settled) return;
      await this.client()?.stopTyping(settled.chatId, settled.phase === "completed");
      // release 由 onSettled 负责：settle() 的 await 让出事件循环后
      // 队列可能已放行新的 chat 卡片（active 已被替换），无条件 release
      // 会把新卡片清空导致全局冻结（P0-2）
      await this.hooks.onSettled(settled.chatId, settled.phase);
    } catch (err) {
      warn(`settle failed: ${err instanceof Error ? err.message : String(err)}`);
      this.queues.setProcessing(chatId, false);
      // 仅当卡片仍是本会话的才释放，避免误清新卡片
      const current = this.streaming();
      if (current?.sessionFor(chatId) === session) {
        current.release(chatId);
      }
    }
  }
}