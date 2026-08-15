import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BridgeConfig } from "../config.js";
import { buildWorkspaceCard, makeWorkspaceCardPayload, verifyWorkspaceCardPayload } from "../cardkit/workspace.js";
import { DshSessionManager } from "./session-manager.js";
import { WorkspaceError, WorkspaceResolver } from "./workspace.js";

function config(root: string): BridgeConfig {
  return { appId: "app", appSecret: "secret", domain: "feishu", cwd: root, workspaces: [], defaultWorkspace: undefined, workspaceRoots: [root], registerBridgeTools: false, flushIntervalMs: 200, showThinking: false, printStrategy: "delay", printStep: 4, panelExpanded: false, streamingPanelExpanded: false, maxToolSteps: 20, maxThinkingRounds: 20, maxAnswerElementChars: 30000, maxReasoningChars: 3500, maxToolDetailChars: 500, maxToolOutputChars: 800, printFrequencyMs: 70, accessPolicy: "open", allowedChatIds: [], allowedOpenIds: [], requireMentionInGroup: false, clarifyTimeoutSec: 300, taskTimeoutSec: 900, sameChatBusyPolicy: "queue", sessionIdleTimeout: 1800000, maxQueue: 20, processingTimeoutMs: 120000, debug: false };
}

describe("V2 workspace registry", () => {
  it("忽略 registry 中越出 workspaceRoots 的篡改条目", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-v2-boundary-"));
    const outside = mkdtempSync(join(tmpdir(), "workspace-v2-outside-"));
    const registryPath = join(root, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ version: 1, workspaces: [{ id: "escape", path: outside }] }));
    const resolver = new WorkspaceResolver(config(root), join(root, "prefs.json"), undefined, registryPath);

    expect(resolver.list()).toEqual([{ id: "default", title: "默认工作区", path: root, status: "available" }]);
    expect(() => resolver.select("chat", "escape")).toThrow("未找到工作区");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("在 workspaceRoots 内增删改名并跨实例持久化", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-v2-"));
    const project = join(root, "project");
    mkdirSync(project);
    const registryPath = join(root, "registry.json");
    const prefsPath = join(root, "prefs.json");
    const resolver = new WorkspaceResolver(config(root), prefsPath, undefined, registryPath);

    expect(resolver.addRuntime("project", project, "Project")).toMatchObject({ id: "project", title: "Project", status: "available" });
    expect(new WorkspaceResolver(config(root), prefsPath, undefined, registryPath).list()).toHaveLength(1);
    expect(resolver.renameRuntime("project", "Renamed").title).toBe("Renamed");
    resolver.select("chat", "project");
    expect(() => resolver.removeRuntime("project")).toThrow("仍被 chat 使用");
    resolver.reset("chat");
    resolver.removeRuntime("project");
    expect(() => resolver.addRuntime("outside", tmpdir())).toThrow(WorkspaceError);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("workspace card payload", () => {
  it("验证 chat、签名和过期时间，篡改后拒绝", () => {
    const payload = makeWorkspaceCardPayload("secret", "chat-a", "use", { workspaceId: "project", mode: "keep-context" }, 1000);
    expect(verifyWorkspaceCardPayload("secret", payload as unknown as Record<string, unknown>, "chat-a", 1001)).toMatchObject({ action: "use", workspaceId: "project", mode: "keep-context" });
    expect(() => verifyWorkspaceCardPayload("secret", { ...payload, workspaceId: "other" }, "chat-a", 1001)).toThrow("签名无效");
    expect(() => verifyWorkspaceCardPayload("secret", payload as unknown as Record<string, unknown>, "chat-b", 1001)).toThrow("不属于当前 chat");
    expect(() => verifyWorkspaceCardPayload("secret", payload as unknown as Record<string, unknown>, "chat-a", 700001001)).toThrow("已过期");
  });
});

describe("workspace card structure", () => {
  it("为每个按钮生成唯一 name", () => {
    const card: any = buildWorkspaceCard("secret", "chat", { id: "first", title: "First", path: "C:/first", status: "available", source: "default" }, [
      { id: "first", title: "First", path: "C:/first", status: "available" },
      { id: "second", title: "Second", path: "C:/second", status: "available" },
    ], 1000);
    const names = card.body.elements.filter((element: any) => element.tag === "button").map((element: any) => element.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("V2 keep-context", () => {
  it("fork 后在新工作区创建 child session 并保留上下文", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-keep-context-"));
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const cfg = { ...config(root), workspaces: [{ id: "first", path: first }, { id: "second", path: second }], defaultWorkspace: "first" };
    const oldAgent = { status: "idle", session: { events: [{ type: "user/message", data: {} }] }, cancel: vi.fn(), followup: vi.fn(), whenIdle: vi.fn() };
    const newAgent = { status: "idle", session: { events: [] }, cancel: vi.fn(), followup: vi.fn(), whenIdle: vi.fn() };
    const create = vi.fn(async (options: any) => ({ agent: options.seed ? newAgent : oldAgent, dispose: vi.fn(async () => {}) }));
    const ctx: any = { get: (key: string) => key === "sessions" ? { fork: () => ({ events: [{ type: "user/message", data: {} }] }) } : undefined };
    const manager = new DshSessionManager(ctx, { get: () => undefined, resume: async () => { throw new Error("missing"); }, create }, cfg, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, () => {}, join(root, "preset.json"), join(root, "prefs.json"), join(root, "owners.json"), join(root, "registry.json"));
    await manager.ensureAgent("chat");
    const result = await manager.switchWorkspace("chat", "second", "keep-context");
    expect(result.preservedContext).toBe(true);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ seed: expect.any(Array), meta: expect.objectContaining({ cwd: second }) }));
    expect(manager.getEffectiveWorkspace("chat").id).toBe("second");
    rmSync(root, { recursive: true, force: true });
  });
});
