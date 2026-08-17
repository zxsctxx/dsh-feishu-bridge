/**
 * dsh-feishu-bridge 插件配置：Cordis Schema（Schemastery）。
 *
 * 配置来源优先级：cordis.yml config 字段 → FEISHU_* 环境变量（覆盖同名项）。
 * 生产建议：accessPolicy=allowlist 并配置 allowedOpenIds/allowedChatIds。
 */
import Schema from "@deepseek-ai/schemastery";
import type { FooterConfig } from "./types.js";

/** 页面脚注布局的默认两行（status/耗时/首 token/速率/模型；缓存命中/输入/输出/上下文） */
export const DEFAULT_FOOTER_LINES: string[][] = [
  ["status", "elapsed", "ttft", "speed", "model"],
  ["cache_hit", "input", "output", "context"],
];

export interface BridgeFeishuConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  encryptKey?: string;
  verificationToken?: string;
}

export interface BridgeConfig {
  // ── 飞书 ──
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  encryptKey?: string;
  verificationToken?: string;

  // ── DSH Agent ──
  provider?: string;
  model?: string;
  preset?: string;
  /** 默认工作区：宿主工作区标题或 UUID；优先级低于 per-chat 选择。 */
  defaultWorkspace?: string;
  /** 可切换工作区的用户；群聊未配置时不允许切换。 */
  workspaceAdminOpenIds?: string[];
  /** 运行时注册工作区允许使用的根目录。 */
  workspaceRoots?: string[];
  /** 是否把飞书工具（send_to_feishu 等）注册进共享 agent 的 scoped 工具集 */
  registerBridgeTools: boolean;

  // ── 流式卡片 ──
  flushIntervalMs: number;
  showThinking: boolean;
  printStrategy: "fast" | "delay";
  printStep: number;
  panelExpanded: boolean;
  streamingPanelExpanded: boolean;
  maxToolSteps: number;
  maxThinkingRounds: number;
  maxAnswerElementChars: number;
  maxReasoningChars: number;
  maxToolDetailChars: number;
  maxToolOutputChars: number;
  printFrequencyMs: number;
  footer?: FooterConfig;

  // ── 访问控制 ──
  accessPolicy: "open" | "allowlist";
  allowedChatIds: string[];
  allowedOpenIds: string[];
  requireMentionInGroup: boolean;

  // ── 行为 ──
  clarifyTimeoutSec: number;
  taskTimeoutSec: number;
  sameChatBusyPolicy: "queue" | "interrupt";
  sessionIdleTimeout: number;
  maxQueue: number;
  processingTimeoutMs: number;
  debug: boolean;
}

const FooterSchema = Schema.object({
  showFooter: Schema.boolean().default(true),
  lines: Schema.array(
    Schema.array(Schema.string()),
  ).default(DEFAULT_FOOTER_LINES),
}) as unknown as Schema<FooterConfig>;

export const ConfigSchema: Schema<BridgeConfig> = Schema.object({
  // ── 飞书 ──
  appId: Schema.string().default("").description("飞书 App ID（也可用 FEISHU_APP_ID）"),
  appSecret: Schema.string().default("").description("飞书 App Secret（也可用 FEISHU_APP_SECRET）"),
  domain: Schema.union(["feishu", "lark"]).default("feishu").description("域名：feishu（国内）或 lark（海外）"),
  encryptKey: Schema.string().description("事件加密密钥（可选）"),
  verificationToken: Schema.string().description("事件验证令牌（可选）"),

  // ── DSH Agent ──
  provider: Schema.string().description("LLM provider 名称（缺省用宿主默认）"),
  model: Schema.string().description("模型名称（缺省用宿主默认）"),
  preset: Schema.string().description("Agent preset id（缺省用宿主默认预设）"),
  defaultWorkspace: Schema.string().description("默认工作区：宿主工作区标题或 UUID"),
  workspaceAdminOpenIds: Schema.array(Schema.string()).default([]).description("可切换工作区的用户 open_id"),
  workspaceRoots: Schema.array(Schema.string()).default([]).description("运行时注册工作区允许使用的根目录"),
  registerBridgeTools: Schema.boolean().default(true).description("是否注册飞书工具（send_to_feishu 等）到共享 agent"),

  // ── 流式卡片 ──
  flushIntervalMs: Schema.number().min(80).max(2000).default(200).description("流式刷新节流间隔(ms)"),
  showThinking: Schema.boolean().default(false).description("是否展示推理正文"),
  printStrategy: Schema.union(["fast", "delay"]).default("delay").description("推理打印策略"),
  printStep: Schema.number().min(1).max(100).default(4).description("推理打印步长"),
  panelExpanded: Schema.boolean().default(false).description("过程面板默认展开"),
  streamingPanelExpanded: Schema.boolean().default(false).description("流式过程面板默认展开"),
  maxToolSteps: Schema.number().min(1).max(200).default(20).description("过程面板最多展示的工具数"),
  maxThinkingRounds: Schema.number().min(1).max(200).default(20).description("过程面板最多展示的推理轮数"),
  maxAnswerElementChars: Schema.number().min(1000).max(30000).default(30000).description("超过后创建续卡"),
  maxReasoningChars: Schema.number().min(200).max(30000).default(3500).description("单轮推理正文展示上限"),
  maxToolDetailChars: Schema.number().min(50).max(10000).default(500).description("工具参数/detail 展示与存储上限"),
  maxToolOutputChars: Schema.number().min(50).max(10000).default(800).description("工具输出展示与存储上限"),
  printFrequencyMs: Schema.number().min(20).max(1000).default(70).description("CardKit print_frequency_ms"),
  footer: FooterSchema.description("终态卡片页脚布局"),

  // ── 访问控制 ──
  accessPolicy: Schema.union(["open", "allowlist"]).default("allowlist").description("默认白名单；开发可显式设 open"),
  allowedChatIds: Schema.array(Schema.string()).default([]).description("允许的 chat_id 白名单"),
  allowedOpenIds: Schema.array(Schema.string()).default([]).description("允许的 open_id 白名单"),
  requireMentionInGroup: Schema.boolean().default(false).description("群聊需要 @Bot 才触发"),

  // ── 行为 ──
  clarifyTimeoutSec: Schema.number().min(10).max(3600).default(300).description("ask_feishu 默认等待时间(秒)"),
  taskTimeoutSec: Schema.number().min(30).max(86400).default(900).description("单轮 Agent 硬超时(秒)，超时 abort 并终态封卡"),
  sameChatBusyPolicy: Schema.union(["queue", "interrupt"]).default("queue").description("同 chat 忙时：queue 排队；interrupt 打断当前并只跑最新消息"),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description("Agent 闲置超时(ms)，超时 dispose 释放"),
  maxQueue: Schema.number().default(20).description("并发队列最大长度"),
  processingTimeoutMs: Schema.number().default(120_000).description("处理超时(ms)"),
  debug: Schema.boolean().default(false).description("调试模式"),
});

// ── FEISHU_* 环境变量叠加 ──

const ENV_BOOLEAN = new Set(["1", "true", "yes"]);
const ENV_NUMBER = /^\d+(\.\d+)?$/;

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return ENV_BOOLEAN.has(value.toLowerCase());
}

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || !ENV_NUMBER.test(value)) return undefined;
  return Number(value);
}

function envList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * 用 FEISHU_* 环境变量覆盖 cordis.yml 配置。
 * 环境变量优先级更高，与 pi-feishu-bridge 语义一致。
 */
export function applyEnvOverrides(config: BridgeConfig, env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const next = { ...config } as Record<string, unknown>;

  const overlays: Array<[key: string, value: unknown]> = [
    ["appId", env.FEISHU_APP_ID],
    ["appSecret", env.FEISHU_APP_SECRET],
    ["domain", env.FEISHU_DOMAIN],
    ["encryptKey", env.FEISHU_ENCRYPT_KEY],
    ["verificationToken", env.FEISHU_VERIFICATION_TOKEN],
    ["flushIntervalMs", envNumber(env.FEISHU_FLUSH_INTERVAL_MS)],
    ["showThinking", envBool(env.FEISHU_SHOW_THINKING)],
    ["printStrategy", env.FEISHU_PRINT_STRATEGY],
    ["printStep", envNumber(env.FEISHU_PRINT_STEP)],
    ["panelExpanded", envBool(env.FEISHU_PANEL_EXPANDED)],
    ["streamingPanelExpanded", envBool(env.FEISHU_STREAMING_PANEL_EXPANDED)],
    ["maxToolSteps", envNumber(env.FEISHU_MAX_TOOL_STEPS)],
    ["maxThinkingRounds", envNumber(env.FEISHU_MAX_THINKING_ROUNDS)],
    ["maxAnswerElementChars", envNumber(env.FEISHU_MAX_ANSWER_ELEMENT_CHARS)],
    ["maxReasoningChars", envNumber(env.FEISHU_MAX_REASONING_CHARS)],
    ["maxToolDetailChars", envNumber(env.FEISHU_MAX_TOOL_DETAIL_CHARS)],
    ["maxToolOutputChars", envNumber(env.FEISHU_MAX_TOOL_OUTPUT_CHARS)],
    ["printFrequencyMs", envNumber(env.FEISHU_PRINT_FREQUENCY_MS)],
    ["accessPolicy", env.FEISHU_ACCESS_POLICY],
    ["allowedChatIds", envList(env.FEISHU_ALLOWED_CHAT_IDS)],
    ["allowedOpenIds", envList(env.FEISHU_ALLOWED_OPEN_IDS)],
    ["requireMentionInGroup", envBool(env.FEISHU_REQUIRE_MENTION_IN_GROUP)],
    ["clarifyTimeoutSec", envNumber(env.FEISHU_CLARIFY_TIMEOUT_SEC)],
    ["taskTimeoutSec", envNumber(env.FEISHU_TASK_TIMEOUT_SEC)],
    ["sameChatBusyPolicy", env.FEISHU_SAME_CHAT_BUSY_POLICY],
  ];

  for (const [key, value] of overlays) {
    if (value !== undefined && value !== "" && key in next) {
      next[key] = value;
    }
  }

  return next as unknown as BridgeConfig;
}

/** 启动前校验，只报告无法自动修正的问题 */
export interface ConfigProblem {
  field: string;
  message: string;
}

export function validateConfig(config: BridgeConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  if (!config.appId) {
    problems.push({ field: "appId", message: "缺少 appId，无法连接飞书" });
  }
  if (!config.appSecret) {
    problems.push({ field: "appSecret", message: "缺少 appSecret，无法连接飞书" });
  }
  if (
    config.accessPolicy === "allowlist" &&
    config.allowedChatIds.length === 0 &&
    config.allowedOpenIds.length === 0
  ) {
    problems.push({
      field: "allowedOpenIds",
      message: "accessPolicy=allowlist 但白名单为空，所有消息都会被拒绝",
    });
  }

  return problems;
}

export function formatConfigProblems(problems: ConfigProblem[]): string {
  return problems.map((p) => `· ${p.field}: ${p.message}`).join("\n");
}