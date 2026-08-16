/**
 * DshSessionManager — 飞书 → dsh Agent 的会话生命周期管理
 *
 * 会话模型（对齐 dsh-qqbot 的 per-peer 隔离语义）：
 *   每个飞书 chat 拥有独立的 dsh Agent（独立上下文/模型/工具状态），
 *   sessionKey 由 chatId 派生，重启后按 prefs 记录恢复各自会话。
 *   处理调度仍全局串行（MessageQueueManager 互斥），同一时刻只处理
 *   一个 chat——卡片系统按单活动会话设计，多 chat 并发需另行改造。
 *
 * sessionKey 格式: `feishu:${appId}:${chatId}`
 * SessionId 由 sessionKey 确定性派生（SHA-256），/new 或切换模型后
 * 记录最新 sessionId 到 PrefsStore，重启后按记录恢复。
 *
 * 创建/恢复/模型切换完全走 dsh agents 服务（对齐 dsh-qqbot）：
 *   agents.get → agents.resume → agents.create，并支持 agent-presets 挂载。
 */
import { createHash, randomUUID } from "node:crypto";
import { SessionId, type SessionEvent, type SessionHeader, type UserMessage } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, ReasoningEffortId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { installModelSelection, type Agent, type AgentHandle, type AgentSetup } from "@deepseek-ai/dsh-agent";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../types.js";
import { ModelResolver, type ModelRoute } from "./model-resolver.js";
import { PresetPrefsStore } from "./preset-prefs.js";
import { DisabledWorkspaceResolver, HostWorkspaceResolver } from "./workspace-host.js";
import type { WorkspaceBackend } from "./workspace-backend.js";
import { WorkspaceResolver, type EffectiveWorkspace, type WorkspaceController, type WorkspaceInfo } from "./workspace.js";
import { SessionOwnershipStore } from "./session-owners.js";
import { streamMetricsFromEvents } from "../session/usage.js";
import type {
  AgentPresetsLike,
  PersistedSessionInfo,
  PresetComposition,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
} from "./types.js";

/** 会话持久化服务（/resume 列表用） */
interface SessionPersistenceLike {
  list(signal?: AbortSignal): Promise<SessionHeader[]>;
}

/** 会话 fork 能力（切换模型用，可选） */
interface SessionsService {
  fork(source: unknown, boundary?: number): { events: readonly SessionEvent[] };
}

export class DshSessionManager {
  /** chat 会话记录表：sessionKey → SessionRecord（per-chat 隔离） */
  private readonly records = new Map<string, SessionRecord>();
  private readonly modelResolver: ModelResolver;
  /** 预设偏好持久化（per-chat + 全局默认），运行时命令可改 */
  private readonly presetPrefs: PresetPrefsStore;
  /** V1 工作区注册与 per-chat 选择 */
  private readonly workspaces: WorkspaceController;
  /** /resume 的 per-chat session 归属索引 */
  private readonly sessionOwners: SessionOwnershipStore;
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
    /** 创建/恢复 agent 时的额外 scoped setup（注册飞书工具等；chatId 为该 agent 所属会话） */
    private readonly setupExtra: (agentCtx: Context, chatId: string) => void = () => {},
    /** 预设偏好文件路径覆盖（仅供测试注入临时路径，避免污染用户真实偏好） */
    presetPrefsPath?: string,
    /** 工作区偏好文件路径覆盖（仅供测试注入临时路径） */
    workspacePrefsPath?: string,
    /** session 归属文件路径覆盖（仅供测试注入临时路径） */
    sessionOwnersPath?: string,
    /** workspace registry 文件路径覆盖（仅供测试注入临时路径） */
    workspaceRegistryPath?: string,
    /** V3 host backend；未提供时保持 V2 local。 */
    workspaceBackend?: WorkspaceBackend,
    /** host alias 映射文件路径覆盖（仅供测试注入临时路径） */
    workspaceMigrationPath?: string,
  ) {
    this.modelResolver = new ModelResolver(ctx, config, logger);
    this.presetPrefs = new PresetPrefsStore(
      config.debug ? (msg) => this.logger?.debug(msg) : undefined,
      presetPrefsPath,
    );
    const localResolver = new WorkspaceResolver(
      config,
      workspacePrefsPath,
      (message) => this.logger.warn(message),
      workspaceRegistryPath,
      workspaceBackend?.mode !== "host",
      workspaceBackend?.mode === "host",
    );
    this.workspaces = workspaceBackend?.mode === "host"
      ? new HostWorkspaceResolver(
          config,
          workspaceBackend,
          workspacePrefsPath,
          localResolver,
          (message) => this.logger.warn(message),
          workspaceMigrationPath,
        )
      : workspaceBackend?.mode === "disabled"
        ? new DisabledWorkspaceResolver(config)
        : localResolver;
    this.sessionOwners = new SessionOwnershipStore(sessionOwnersPath);
  }

  /** chat 对应的会话 key（per-chat 隔离） */
  sessionKeyFor(chatId: string): string {
    return `feishu:${this.config.appId}:${chatId}`;
  }

  /** 指定 chat 当前（或应恢复的）sessionId */
  sessionIdFor(chatId: string): SessionId {
    const key = this.sessionKeyFor(chatId);
    return SessionId(this.modelResolver.getSessionId(key) ?? this.deriveSessionId(key));
  }

  /** 该 sessionId 是否属于本插件管理过的会话（adapter 过滤用） */
  isOwnedSession(sessionId: SessionId): boolean {
    return this.ownedSessionIds.has(sessionId);
  }

  /** 记录一个本插件管理的 sessionId */
  private registerSession(sessionId: SessionId, chatId?: string): void {
    this.ownedSessionIds.add(sessionId);
    if (chatId) this.sessionOwners.add(this.sessionKeyFor(chatId), sessionId);
  }

  private ownsSession(chatId: string, sessionId: string): boolean {
    return sessionId === this.sessionIdFor(chatId)
      || this.sessionOwners.has(this.sessionKeyFor(chatId), sessionId);
  }

  /** 指定 chat 的活跃 agent 记录（可能为 null） */
  recordFor(chatId: string): SessionRecord | null {
    return this.records.get(this.sessionKeyFor(chatId)) ?? null;
  }

  /** sessionId → chatId 反查（事件流定位所属 chat 用） */
  chatIdForSession(sessionId: SessionId): string | undefined {
    const prefix = `feishu:${this.config.appId}:`;
    for (const [key, record] of this.records) {
      if (record.sessionId === sessionId) {
        const chatId = key.slice(prefix.length);
        return chatId || undefined;
      }
    }
    return undefined;
  }

  /** 全局空闲：没有任何 chat 的 agent 在运行（互斥调度依据） */
  get isIdle(): boolean {
    for (const record of this.records.values()) {
      if (record.agent.status !== "idle") return false;
    }
    return true;
  }

  /** 指定 chat 的 agent 是否空闲 */
  isIdleFor(chatId: string): boolean {
    const record = this.recordFor(chatId);
    return !record || record.agent.status === "idle";
  }

  /** 派生确定性 sessionId：同一个 key 重启后可恢复同一会话 */
  private deriveSessionId(sessionKey: string): string {
    const hash = createHash("sha256").update(sessionKey).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  // ── 模型相关（委托 ModelResolver） ──

  getEffectiveModel(chatId: string): ModelRoute | undefined {
    return this.modelResolver.getEffectiveRoute(this.sessionKeyFor(chatId));
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    return this.workspaces.list();
  }

  async getEffectiveWorkspace(chatId: string): Promise<EffectiveWorkspace> {
    return this.workspaces.getEffective(chatId);
  }

  isWorkspaceAdmin(senderOpenId: string, chatType: "p2p" | "group"): boolean {
    const configured = this.config.workspaceAdminOpenIds ?? [];
    if (configured.length > 0) return configured.includes(senderOpenId);
    return chatType === "p2p";
  }

  isWorkspaceCardAdmin(senderOpenId: string): boolean {
    return (this.config.workspaceAdminOpenIds ?? []).includes(senderOpenId);
  }

  async addWorkspace(workspaceId: string, path: string, title?: string): Promise<WorkspaceInfo> {
    return this.workspaces.addRuntime(workspaceId, path, title);
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.workspaces.removeRuntime(workspaceId);
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceInfo> {
    return this.workspaces.renameRuntime(workspaceId, title);
  }

  async switchWorkspace(
    chatId: string,
    workspaceId: string,
    mode: "reset" | "keep-context" = "reset",
  ): Promise<{ changed: boolean; workspace: EffectiveWorkspace; sessionId?: SessionId; preservedContext?: boolean }> {
    const current = await this.workspaces.getEffective(chatId);
    const targetInfo = await this.workspaces.registeredWorkspace(workspaceId, true);
    if (targetInfo.id === current.id && targetInfo.path === current.path) {
      return { changed: false, workspace: { ...targetInfo, source: current.source } };
    }
    if (mode === "keep-context") return this.switchWorkspaceWithContext(chatId, targetInfo);
    const target = await this.workspaces.select(chatId, workspaceId);
    const sessionId = await this.rotateSession(chatId);
    return { changed: true, workspace: target, sessionId, preservedContext: false };
  }

  private async switchWorkspaceWithContext(chatId: string, targetInfo: WorkspaceInfo): Promise<{ changed: boolean; workspace: EffectiveWorkspace; sessionId?: SessionId; preservedContext?: boolean }> {
    const key = this.sessionKeyFor(chatId);
    const record = this.records.get(key);
    if (!record) {
      const target = await this.workspaces.select(chatId, targetInfo.id);
      const sessionId = await this.rotateSession(chatId);
      return { changed: true, workspace: target, sessionId, preservedContext: false };
    }
    const sessions = this.getSessionsService();
    if (!sessions) throw new Error("宿主未提供 sessions.fork，无法使用 --keep-context。");
    let seed: readonly SessionEvent[];
    try {
      seed = sessions.fork(record.agent.session).events;
    } catch (error) {
      throw new Error("复制当前上下文失败，工作区未切换：" + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
    const composed = await this.composePreset(this.effectivePresetId(key));
    const setup = this.combinedSetup(composed, chatId);
    const route = this.modelResolver.getEffectiveRoute(key);
    const childId = SessionId(randomUUID());
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: targetInfo.path,
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      ...(route ? { agentOptions: route } : {}),
      ...(setup ? { setup } : {}),
    });
    try {
      await this.workspaces.attachSession(targetInfo.id, childId);
    } catch (error) {
      await created.dispose().catch(() => {});
      throw new Error("新会话未能归属目标工作区，工作区未切换：" + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
    const target = await this.workspaces.select(chatId, targetInfo.id);
    this.registerSession(childId, chatId);
    this.modelResolver.setSessionId(key, childId);
    this.records.set(key, { sessionKey: key, sessionId: childId, agent: created.agent, handle: created, lastActivity: Date.now(), agentPreset: composed.agentPreset });
    await record.handle.dispose().catch(() => {});
    return { changed: true, workspace: target, sessionId: childId, preservedContext: true };
  }

  async resetWorkspace(chatId: string): Promise<{ changed: boolean; workspace: EffectiveWorkspace; sessionId?: SessionId }> {
    const hadSelection = this.workspaces.currentSelection(chatId) !== undefined;
    const target = await this.workspaces.reset(chatId);
    if (!hadSelection) return { changed: false, workspace: target };
    const sessionId = await this.rotateSession(chatId);
    return { changed: true, workspace: target, sessionId };
  }

  private async effectiveWorkspace(chatId: string): Promise<EffectiveWorkspace> {
    return this.workspaces.getEffective(chatId);
  }

  private async rotateSession(chatId: string): Promise<SessionId> {
    const key = this.sessionKeyFor(chatId);
    await this.disposeRecordFor(key);
    const newId = SessionId(randomUUID());
    this.registerSession(newId, chatId);
    this.modelResolver.setSessionId(key, newId);
    this.logger.info("workspace session rotated: chat=" + chatId + " -> " + newId);
    return newId;
  }

  async getStatus(chatId: string): Promise<SessionStatus> {
    const key = this.sessionKeyFor(chatId);
    const record = this.recordFor(chatId);
    // 模型优先显示最近一次实际请求（与页脚口径一致）；无请求时回退有效路由
    const last = this.lastRequestHeader(record);
    const route = this.getEffectiveModel(chatId);
    const workspace = await this.effectiveWorkspace(chatId);
    return {
      active: !!record,
      // 无活跃 record（如刚重启）时仍显示确定性派生的 sessionId
      sessionId: record?.sessionId ?? this.sessionIdFor(chatId),
      provider: last?.provider ?? route?.provider,
      model: last?.model ?? route?.model,
      reasoningEffort: last?.reasoningEffort,
      // record 缺失时也从偏好/配置解析当前预设
      preset: record?.agentPreset ?? this.currentPreset(chatId).presetId,
      messageCount: this.countMessages(record),
      cwd: record?.agent.session.header?.cwd ?? workspace.path,
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      workspaceSource: workspace.source,
    };
  }

  /** 最近一次 request/header 事件的实际请求路由（无请求时 undefined） */
  private lastRequestHeader(
    record: SessionRecord | null,
  ): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
    const events = record?.agent.session.events;
    if (!events) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type !== "request/header") continue;
      const config = (event.data as { header?: { config?: { provider?: string; model?: string; reasoningEffort?: string } } })
        .header?.config;
      if (config) {
        return {
          provider: config.provider,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
        };
      }
    }
    return undefined;
  }

  /** 解析模型显示名（settings.yaml name；缺省回退 model id） */
  resolveModelLabel(provider: string, model: string): string {
    return this.modelResolver.resolveModelName(provider, model) ?? model;
  }

  getTokenUsage(chatId: string): TokenUsageStats {
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const events = this.recordFor(chatId)?.agent.session.events;
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

  /**
   * footer「上下文」口径：最近一次模型请求的 billed 输入（uncached + 缓存读/写，
   * 即本次完整 prompt 长度）+ 模型广告的上下文窗口。与「输入」字段的累计口径同源，
   * 避免出现「输入 100K / 上下文 419」这类因只取 uncached 部分而产生的费解对比。
   */
  getLatestRequestStats(chatId: string): { inputTokens: number; contextWindow?: number } {
    const record = this.recordFor(chatId);
    let inputTokens = 0;
    const events = record?.agent.session.events;
    if (events) {
      for (const event of events) {
        if (event.type !== "assistant/message" || !event.data.usage) continue;
        const u = event.data.usage;
        inputTokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
      }
    }
    const contextWindow = record && typeof record.agent.session.requestContext === "function"
      ? record.agent.session.requestContext()?.contextWindow
      : undefined;
    return { inputTokens, contextWindow };
  }

  /** footer 流式指标：最后一场 turn 的首 token 平均延迟与最近一步输出速率 */
  getStreamMetrics(chatId: string): { ttftAvgMs: number | null; outputSpeedTps: number | null } {
    return streamMetricsFromEvents(this.recordFor(chatId)?.agent.session.events ?? []);
  }

  exportMarkdown(chatId: string): string {
    const record = this.recordFor(chatId);
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

  // ── 预设管理（/preset） ──

  private getPresets(): AgentPresetsLike | undefined {
    const ctxAny = this.ctx as unknown as Record<string, unknown>;
    // 真实宿主：未 inject 的服务必须经 ctx.get 读取（属性访问会抛 client property 错误）
    try {
      const viaGet = typeof ctxAny.get === "function"
        ? (ctxAny.get as (key: string) => unknown)("agentPresets")
        : undefined;
      if (viaGet) return viaGet as AgentPresetsLike;
    } catch {
      // 忽略后继续尝试属性通道（测试桩用）
    }
    // 测试桩：ctx 直接挂 agentPresets 属性
    try {
      return ctxAny.agentPresets as AgentPresetsLike | undefined;
    } catch {
      return undefined;
    }
  }

  /** 当前生效预设法定的 id（解析优先级：per-chat > 全局默认 > config.preset；全空则不挂） */
  private effectivePresetId(key: string): string | undefined {
    return this.presetPrefs.getChatPreset(key) ?? this.presetPrefs.getDefault() ?? this.config.preset;
  }

  /** 当前生效预设及其来源（/preset 展示用；host 表示未显式指定） */
  currentPreset(chatId: string): { presetId?: string; source: "per-chat" | "global" | "config" | "host" } {
    const key = this.sessionKeyFor(chatId);
    const perChat = this.presetPrefs.getChatPreset(key);
    if (perChat) return { presetId: perChat, source: "per-chat" };
    const global = this.presetPrefs.getDefault();
    if (global) return { presetId: global, source: "global" };
    if (this.config.preset) return { presetId: this.config.preset, source: "config" };
    // 不跟随宿主自动挂默认：保持「未显式指定 = 宿主组合」，避免 settings 默认预设
    // （如 minimal）突然收窄桥的工具集。
    return { presetId: undefined, source: "host" };
  }

  /** /preset default：全局默认预设（无 per-chat 偏好且 config.preset 未设时生效） */
  getDefaultPresetPref(): string | undefined {
    return this.presetPrefs.getDefault();
  }

  setDefaultPreset(id: string | undefined): void {
    this.presetPrefs.setDefault(id);
    this.logger.info(`preset default updated: ${id ?? "(cleared)"}`);
  }

  /** per-chat 预设偏好读写 */
  getChatPresetPref(chatId: string): string | undefined {
    return this.presetPrefs.getChatPreset(this.sessionKeyFor(chatId));
  }

  setChatPreset(chatId: string, id: string): void {
    this.presetPrefs.setChatPreset(this.sessionKeyFor(chatId), id);
    this.logger.info(`preset pref saved: chat=${chatId} → ${id}`);
  }

  clearChatPreset(chatId: string): boolean {
    const deleted = this.presetPrefs.clearChatPreset(this.sessionKeyFor(chatId));
    if (deleted) this.logger.info(`preset pref cleared: chat=${chatId}`);
    return deleted;
  }

  /** 罗列可用预设（/preset 列表用；宿主未组合时返回 []） */
  async listAvailablePresets(): Promise<Array<{ id: string; name?: string; description?: string }>> {
    const presets = this.getPresets();
    if (!presets || typeof presets.list !== "function") return [];
    try {
      const rows = await presets.list();
      return rows.map((row) => ({ id: row.id, name: row.name, description: row.description }));
    } catch (err) {
      this.logger.warn(`listAvailablePresets failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 宿主默认预设 id（settings agent-presets.default / agentPresets config.default） */
  get hostDefaultPresetId(): string | undefined {
    return this.getPresets()?.defaultId;
  }

  /** 校验预设 id 存在；resolve 成功返回规范化 id，失败返回 undefined */
  async resolvePresetId(presetId: string): Promise<string | undefined> {
    const presets = this.getPresets();
    if (!presets) return undefined;
    try {
      const resolved = await presets.resolve(presetId);
      return resolved.id;
    } catch {
      return undefined;
    }
  }

  /** /preset <id>：保存 per-chat 偏好并让当前会话切到新预设（优先 fork 复制历史，失败重置） */
  async switchPreset(chatId: string, presetId: string): Promise<{ ok: boolean; message: string }> {
    const key = this.sessionKeyFor(chatId);
    const presets = this.getPresets();
    if (!presets) {
      return { ok: false, message: "宿主未组合 agentPresets 服务，无法切换预设。" };
    }
    try {
      const resolved = await presets.resolve(presetId);
      presetId = resolved.id;
    } catch (err) {
      const available = (err as { available?: readonly string[] })?.available;
      const hint = available && available.length > 0 ? `\n可用预设: ${available.join(", ")}` : "";
      return { ok: false, message: `预设不存在: ${presetId}${hint}` };
    }

    this.setChatPreset(chatId, presetId);

    const record = this.records.get(key);
    if (!record) {
      this.logger.info(`preset pref saved (no active session): key=${key} → ${presetId}`);
      return { ok: true, message: `已保存预设偏好: ${presetId}（下次消息创建会话时生效）` };
    }

    const sessionsService = this.getSessionsService();
    if (!sessionsService) {
      await this.disposeRecordFor(key);
      return { ok: true, message: `已切换预设: ${presetId}（fork 不可用，已重置当前会话）` };
    }

    let seed: readonly SessionEvent[];
    try {
      seed = sessionsService.fork(record.agent.session).events;
    } catch (err) {
      this.logger.warn(`preset switch fork failed, fallback to dispose: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
      await this.disposeRecordFor(key);
      return { ok: true, message: `已切换预设: ${presetId}（历史复制失败，已重置当前会话）` };
    }

    const childId = SessionId(randomUUID());
    const composed = await this.composePreset(this.effectivePresetId(key));
    const route = this.modelResolver.getEffectiveRoute(key);
    const setup = this.combinedSetup(composed, chatId);
    const workspace = await this.effectiveWorkspace(chatId);
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: workspace.path,
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      ...(route ? { agentOptions: route } : {}),
      ...(setup ? { setup } : {}),
    });

    try {
      await this.workspaces.attachSession(workspace.id, childId);
    } catch (error) {
      await created.dispose().catch(() => {});
      throw new Error("新会话未能归属当前工作区，预设未切换：" + (error instanceof Error ? error.message : String(error)), { cause: error });
    }

    this.registerSession(childId, chatId);
    this.modelResolver.setSessionId(key, childId);

    const oldHandle = record.handle;
    this.records.set(key, {
      sessionKey: key,
      sessionId: childId,
      agent: created.agent,
      handle: created,
      lastActivity: Date.now(),
      agentPreset: composed.agentPreset,
    });

    await oldHandle.dispose().catch(() => {});
    this.logger.info(`preset switched via fork: chat=${chatId} key=${key} → ${presetId} sessionId=${childId}`);
    return { ok: true, message: `已切换预设: ${presetId}（保留上下文，fork 为新会话）` };
  }

  // ── 会话生命周期管理 ──

  private async composePreset(presetId?: string): Promise<PresetComposition> {
    // 未显式指定预设时不挂载任何组合：保持宿主组合（工具全集），
    // 避免跟随宿主默认预设（settings agent-presets.default）悄悄收窄能力。
    if (!presetId) return {};

    const presets = this.getPresets();
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

  /** 组装 setup：preset 挂载 + 插件自带的 scoped 贡献（飞书工具 + 思考强度 selection） */
  private combinedSetup(composed: PresetComposition, chatId: string): AgentSetup | undefined {
    const { setup } = composed;
    const withTools = this.config.registerBridgeTools;
    const key = this.sessionKeyFor(chatId);
    const effort = this.modelResolver.getEffortOverride(key);
    const route = this.modelResolver.getEffectiveRoute(key);
    // 仅当存在 effort override 且 route 完整时才挂 installModelSelection：
    // selection.current 会覆盖 provider/model/effort，必须三者齐全；
    // 无 override 时不挂，让 adapter 默认 effort 生效（避免清除继承值）
    const selectionInstall =
      effort && route
        ? (agentCtx: Context) =>
            installModelSelection(agentCtx, {
              current: { provider: route.provider, model: route.model, reasoningEffort: ReasoningEffortId(effort) },
              assembled: undefined,
            })
        : undefined;

    const contributions: Array<(agentCtx: Context) => void> = [];
    if (selectionInstall) contributions.push(selectionInstall);
    if (withTools) contributions.push((agentCtx) => this.setupExtra(agentCtx, chatId));

    if (contributions.length === 0) return setup;

    const inline = async (agentCtx: Context) => {
      if (setup) await setup(agentCtx);
      for (const fn of contributions) fn(agentCtx);
    };
    return inline;
  }

  /** 获取或恢复或创建 chat 的 agent（live → resume → create） */
  async ensureAgent(chatId: string): Promise<SessionRecord> {
    const key = this.sessionKeyFor(chatId);
    const existing = this.records.get(key);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }

    const route = this.modelResolver.getEffectiveRoute(key);
    const sessionId = this.sessionIdFor(chatId);
    this.logger.info(`ensureAgent: chat=${chatId} key=${key} route=${route ? `${route.provider}/${route.model}` : "host-default"} sessionId=${sessionId}`);

    let agent: Agent;
    let handle: AgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
      try {
        const composed = await this.composePreset(this.effectivePresetId(key));
        agentPreset = composed.agentPreset;
        // resume 必须补齐 agent.options.provider/model：dsh 首次请求的 seedConfig
        // 直接取 options（requestHeaderLogged=false），缺了会报 persona {{model}}
        // 无值 / agent has no provider-model。显式切换优先，否则用宿主有效路由兜底。
        const resumeRoute = this.modelResolver.getResumeRoute(key) ?? route;
        const setup = this.combinedSetup(composed, chatId);
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
        const composed = await this.composePreset(this.effectivePresetId(key));
        agentPreset = composed.agentPreset;
        const setup = this.combinedSetup(composed, chatId);
        const workspace = await this.effectiveWorkspace(chatId);
        const created = await this.agents.create({
          sessionId,
          meta: {
            cwd: workspace.path,
            ...(agentPreset ? { agentPreset } : {}),
          },
          ...(route ? { agentOptions: route } : {}),
          ...(setup ? { setup } : {}),
        });
        try {
          await this.workspaces.attachSession(workspace.id, sessionId);
        } catch (error) {
          await created.dispose().catch(() => {});
          throw new Error("新会话未能归属当前工作区，未建立会话：" + (error instanceof Error ? error.message : String(error)), { cause: error });
        }
        agent = created.agent;
        handle = created;
        this.logger.info(`created new session: key=${key} preset=${agentPreset ?? "none"}`);
      }
    }

    this.registerSession(sessionId, chatId);

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      lastActivity: Date.now(),
      agentPreset,
    };

    this.records.set(key, record);
    return record;
  }

  /** 发送用户消息（入站核心：构建 UserMessage → followup） */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const record = await this.ensureAgent(chatId);
    const content: ContentBlock[] = [{ type: "text" as const, text }];
    const message = createUserMessage({
      content,
      source: { kind: "user" as const },
    });
    record.agent.followup(message);
    record.lastActivity = Date.now();
    this.logger.info(`→ followup sent: chat=${chatId} text="${text.slice(0, 200)}"`);
  }

  /** 取消指定 chat 的当前任务（/stop、打断、超时） */
  cancel(chatId: string): void {
    this.recordFor(chatId)?.agent.cancel({ kind: "user" });
  }

  /** /new：释放 chat 的 agent，改用全新 sessionId（历史仍持久化，可 /resume 恢复） */
  async reset(chatId: string): Promise<SessionId> {
    const key = this.sessionKeyFor(chatId);
    await this.disposeRecordFor(key);
    const newId = SessionId(randomUUID());
    this.registerSession(newId, chatId);
    this.modelResolver.setSessionId(key, newId);
    this.logger.info(`session reset: chat=${chatId} key=${key} → ${newId}`);
    return newId;
  }

  /** /resume <sessionId>：只恢复当前 chat 已登记且 cwd 可对齐的会话 */
  async resumeSession(chatId: string, sessionId: string): Promise<boolean> {
    const key = this.sessionKeyFor(chatId);
    if (!this.ownsSession(chatId, sessionId)) {
      this.logger.warn("resume denied: session does not belong to chat=" + chatId + " sessionId=" + sessionId);
      return false;
    }

    const header = await this.findPersistedSession(sessionId);
    const workspace = await this.effectiveWorkspace(chatId);
    if (header?.cwd && !this.workspaces.matchesPath(header.cwd, workspace.path)
      && !(await this.workspaces.workspaceIdForPath(header.cwd))) {
      this.logger.warn("resume denied: session workspace is not registered chat=" + chatId + " cwd=" + header.cwd);
      return false;
    }

    // V3c：恢复目标完成前不释放旧 record；失败时旧 record 与当前 selection 完整保留。
    const oldRecord = this.records.get(key);
    const target = SessionId(sessionId);
    try {
      const composed = await this.composePreset(this.effectivePresetId(key));
      const setup = this.combinedSetup(composed, chatId);
      // 同 ensureAgent：resume 必须补 agentOptions（显式切换优先，否则宿主有效路由），
      // 否则 agent.options 为空导致 persona {{model}} 无值 / 无 provider-model。
      const route = this.modelResolver.getEffectiveRoute(key);
      const resumed = await this.agents.resume({
        resumeSessionId: target,
        ...(route ? { agentOptions: route } : {}),
        ...(setup ? { setup } : {}),
      });
      if (header?.cwd && !this.workspaces.matchesPath(header.cwd, workspace.path)) {
        await this.workspaces.adoptSessionPath(chatId, header.cwd);
      }
      this.registerSession(target, chatId);
      this.records.set(key, {
        sessionKey: key,
        sessionId: target,
        agent: resumed.agent,
        handle: resumed,
        lastActivity: Date.now(),
        agentPreset: composed.agentPreset,
      });
      this.modelResolver.setSessionId(key, sessionId);
      this.logger.info(`session resumed: chat=${chatId} key=${key} sessionId=${sessionId}`);
      // 新 record 已提交后再释放旧 handle，避免失败路径丢失旧会话。
      if (oldRecord && oldRecord.handle !== resumed) {
        await oldRecord.handle.dispose().catch(() => {});
      }
      return true;
    } catch (err) {
      this.logger.error(`resume failed: chat=${chatId} sessionId=${sessionId} err=${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * fork 重建 chat 的 agent（切换模型/思考强度的公共路径）。
   *
   * 调用方须先 setOverride/setEffortOverride 写好偏好；combinedSetup 会
   * 自动把当前 effort override 注入新 agent 的 model-selection。route 仅
   * 用于 agentOptions（provider/model），不在此读 effort。
   */
  private async rebuildViaFork(chatId: string, key: string, route: ModelRoute, logTag: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) {
      this.logger.info(`pref saved (no active session): chat=${chatId} key=${key} ${logTag}`);
      return;
    }

    const sessionsService = this.getSessionsService();
    if (!sessionsService) {
      this.logger.warn(`fork unavailable, fallback to dispose: key=${key}`);
      await this.disposeRecordFor(key);
      return;
    }

    let seed: readonly SessionEvent[];
    try {
      seed = sessionsService.fork(record.agent.session).events;
    } catch (err) {
      this.logger.warn(`fork failed, fallback to dispose: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
      await this.disposeRecordFor(key);
      return;
    }

    const childId = SessionId(randomUUID());
    const composed = await this.composePreset(this.effectivePresetId(key));
    const setup = this.combinedSetup(composed, chatId);
    const workspace = await this.effectiveWorkspace(chatId);
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: workspace.path,
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      agentOptions: route,
      ...(setup ? { setup } : {}),
    });

    try {
      await this.workspaces.attachSession(workspace.id, childId);
    } catch (error) {
      await created.dispose().catch(() => {});
      throw new Error("新会话未能归属当前工作区，模型/思考强度未切换：" + (error instanceof Error ? error.message : String(error)), { cause: error });
    }

    this.registerSession(childId, chatId);
    this.modelResolver.setSessionId(key, childId);

    const oldHandle = record.handle;
    this.records.set(key, {
      sessionKey: key,
      sessionId: childId,
      agent: created.agent,
      handle: created,
      lastActivity: Date.now(),
      agentPreset: composed.agentPreset,
    });

    await oldHandle.dispose().catch(() => {});
    this.logger.info(`rebuild via fork: chat=${chatId} key=${key} ${logTag} sessionId=${childId}`);
  }

  /**
   * 切换模型：fork 重建。若现有 effort override 不被新模型支持则清除。
   * 返回额外提示（如 effort 被重置），由调用方拼入回复。
   */
  async setModelOverride(chatId: string, route: ModelRoute): Promise<string | undefined> {
    const key = this.sessionKeyFor(chatId);
    this.modelResolver.setOverride(key, route);
    const dropped = await this.dropEffortIfUnsupported(key, route);
    await this.rebuildViaFork(chatId, key, route, `model → ${route.provider}/${route.model}`);
    if (dropped) return `注意：新模型不支持思考强度 ${dropped}，已重置为默认。可用 /reasoning 查看可选项。`;
    return undefined;
  }

  /**
   * 设置 per-chat 思考强度 override 并 fork 重建。
   * 校验当前模型支持该 effort，不支持抛错（由命令层 catch）。
   */
  async setReasoningEffort(chatId: string, effort: string): Promise<void> {
    const key = this.sessionKeyFor(chatId);
    const route = this.modelResolver.getEffectiveRoute(key);
    if (!route) throw new Error("无有效模型，无法设置思考强度；请先用 /model 指定模型。");
    const info = await this.modelResolver.resolveReasoningInfo(route.provider, route.model);
    if (!info) throw new Error(`${route.provider}/${route.model} 不支持思考强度调节。`);
    const matched = info.efforts.find((e) => e.id === effort);
    if (!matched) {
      throw new Error(`${route.provider}/${route.model} 不支持思考强度 ${effort}，可选: ${info.efforts.map((e) => e.id).join(", ")}。`);
    }
    this.modelResolver.setEffortOverride(key, effort);
    await this.rebuildViaFork(chatId, key, route, `effort → ${effort}`);
  }

  /** 清除 per-chat 思考强度 override 并 fork 重建（恢复 adapter 默认） */
  async clearReasoningEffort(chatId: string): Promise<void> {
    const key = this.sessionKeyFor(chatId);
    this.modelResolver.clearEffortOverride(key);
    const route = this.modelResolver.getEffectiveRoute(key);
    if (route) await this.rebuildViaFork(chatId, key, route, "effort → default");
  }

  /**
   * 查询当前 chat 的思考强度状态（供 /reasoning 展示）。
   * current = 显式 override > "(默认)"；efforts 为当前模型可选列表。
   */
  async getReasoningStatus(chatId: string): Promise<{
    model: string;
    current: string;
    efforts: Array<{ id: string; name: string; description?: string }>;
    defaultEffort?: string;
  }> {
    const key = this.sessionKeyFor(chatId);
    const route = this.modelResolver.getEffectiveRoute(key);
    if (!route) {
      return { model: "（宿主默认）", current: "—", efforts: [] };
    }
    const info = await this.modelResolver.resolveReasoningInfo(route.provider, route.model);
    const override = this.modelResolver.getEffortOverride(key);
    return {
      model: `${route.provider}/${route.model}`,
      current: override ?? "（默认）",
      efforts: info?.efforts ?? [],
      defaultEffort: info?.defaultEffort,
    };
  }

  /** 若 effort override 不被 route 指定模型支持，清除并返回被清除的 effort */
  private async dropEffortIfUnsupported(key: string, route: ModelRoute): Promise<string | undefined> {
    const effort = this.modelResolver.getEffortOverride(key);
    if (!effort) return undefined;
    const info = await this.modelResolver.resolveReasoningInfo(route.provider, route.model);
    const supported = info?.efforts.some((e) => e.id === effort) ?? false;
    if (!supported) {
      this.modelResolver.clearEffortOverride(key);
      return effort;
    }
    return undefined;
  }

  clearModelOverride(chatId: string): void {
    const key = this.sessionKeyFor(chatId);
    this.modelResolver.clearOverride(key);
    this.modelResolver.clearSessionId(key);
  }

  listAvailableModels() {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  /**
   * 列出当前 chat 已登记的持久化会话；未知归属默认不展示。
   * DTO 为可扩展的 PersistedSessionInfo；host 模式根据 workspaces.list() 的
   * sessionIds 补充 Workspace 归属，未归属条目不携带 workspace 字段
   * （local/V2 模式 workspaces 不填 sessionIds，保持原有纯 id 语义）。
   */
  async listPersistedSessions(chatId: string): Promise<PersistedSessionInfo[]> {
    let ownedSessions: Array<{ id: string }>;
    try {
      const persistence = this.ctx.get("sessionPersistence") as unknown as SessionPersistenceLike | undefined;
      if (!persistence || typeof persistence.list !== "function") return [];
      ownedSessions = (await persistence.list())
        .filter((session) => this.ownsSession(chatId, session.id))
        .map((session) => ({ id: session.id }));
    } catch (err) {
      this.logger.warn(`listPersistedSessions failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    if (ownedSessions.length === 0) return [];
    const rows: PersistedSessionInfo[] = ownedSessions.map((session) => ({ id: session.id }));

    try {
      // 宿主实体 sessionIds 已经是 header 校验后的归属；只读映射，不序列化 live 对象。
      const workspaces = await this.workspaces.list();
      const sessionToWorkspace = new Map<string, WorkspaceInfo>();
      for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds ?? []) {
          if (!sessionToWorkspace.has(sessionId)) sessionToWorkspace.set(sessionId, workspace);
        }
      }
      for (const row of rows) {
        const workspace = sessionToWorkspace.get(row.id);
        if (!workspace) continue;
        row.workspaceId = workspace.id;
        row.workspaceTitle = workspace.title;
        row.workspacePath = workspace.path;
      }
    } catch (err) {
      // 分组只影响展示，不影响恢复；宿主查询失败时降级为未分组列表
      this.logger.warn(`listPersistedSessions workspace mapping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return rows;
  }

  private async findPersistedSession(sessionId: string): Promise<SessionHeader | undefined> {
    try {
      const persistence = this.ctx.get("sessionPersistence") as unknown as SessionPersistenceLike | undefined;
      if (!persistence || typeof persistence.list !== "function") return undefined;
      return (await persistence.list()).find((session) => session.id === sessionId);
    } catch (err) {
      this.logger.warn(`findPersistedSession failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** 闲置回收：dispose 超过 timeout 且空闲的 chat agent，返回被回收的 sessionId 列表 */
  async evictIdle(timeoutMs: number, now = Date.now()): Promise<string[]> {
    const evicted: string[] = [];
    for (const [key, record] of [...this.records]) {
      if (record.agent.status === "idle" && now - record.lastActivity > timeoutMs) {
        evicted.push(record.sessionId);
        await this.disposeRecordFor(key);
      }
    }
    return evicted;
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

  private async disposeRecordFor(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;
    this.records.delete(key);
    record.agent.cancel({ kind: "user" });
    await record.handle.dispose().catch(() => {});
    this.logger.info(`session disposed: key=${key} sessionId=${record.sessionId}`);
  }

  async disposeAll(): Promise<void> {
    const keys = [...this.records.keys()];
    for (const key of keys) {
      await this.disposeRecordFor(key);
    }
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