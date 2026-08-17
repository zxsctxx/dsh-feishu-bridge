import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BridgeConfig } from "../config.js";
import type { WorkspaceBackend } from "./workspace-backend.js";
import { WorkspaceError } from "./workspace.js";
import { HostWorkspaceResolver } from "./workspace-host.js";

function baseConfig(root: string, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    appId: "app",
    appSecret: "secret",
    domain: "feishu",
    defaultWorkspace: "Workspace",
    workspaceRoots: [root],
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
    accessPolicy: "open",
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
    ...overrides,
  };
}

function makeBackend(rows: Array<{ id: string; title: string; path: string; status?: "available" | "missing" }>): WorkspaceBackend {
  return {
    mode: "host",
    list: async () => rows.map((row) => ({ ...row, status: row.status ?? "available" })),
    get: async (id: string) => rows.find((row) => row.id === id),
    resolveByPath: async (path: string) => rows.find((row) => row.path === path),
    create: async (path: string, title?: string) => ({ id: "created", title: title ?? "created", path, status: "available" as const }),
    delete: async () => true,
    rename: async (id: string, title: string) => {
      const row = rows.find((item) => item.id === id);
      if (!row) throw new Error("not found");
      return { ...row, title };
    },
    attachSession: async () => {},
  };
}

describe("HostWorkspaceResolver（V3-only）", () => {
  it("支持用工作区标题解析 defaultWorkspace / registeredWorkspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-title-"));
    const backend = makeBackend([
      { id: "host-1", title: "Workspace", path: join(root, "workspace") },
      { id: "host-2", title: "external", path: join(root, "external") },
    ]);
    const resolver = new HostWorkspaceResolver(baseConfig(root), backend, join(root, "prefs.json"));

    await expect(resolver.getEffective("chat")).resolves.toMatchObject({ id: "host-1", title: "Workspace", source: "default" });
    await expect(resolver.registeredWorkspace("external")).resolves.toMatchObject({ id: "host-2", title: "external" });
    rmSync(root, { recursive: true, force: true });
  });

  it("未配置 defaultWorkspace 时回退到第一个宿主工作区", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-fallback-"));
    const backend = makeBackend([
      { id: "host-1", title: "Workspace", path: join(root, "workspace") },
      { id: "host-2", title: "external", path: join(root, "external") },
    ]);
    const resolver = new HostWorkspaceResolver(baseConfig(root, { defaultWorkspace: undefined }), backend, join(root, "prefs.json"));

    await expect(resolver.getEffective("chat")).resolves.toMatchObject({ id: "host-1", title: "Workspace" });
    rmSync(root, { recursive: true, force: true });
  });

  it("addRuntime 受 workspaceRoots 约束，并复用已存在的宿主路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-roots-"));
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    const backend = makeBackend([
      { id: "host-1", title: "allowed", path: allowed },
    ]);
    const resolver = new HostWorkspaceResolver(baseConfig(root, { workspaceRoots: [allowed] }), backend, join(root, "prefs.json"));

    await expect(resolver.addRuntime("dup", allowed)).resolves.toMatchObject({ id: "host-1" });
    await expect(resolver.addRuntime("outside", outside)).rejects.toThrow("workspaceRoots");
    rmSync(root, { recursive: true, force: true });
  });

  it("removeRuntime 拒绝删除仍被 chat 使用的工作区", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-remove-"));
    const backend = makeBackend([
      { id: "host-1", title: "Workspace", path: join(root, "workspace") },
    ]);
    const resolver = new HostWorkspaceResolver(baseConfig(root), backend, join(root, "prefs.json"));
    await resolver.select("chat", "host-1");

    await expect(resolver.removeRuntime("host-1")).rejects.toThrow(WorkspaceError);
    rmSync(root, { recursive: true, force: true });
  });

  it("陈旧 chat 选择会被清理并回退默认工作区", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-stale-"));
    const backend = makeBackend([
      { id: "host-1", title: "Workspace", path: join(root, "workspace") },
    ]);
    const warn = vi.fn();
    const resolver = new HostWorkspaceResolver(baseConfig(root), backend, join(root, "prefs.json"), warn);
    await resolver.select("chat", "host-1");
    // 模拟宿主工作区被删除后，选择已失效。
    const emptyBackend = makeBackend([]);
    const resolver2 = new HostWorkspaceResolver(baseConfig(root), emptyBackend, join(root, "prefs.json"), warn);
    await expect(resolver2.getEffective("chat")).rejects.toThrow("宿主没有可用工作区");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleared stale workspace preference"));
    rmSync(root, { recursive: true, force: true });
  });
});
