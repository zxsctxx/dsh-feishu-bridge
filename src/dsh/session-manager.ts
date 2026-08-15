/**
 * DshSessionManager — 飞书 → dsh Agent 的会话生命周期管理
 *
 * 会话模型（对齐 pi-feishu-bridge 的安全边界哲学）：
 *   一个插件实例 = 一个共享的 dsh Agent 上下文（由 preset/cwd 决定），
 *   多个飞书 chat 通过互斥队列共享该 Agent（见 MessageQueueManager）。
 *   真正多租户请分别启动 DSH profile。
 *
 * sessionKey 格式: `feishu:${appId}:shared`（单一共享 agent）
 * SessionId 由 sessionKey 确定性派生（SHA-256），/new 或切换模型后
 * 记录最新 sessionId 到 PrefsStore，重启后按记录恢复。
 *
 * 创建/恢复/模型切换完全走 dsh agents 服务（对齐 dsh-qqbot）：
 *   agents.get → agents.resume → agents.create，并支持 agent-presets 挂载。
 */
import { createHash, randomUUID } from "node:crypto";
import { SessionId, type SessionEvent, type UserMessage } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Agent, AgentHandle, AgentSetup } from "@deepseek-ai/dsh-agent";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../types.js";
import { ModelResolver, type ModelRoute } from "./model-resolver.js";
import { streamMetricsFromEvents } from "../session/usage.js";
import type {
  AgentPresetsLike,
  PresetComposition,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
} from "./types.js";

/** 会话持久化服务（/resume 列表用） */
interface SessionPersistenceLike {
  list(signal?: AbortSignal): Promise<Array<{ id: string; meta?: Record<string, unknown> }>>;
}

/** 会话 fork 能力（切换模型用，可选） */
interface SessionsService {
  fork(source: unknown, boundary?: number): { events: readonly SessionEvent[] };
}

export class DshSessionManager {
  private record: SessionRecord | null = null;
  private readonly modelResolver: ModelResolver;
  /** 本插件管理过的 sessionId 集合：/new、/model fork 后旧会话的
   *  turn/end（封口事件）仍会到达，adapter 据此决定是否处理 */
  private readonly ownedSessionIds = new Set<string>();

  constructor(
    private readonly ctx: Context,
    private readonly agents: {
      get(id: SessionId): Agent | undefined;
      resume(options: {
        resumeSessionId: SessionId;
        agentOptions?: { provider?: string; model?: string };
        setup?: AgentSetup;
      }): Promise<AgentHandle>;
      create(options: {
        sessionId: SessionId;
        meta?: { cwd?: string; parentSession?: string; seedLength?: number; agentPreset?: string };
        seed?: readonly SessionEvent[];
        agentOptions?: { provider?: string; model?: string };
        setup?: AgentSetup;
      }): Promise<AgentHandle>;
    },
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    /** 创建/恢复 agent 时的额外 scoped setup（注册飞书工具等） */
    private readonly setupExtra: (agentCtx: Context) => void = () => {},
  ) {
    this.modelResolver = new ModelResolver(ctx, config, logger);
  }

  /** 共享会话 key（单一 agent 模型） */
  get sessionKey(): string {
    return `feishu:${this.config.appId}:shared`;
  }

  /** 当前（或应恢复的）sessionId */
  get sessionId(): SessionId {
    return SessionId(this.modelResolver.getSessionId(this.sessionKey) ?? this.deriveSessionId(this.sessionKey));
  }

  /** 该 sessionId 是否属于本插件管理过的会话（adapter 过滤用） */
  isOwnedSession(sessionId: SessionId): boolean {
    return this.ownedSessionIds.has(sessionId);
  }

  /** 记录一个本插件管理的 sessionId */
  private registerSession(sessionId: SessionId): void {
    this.ownedSessionIds.add(sessionId);
  }

  /** 当前活跃 agent 记录（可能为 null） */
  get current(): SessionRecord | null {
    return this.record;
  }

  /** Agent 是否空闲（队列 flush 依据） */
  get isIdle(): boolean {
    return !this.record || this.record.agent.status === "idle";
  }

  /** 派生确定性 sessionId：同一个 key 重启后可恢复同一会话 */
  private deriveSessionId(sessionKey: string): string {
    const hash = createHash("sha256").update(sessionKey).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  // ── 模型相关（委托 ModelResolver） ──

  getEffectiveModel(): ModelRoute | undefined {
    return this.modelResolver.getEffectiveRoute(this.sessionKey);
  }

  getStatus(): SessionStatus {
    const record = this.record;
    const route = this.getEffectiveModel();
    return {
      active: !!record,
      sessionId: record?.sessionId,
      provider: route?.provider,
      model: route?.model,
      preset: record?.agentPreset,
      messageCount: this.countMessages(record),
    };
  }

  getTokenUsage(): TokenUsageStats {
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const events = this.record?.agent.session.events;
    if (!events) return stats;

    for (const event of events) {
      if (event.type !== "assistant/message" || !event.data.usage) continue;
      stats.input += event.data.usage.inputTokens ?? 0;
      stats.output += event.data.usage.outputTokens ?? 0;
      stats.cacheRead += event.data.usage.cacheReadTokens ?? 0;
      stats.cacheWrite += event.data.usage.cacheWriteTokens ?? 0;
    }

    return stats;
  }

  /** footer「上下文」口径：最近一次模型请求的 inputTokens + 模型广告的上下文窗口 */
  getLatestRequestStats(): { inputTokens: number; contextWindow?: number } {
    const record = this.record;
    let inputTokens = 0;
    const events = record?.agent.session.events;
    if (events) {
      for (const event of events) {
        if (event.type === "assistant/message" && event.data.usage) {
          inputTokens = event.data.usage.inputTokens ?? 0;
        }
      }
    }
    const contextWindow = record && typeof record.agent.session.requestContext === "function"
      ? record.agent.session.requestContext()?.contextWindow
      : undefined;
    return { inputTokens, contextWindow };
  }

  /** footer 流式指标：最后一场 turn 的首 token 平均延迟与最近一步输出速率 */
  getStreamMetrics(): { ttftAvgMs: number | null; outputSpeedTps: number | null } {
    return streamMetricsFromEvents(this.record?.agent.session.events ?? []);
  }

  exportMarkdown(): string {
    const record = this.record;
    if (!record) return "";

    const events = record.agent.session.events;
    if (!events || events.length === 0) return "";

    const lines: string[] = [`# DSH 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === "user/message") {
        const text = extractEventText(event);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === "assistant/message") {
        const text = extractEventText(event);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join("\n");
  }

  // ── 会话生命周期管理 ──

  private async composePreset(presetId?: string): Promise<PresetComposition> {
    let presets: AgentPresetsLike | undefined;
    try {
      presets = (this.ctx as unknown as Record<string, unknown>).agentPresets as AgentPresetsLike | undefined;
    } catch {
      // agentPresets 服务未注入，降级跳过
    }

    if (!presets) return {};

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (err) {
      this.logger.warn(
        `dsh-feishu-bridge: preset ${presetId ?? "(default)"} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 组装 setup：preset 挂载 + 插件自带的 scoped 贡献（飞书工具） */
  private combinedSetup(composed: PresetComposition): AgentSetup | undefined {
    const { setup } = composed;
    const withTools = this.config.registerBridgeTools;

    if (withTools && setup) {
      return async (agentCtx: Context) => {
        await setup(agentCtx);
        this.setupExtra(agentCtx);
      };
    }
    if (withTools) {
      return (agentCtx: Context) => {
        this.setupExtra(agentCtx);
      };
    }
    return setup;
  }

  /** 获取或恢复或创建共享 agent（live → resume → create） */
  async ensureAgent(): Promise<SessionRecord> {
    if (this.record) {
      this.record.lastActivity = Date.now();
      return this.record;
    }

    const key = this.sessionKey;
    const route = this.modelResolver.getEffectiveRoute(key);
    const sessionId = this.sessionId;
    this.logger.info(`ensureAgent: key=${key} route=${route ? `${route.provider}/${route.model}` : "host-default"} sessionId=${sessionId}`);

    let agent: Agent;
    let handle: AgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
      try {
        const composed = await this.composePreset(this.config.preset);
        agentPreset = composed.agentPreset;
        const resumeRoute = this.modelResolver.getResumeRoute(key);
        const setup = this.combinedSetup(composed);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
          ...(setup ? { setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? "none"} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : "session-own"}`);
      } catch (err) {
        // resume 失败（持久化后端缺失/损坏等）降级为全新创建；记录原因避免掩盖故障
        this.logger.warn(`resume failed, creating new: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
        const composed = await this.composePreset(this.config.preset);
        agentPreset = composed.agentPreset;
        const setup = this.combinedSetup(composed);
        const created = await this.agents.create({
          sessionId,
          meta: {
            cwd: this.config.cwd || process.cwd(),
            ...(agentPreset ? { agentPreset } : {}),
          },
          ...(route ? { agentOptions: route } : {}),
          ...(setup ? { setup } : {}),
        });
        agent = created.agent;
        handle = created;
        this.logger.info(`created new session: key=${key} preset=${agentPreset ?? "none"}`);
      }
    }

    this.registerSession(sessionId);

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      lastActivity: Date.now(),
      agentPreset,
    };

    this.record = record;
    return record;
  }

  /** 发送用户消息（入站核心：构建 UserMessage → followup） */
  async sendMessage(text: string): Promise<void> {
    const record = await this.ensureAgent();
    const content: ContentBlock[] = [{ type: "text" as const, text }];
    const message = createUserMessage({
      content,
      source: { kind: "user" as const },
    });
    record.agent.followup(message);
    record.lastActivity = Date.now();
    this.logger.info(`→ followup sent: key=${this.sessionKey} text="${text.slice(0, 200)}"`);
  }

  /** 取消当前任务（/stop、打断、超时） */
  cancel(): void {
    if (this.record) this.record.agent.cancel({ kind: "user" });
  }

  /** /new：释放当前 agent，改用全新 sessionId（历史仍持久化，可 /resume 恢复） */
  async reset(): Promise<SessionId> {
    await this.disposeRecord();
    const newId = SessionId(randomUUID());
    this.registerSession(newId);
    this.modelResolver.setSessionId(this.sessionKey, newId);
    this.logger.info(`session reset: key=${this.sessionKey} → ${newId}`);
    return newId;
  }

  /** /resume <sessionId>：释放当前 agent，恢复指定持久化会话 */
  async resumeSession(sessionId: string): Promise<boolean> {
    await this.disposeRecord();
    const target = SessionId(sessionId);
    try {
      const composed = await this.composePreset(this.config.preset);
      const setup = this.combinedSetup(composed);
      const resumed = await this.agents.resume({
        resumeSessionId: target,
        ...(setup ? { setup } : {}),
      });
      this.registerSession(target);
      this.record = {
        sessionKey: this.sessionKey,
        sessionId: target,
        agent: resumed.agent,
        handle: resumed,
        lastActivity: Date.now(),
        agentPreset: composed.agentPreset,
      };
      this.modelResolver.setSessionId(this.sessionKey, sessionId);
      this.logger.info(`session resumed: key=${this.sessionKey} sessionId=${sessionId}`);
      return true;
    } catch (err) {
      this.logger.error(`resume failed: sessionId=${sessionId} err=${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** 切换模型：fork 当前会话 → 以新模型创建子会话（对齐 dsh-qqbot setModelOverride） */
  async setModelOverride(route: ModelRoute): Promise<void> {
    const key = this.sessionKey;
    this.modelResolver.setOverride(key, route);

    const record = this.record;
    if (!record) {
      this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
      return;
    }

    const sessionsService = this.getSessionsService();
    if (!sessionsService) {
      this.logger.warn(`fork unavailable, fallback to dispose: key=${key}`);
      await this.disposeRecord();
      return;
    }

    let seed: readonly SessionEvent[];
    try {
      seed = sessionsService.fork(record.agent.session).events;
    } catch (err) {
      this.logger.warn(`fork failed, fallback to dispose: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
      await this.disposeRecord();
      return;
    }

    const childId = SessionId(randomUUID());
    const composed = await this.composePreset(this.config.preset);
    const setup = this.combinedSetup(composed);
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: this.config.cwd || process.cwd(),
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      agentOptions: route,
      ...(setup ? { setup } : {}),
    });

    this.registerSession(childId);
    this.modelResolver.setSessionId(key, childId);

    const oldHandle = record.handle;
    this.record = {
      sessionKey: key,
      sessionId: childId,
      agent: created.agent,
      handle: created,
      lastActivity: Date.now(),
      agentPreset: composed.agentPreset,
    };

    await oldHandle.dispose().catch(() => {});
    this.logger.info(`model switched via fork: key=${key} → ${route.provider}/${route.model} sessionId=${childId}`);
  }

  clearModelOverride(): void {
    const key = this.sessionKey;
    this.modelResolver.clearOverride(key);
    this.modelResolver.clearSessionId(key);
  }

  listAvailableModels() {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  /** 列出持久化会话（/resume 列表用） */
  async listPersistedSessions(): Promise<Array<{ id: string }>> {
    try {
      const persistence = this.ctx.get("sessionPersistence") as unknown as SessionPersistenceLike | undefined;
      if (!persistence || typeof persistence.list !== "function") return [];
      const sessions = await persistence.list();
      return sessions.map((s) => ({ id: s.id }));
    } catch (err) {
      this.logger.warn(`listPersistedSessions failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private getSessionsService(): SessionsService | undefined {
    try {
      return this.ctx.get("sessions") as unknown as SessionsService | undefined;
    } catch {
      return undefined;
    }
  }

  private countMessages(record: SessionRecord | null): number {
    const events = record?.agent.session.events;
    if (!events) return 0;

    let count = 0;
    for (const event of events) {
      if (event.type === "user/message" || event.type === "assistant/message") {
        count += 1;
      }
    }
    return count;
  }

  private async disposeRecord(): Promise<void> {
    const record = this.record;
    if (!record) return;
    this.record = null;
    record.agent.cancel({ kind: "user" });
    await record.handle.dispose().catch(() => {});
    this.logger.info(`session disposed: key=${this.sessionKey} sessionId=${record.sessionId}`);
  }

  async disposeAll(): Promise<void> {
    await this.disposeRecord();
  }
}

/** 从事件中提取纯文本（用于导出/统计） */
function extractEventText(event: SessionEvent): string {
  let content: unknown;
  if (event.type === "assistant/message") {
    content = event.data.message.content;
  } else if (event.type === "user/message") {
    content = event.data.content;
  }
  const blocks = content;
  if (!blocks || !Array.isArray(blocks)) return "";

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

export type { UserMessage };