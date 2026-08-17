/**
 * DSH 对接层类型定义。
 *
 * 直接复用 @deepseek-ai/dsh-* 的官方类型（peerDependencies 已声明），
 * 避免像早期版本那样自造简化类型导致与宿主 API 漂移。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle, AgentSetup } from "@deepseek-ai/dsh-agent";
import type { SessionEvent, SessionId, UserMessage } from "@deepseek-ai/dsh-session";

export type { Agent, AgentHandle, AgentSetup, SessionId, SessionEvent, UserMessage };

/** agent-presets 服务接口（可选，部署中可能没有） */
export interface AgentPresetsLike {
  readonly defaultId: string;
  /** 罗列当前所有可用预设（展示用） */
  list(): Promise<Array<{ id: string; name?: string; description?: string }>>;
  resolve(id?: string): Promise<{ id: string }>;
  mount(agentCtx: Context, id?: string): Promise<unknown>;
}

/** preset 组合结果 */
export interface PresetComposition {
  agentPreset?: string;
  setup?: AgentSetup;
}

/** 单一会话记录（本插件采用「多 chat 共享一个 dsh Agent」模型） */
export interface SessionRecord {
  sessionKey: string;
  sessionId: SessionId;
  agent: Agent;
  handle: AgentHandle;
  agentPreset?: string;
  lastActivity: number;
}

/** 会话状态信息（/status 用） */
export interface SessionStatus {
  active: boolean;
  sessionId?: string;
  provider?: string;
  model?: string;
  /** 最近一次请求的思考强度（reasoningEffort，如 max/high；无请求时为 undefined） */
  reasoningEffort?: string;
  preset?: string;
  messageCount?: number;
  /** Agent 工作目录（活跃会话取 session header，否则有效工作区） */
  cwd?: string;
  workspaceId?: string;
  workspaceTitle?: string;
  workspaceSource?: "chat" | "default";
}

/** token 用量统计（/cost 用） */
export interface TokenUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** /resume 列表的持久化会话条目；workspace 字段仅 host 模式有归属时填充，未归属不出现。 */
export interface PersistedSessionInfo {
  id: string;
  workspaceId?: string;
  workspaceTitle?: string;
  workspacePath?: string;
}