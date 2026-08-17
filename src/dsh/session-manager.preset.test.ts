/**
 * DshSessionManager 预设解析测试：currentPreset 优先级与来源标注。
 * 通过 presetPrefsPath 注入临时文件，隔离用户真实偏好。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshSessionManager } from "./session-manager.js";
import type { BridgeConfig } from "../config.js";
import type { WorkspaceBackend } from "./workspace-backend.js";
import { formatResumeList } from "../commands/session.js";

function baseConfig(): BridgeConfig {
  return {
    appId: "cli_app",
    appSecret: "secret",
    domain: "feishu",
    registerBridgeTools: true,
    flushIntervalMs: 200,
    showThinking: false,
    printStrategy: "delay",
    printStep: 4,
    panelExpanded: false,
    streamingPanelExpanded: false,
    maxToolSteps: 20,
    maxThinkingRounds: 20,
    maxAnswerElementChars: 30000,
    maxReasoningChars: 3500,
    maxToolDetailChars: 500,
    maxToolOutputChars: 800,
    printFrequencyMs: 70,
    accessPolicy: "allowlist",
    allowedChatIds: [],
    allowedOpenIds: [],
    requireMentionInGroup: false,
    clarifyTimeoutSec: 300,
    taskTimeoutSec: 900,
    sameChatBusyPolicy: "queue",
    sessionIdleTimeout: 1800000,
    maxQueue: 20,
    processingTimeoutMs: 120000,
    debug: false,
  };
}

function makeHostBackend(path = "/workspace"): WorkspaceBackend {
  const row = { id: "host-default", title: "Default", path, status: "available" as const };
  return {
    mode: "host",
    list: async () => [row],
    get: async (id: string) => (id === row.id ? row : undefined),
    resolveByPath: async () => undefined,
    create: async () => row,
    delete: async () => true,
    rename: async () => row,
    attachSession: async () => {},
  };
}

function makeManager(
  configOverrides: Partial<BridgeConfig> = {},
  agentsOverrides: Record<string, unknown> = {},
  ctxGet?: (key: string) => unknown,
  workspaceBackend: WorkspaceBackend = makeHostBackend(),
) {
  const config = { ...baseConfig(), ...configOverrides };
  const dir = mkdtempSync(join(tmpdir(), "session-manager-preset-"));
  const presetPrefsPath = join(dir, "preset-prefs.json");
  const workspacePrefsPath = join(dir, "workspace-prefs.json");
  const sessionOwnersPath = join(dir, "session-owners.json");
  const presets: any = {
    defaultId: "minimal",
    list: async () => [
      { id: "code", name: "Code" },
      { id: "minimal", name: "Minimal" },
      { id: "standard" },
    ],
    resolve: async (id?: string) => {
      const known = ["code", "minimal", "standard"];
      if (id !== undefined && !known.includes(id)) {
        throw Object.assign(new Error(`unknown preset: ${id}`), {
          presetId: id,
          available: known,
        });
      }
      return { id: id ?? "minimal" };
    },
    mount: async () => {},
  };
  const ctx: any = { agentPresets: presets, get: (key: string) => (ctxGet ? ctxGet(key) : undefined) };
  const agents: any = {
    get: () => undefined,
    resume: async () => { throw new Error("no persistence in test"); },
    create: async () => { throw new Error("create not expected"); },
    ...agentsOverrides,
  };
  const logger: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const manager = new DshSessionManager(ctx, agents, config, logger, () => {}, workspaceBackend, presetPrefsPath, workspacePrefsPath, sessionOwnersPath);
  return { manager, dir, config };
}

/** 最小可用的 fake agent（ensureAgent resume 成功路径用） */
function fakeAgent() {
  return { status: "idle", session: { events: [] }, cancel: vi.fn(), followup: vi.fn(), whenIdle: vi.fn() };
}

describe("DshSessionManager 预设解析", () => {
  it("config.preset 未设时不自动跟随宿主默认（source=host，presetId undefined）", () => {
    const { manager, dir } = makeManager();
    const current = manager.currentPreset("oc_a");
    expect(current).toEqual({ presetId: undefined, source: "host" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("config.preset 显式指定 → source=config", () => {
    const { manager, dir } = makeManager({ preset: "code" });
    expect(manager.currentPreset("oc_a")).toEqual({ presetId: "code", source: "config" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("per-chat 偏好优先于 config.preset（source=per-chat）", () => {
    const { manager, dir } = makeManager({ preset: "code" });
    manager.setChatPreset("oc_a", "standard");
    expect(manager.currentPreset("oc_a")).toEqual({ presetId: "standard", source: "per-chat" });
    // 其他 chat 不受 per-chat 偏好影响
    expect(manager.currentPreset("oc_b")).toEqual({ presetId: "code", source: "config" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("全局默认高于 config.preset、低于 per-chat", () => {
    const { manager, dir } = makeManager({ preset: "code" });
    manager.setDefaultPreset("minimal");
    expect(manager.currentPreset("oc_a")).toEqual({ presetId: "minimal", source: "global" });
    manager.setChatPreset("oc_a", "standard");
    expect(manager.currentPreset("oc_a")).toEqual({ presetId: "standard", source: "per-chat" });
    // 无 per-chat 偏好时全局默认优先于 config
    expect(manager.currentPreset("oc_b")).toEqual({ presetId: "minimal", source: "global" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("listAvailablePresets 返回规范化行（name 缺省回退 id）", async () => {
    const { manager, dir } = makeManager();
    const rows = await manager.listAvailablePresets();
    expect(rows).toEqual([
      { id: "code", name: "Code" },
      { id: "minimal", name: "Minimal" },
      { id: "standard" },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolvePresetId：存在返回 id，不存在返回 undefined", async () => {
    const { manager, dir } = makeManager();
    expect(await manager.resolvePresetId("code")).toBe("code");
    expect(await manager.resolvePresetId("nope")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("switchPreset 无活跃会话：仅保存偏好", async () => {
    const { manager, dir } = makeManager();
    const result = await manager.switchPreset("oc_a", "code");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("下次消息");
    expect(manager.getChatPresetPref("oc_a")).toBe("code");
    rmSync(dir, { recursive: true, force: true });
  });

  it("switchPreset 未知预设：报错且不保存", async () => {
    const { manager, dir } = makeManager();
    const result = await manager.switchPreset("oc_a", "ghost");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ghost");
    expect(result.message).toContain("code");
    expect(manager.getChatPresetPref("oc_a")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ensureAgent resume 分支补齐 agentOptions（回归：重启后 resume 不再报 persona {{model}} 无值）", () => {
  it("无显式切换时用宿主有效路由填充 agentOptions", async () => {
    const resume = vi.fn().mockResolvedValue({ agent: fakeAgent(), dispose: vi.fn() });
    const { manager, dir } = makeManager({ provider: "p", model: "m" }, { resume });
    const record = await manager.ensureAgent("oc_a");
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: expect.any(String),
      agentOptions: { provider: "p", model: "m" },
    }));
    expect(record.agentPreset).toBeUndefined(); // 未显式指定预设 → 不挂载
    rmSync(dir, { recursive: true, force: true });
  });

  it("config 未配置模型时也走 resume（agentOptions 为空则原样传给 resume）", async () => {
    const resume = vi.fn().mockResolvedValue({ agent: fakeAgent(), dispose: vi.fn() });
    const { manager, dir } = makeManager({}, { resume });
    await manager.ensureAgent("oc_a");
    // 本机 settings.yaml 是否存在都会走到 resume（而非直接抛错）；
    // 断言 resume 被调用且 resumeSessionId 正确
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: expect.any(String) }));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("getStatus（/status 数据源）", () => {
  function agentWithEvents(events: unknown[]) {
    return {
      status: "idle",
      session: { events },
      cancel: vi.fn(),
      followup: vi.fn(),
      whenIdle: vi.fn(),
    };
  }

  it("取最近一次 request/header 的实际路由与思考强度", async () => {
    const agent = agentWithEvents([
      { type: "user/message", data: {} },
      {
        type: "request/header",
        data: { header: { config: { provider: "opencode", model: "deepseek-v4-flash", reasoningEffort: "low" } } },
      },
      {
        type: "request/header",
        data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "max" } } },
      },
    ]);
    const { manager, dir } = makeManager({}, { get: () => agent });
    await manager.ensureAgent("oc_a");
    const status = await manager.getStatus("oc_a");
    expect(status.provider).toBe("deepseek-official");
    expect(status.model).toBe("deepseek-v4-flash");
    expect(status.reasoningEffort).toBe("max");
    rmSync(dir, { recursive: true, force: true });
  });

  it("无 request/header 事件时回退有效路由且无思考强度", async () => {
    const agent = agentWithEvents([{ type: "user/message", data: {} }]);
    const { manager, dir } = makeManager({ provider: "p", model: "m" }, { get: () => agent });
    await manager.ensureAgent("oc_a");
    const status = await manager.getStatus("oc_a");
    expect(status.provider).toBe("p");
    expect(status.model).toBe("m");
    expect(status.reasoningEffort).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("无活跃会话时仍显示派生 sessionId、偏好预设与有效工作区（重启后直接 /status）", async () => {
    const { manager, dir } = makeManager();
    manager.setChatPreset("oc_a", "code");
    const status = await manager.getStatus("oc_a");
    expect(status.active).toBe(false);
    expect(status.sessionId).toBe(manager.sessionIdFor("oc_a"));
    expect(status.preset).toBe("code");
    expect(status.cwd).toBe("/workspace");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("getLatestRequestStats（footer 上下文 billed 口径）", () => {
  it("取最近一次请求的 billed 输入（uncached + 缓存读/写）", async () => {
    const agent = {
      status: "idle",
      session: {
        events: [
          { type: "assistant/message", data: { usage: { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 50 } } },
          { type: "assistant/message", data: { usage: { inputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 100 } } },
        ],
      },
      cancel: vi.fn(),
      followup: vi.fn(),
      whenIdle: vi.fn(),
    };
    const { manager, dir } = makeManager({}, { get: () => agent });
    await manager.ensureAgent("oc_a");
    expect(manager.getLatestRequestStats("oc_a").inputTokens).toBe(700); // 200 + 400 + 100
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("listPersistedSessions Workspace DTO 映射（V3c）", () => {
  /** 构造 sessionPersistence fake；headers 可在 manager 构造后按需更新 */
  function persistenceCtx(headers: Array<{ id: string; cwd?: string }>) {
    return (key: string) =>
      key === "sessionPersistence" ? { list: async () => headers } : undefined;
  }

  it("宿主工作区无 membership 时不填充 workspace 字段，保持纯 id 列表", async () => {
    const headers: Array<{ id: string; cwd?: string }> = [];
    const { manager, dir } = makeManager({}, {}, persistenceCtx(headers));
    const ownedId = manager.sessionIdFor("oc_a"); // 确定性派生 id，等于 chat 归属
    headers.push({ id: ownedId, cwd: "/work" });

    const rows = await manager.listPersistedSessions("oc_a");
    expect(rows).toEqual([{ id: ownedId }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("host 模式按 workspaces.list().sessionIds 映射归属", async () => {
    const headers: Array<{ id: string; cwd?: string }> = [];
    const memberships: string[] = ["placeholder"];
    const backend = {
      mode: "host",
      list: async () => [
        { id: "w1", title: "Alpha", path: "/alpha", status: "available" as const, sessionIds: memberships },
        { id: "w2", title: "Beta", path: "/beta", status: "available" as const, sessionIds: [] },
      ],
      get: async () => undefined,
      resolveByPath: async () => undefined,
      create: async () => { throw new Error("unused"); },
      delete: async () => false,
      rename: async () => { throw new Error("unused"); },
    } as unknown as WorkspaceBackend;
    const { manager, dir } = makeManager({}, {}, persistenceCtx(headers), backend);
    const ownedId = manager.sessionIdFor("oc_a");
    memberships.length = 0;
    memberships.push(ownedId);
    headers.push({ id: ownedId, cwd: "/alpha" });

    const rows = await manager.listPersistedSessions("oc_a");
    expect(rows).toEqual([
      { id: ownedId, workspaceId: "w1", workspaceTitle: "Alpha", workspacePath: "/alpha" },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("无 membership 的会话保持未分组（不携带 workspace 字段）", async () => {
    const headers: Array<{ id: string; cwd?: string }> = [];
    const backend = {
      mode: "host",
      list: async () => [
        { id: "w1", title: "Alpha", path: "/alpha", status: "available" as const, sessionIds: ["other-1"] },
      ],
      get: async () => undefined,
      resolveByPath: async () => undefined,
      create: async () => { throw new Error("unused"); },
      delete: async () => false,
      rename: async () => { throw new Error("unused"); },
    } as unknown as WorkspaceBackend;
    const { manager, dir } = makeManager({}, {}, persistenceCtx(headers), backend);
    const ownedId = manager.sessionIdFor("oc_a");
    headers.push({ id: ownedId, cwd: "/elsewhere" });

    const rows = await manager.listPersistedSessions("oc_a");
    expect(rows).toEqual([{ id: ownedId }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("host workspace 查询失败时降级为未分组列表，不丢失会话", async () => {
    const headers: Array<{ id: string; cwd?: string }> = [];
    const backend = {
      mode: "host",
      list: async () => { throw new Error("host storage error"); },
      get: async () => undefined,
      resolveByPath: async () => undefined,
      create: async () => { throw new Error("unused"); },
      delete: async () => false,
      rename: async () => { throw new Error("unused"); },
    } as unknown as WorkspaceBackend;
    const { manager, dir } = makeManager({}, {}, persistenceCtx(headers), backend);
    const ownedId = manager.sessionIdFor("oc_a");
    headers.push({ id: ownedId, cwd: "/work" });

    const rows = await manager.listPersistedSessions("oc_a");
    expect(rows).toEqual([{ id: ownedId }]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("formatResumeList（V3c 分组渲染）", () => {
  it("无 workspace 字段时保持原扁平格式，序号连续", () => {
    const text = formatResumeList([{ id: "a" }, { id: "b" }], "b");
    expect(text).toContain("共 2 个");
    expect(text).toContain("1. a");
    expect(text).toContain("2. b ← 当前");
    expect(text).not.toContain("未分组");
  });

  it("host DTO 有归属时按工作区分组，未归属显示未分组，序号仍对应扁平列表", () => {
    const sessions = [
      { id: "s1", workspaceId: "w1", workspaceTitle: "Alpha", workspacePath: "/alpha" },
      { id: "s2" }, // 未分组
      { id: "s3", workspaceId: "w1", workspaceTitle: "Alpha", workspacePath: "/alpha" },
    ];
    const text = formatResumeList(sessions, "s1");
    expect(text).toContain("按工作区分组");
    expect(text).toContain("工作区: Alpha");
    expect(text).toContain("/alpha");
    expect(text).toContain("未分组");
    // 序号仍对应扁平顺序
    expect(text).toContain("1. s1 ← 当前");
    expect(text).toContain("2. s2");
    expect(text).toContain("3. s3");
  });
});