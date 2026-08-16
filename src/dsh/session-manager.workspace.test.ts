/**
 * DshSessionManager V3c session attach 回归测试。
 * 通过 fake host WorkspaceBackend 验证 ensureAgent 的 create 路径：
 *   1) 创建的 session 会 attach 到当前宿主 Workspace；
 *   2) attach 失败时新 handle 被 dispose，且不建立 active record。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "../config.js";
import { DshSessionManager } from "./session-manager.js";
import type { WorkspaceBackend } from "./workspace-backend.js";

function baseConfig(root: string): BridgeConfig {
  return {
    appId: "cli_test",
    appSecret: "secret",
    domain: "feishu",
    cwd: root,
    workspaces: [],
    defaultWorkspace: "host-1",
    workspaceRoots: [root],
    workspaceBackend: "host",
    workspaceMigration: "disabled",
    registerBridgeTools: false,
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

function fakeAgent() {
  return { status: "idle", session: { events: [] }, cancel: vi.fn(), followup: vi.fn(), whenIdle: vi.fn() };
}

/** 构造 fake host backend：getEffective 解析到 host-1，attachSession 可注入具体行为。 */
function makeHostBackend(path: string, attachImpl?: () => Promise<void>) {
  const attachSession = vi.fn(attachImpl ?? (async () => {}));
  const hostWorkspace = { id: "host-1", title: "Host 1", path, status: "available" as const };
  const backend: WorkspaceBackend = {
    mode: "host",
    list: async () => [hostWorkspace],
    get: async (id: string) => (id === "host-1" ? hostWorkspace : undefined),
    resolveByPath: async () => undefined,
    create: async () => hostWorkspace,
    delete: async () => true,
    rename: async () => hostWorkspace,
    attachSession,
  };
  return { backend, attachSession };
}

function makeManager(backend: WorkspaceBackend, agentsOverrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "session-manager-workspace-"));
  const config = baseConfig(root);
  const presetPrefsPath = join(root, "preset-prefs.json");
  const workspacePrefsPath = join(root, "workspace-prefs.json");
  const sessionOwnersPath = join(root, "session-owners.json");
  const workspaceRegistryPath = join(root, "workspace-registry.json");
  const workspaceMigrationPath = join(root, "workspace-host-migration.json");
  const ctx: any = { get: () => undefined };
  const agents: any = {
    get: () => undefined,
    resume: async () => { throw new Error("no persistence in test"); },
    create: async () => { throw new Error("create not expected"); },
    ...agentsOverrides,
  };
  const logger: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const manager = new DshSessionManager(
    ctx,
    agents,
    config,
    logger,
    () => {},
    presetPrefsPath,
    workspacePrefsPath,
    sessionOwnersPath,
    workspaceRegistryPath,
    backend,
    workspaceMigrationPath,
  );
  return { manager, dir: root };
}

describe("DshSessionManager V3c session attach（host 模式）", () => {
  it("ensureAgent create 路径将新 session attach 到宿主 Workspace 并建立 active record", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-manager-workspace-attach-"));
    const { backend, attachSession } = makeHostBackend(root);
    const create = vi.fn(async () => ({ agent: fakeAgent(), dispose: vi.fn(async () => {}) }));
    const { manager, dir } = makeManager(backend, { create });

    const record = await manager.ensureAgent("oc_a");

    expect(create).toHaveBeenCalledTimes(1);
    expect(attachSession).toHaveBeenCalledWith("host-1", manager.sessionIdFor("oc_a"));
    expect(manager.recordFor("oc_a")).toBe(record);
    expect(record.sessionId).toBe(manager.sessionIdFor("oc_a"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("attachSession 失败时 dispose 新 handle 且不建立 active record", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-manager-workspace-attach-fail-"));
    const { backend, attachSession } = makeHostBackend(root, async () => {
      throw new Error("header cwd mismatch");
    });
    const dispose = vi.fn(async () => {});
    const create = vi.fn(async () => ({ agent: fakeAgent(), dispose }));
    const { manager, dir } = makeManager(backend, { create });

    await expect(manager.ensureAgent("oc_a")).rejects.toThrow("未能归属当前工作区");

    expect(attachSession).toHaveBeenCalledWith("host-1", manager.sessionIdFor("oc_a"));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.recordFor("oc_a")).toBeNull();
    expect(manager.isOwnedSession(manager.sessionIdFor("oc_a"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resume 目标恢复失败时保留旧 active record 且不 dispose 旧 handle", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-manager-workspace-resume-fail-"));
    const { backend } = makeHostBackend(root);
    const dispose = vi.fn(async () => {});
    const resume = vi.fn(async () => {
      throw new Error("resume failed");
    });
    const create = vi.fn(async () => ({ agent: fakeAgent(), dispose }));
    const { manager, dir } = makeManager(backend, { resume, create });

    // 旧 record 经 ensureAgent 的 create 路径建立（resume 抛错 → create 兜底），
    // 此时 handle.dispose 是可观测的 vi.fn。
    const oldRecord = await manager.ensureAgent("oc_a");
    expect(manager.recordFor("oc_a")).toBe(oldRecord);

    // 目标 session 恢复再次失败：resumeSession 必须原子失败，
    // 不清除旧 active record，也不释放旧 handle。
    const ok = await manager.resumeSession("oc_a", manager.sessionIdFor("oc_a"));
    expect(ok).toBe(false);
    expect(manager.recordFor("oc_a")).toBe(oldRecord);
    expect(dispose).toHaveBeenCalledTimes(0);
    expect(resume).toHaveBeenCalledTimes(2); // ensureAgent + resumeSession 各一次
    rmSync(dir, { recursive: true, force: true });
  });
});