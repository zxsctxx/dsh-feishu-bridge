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
  it("忽略 registry 中越出 workspaceRoots 的篡改条目", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-v2-boundary-"));
    const outside = mkdtempSync(join(tmpdir(), "workspace-v2-outside-"));
    const registryPath = join(root, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ version: 1, workspaces: [{ id: "escape", path: outside }] }));
    const resolver = new WorkspaceResolver(config(root), join(root, "prefs.json"), undefined, registryPath);

    await expect(resolver.list()).resolves.toEqual([{ id: "default", title: "默认工作区", path: root, status: "available" }]);
    await expect(resolver.select("chat", "escape")).rejects.toThrow("未找到工作区");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("在 workspaceRoots 内增删改名并跨实例持久化", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-v2-"));
    const project = join(root, "project");
    mkdirSync(project);
    const registryPath = join(root, "registry.json");
    const prefsPath = join(root, "prefs.json");
    const resolver = new WorkspaceResolver(config(root), prefsPath, undefined, registryPath);

    await expect(resolver.addRuntime("project", project, "Project")).resolves.toMatchObject({ id: "project", title: "Project", status: "available" });
    await expect(new WorkspaceResolver(config(root), prefsPath, undefined, registryPath).list()).resolves.toHaveLength(1);
    await expect(resolver.renameRuntime("project", "Renamed")).resolves.toMatchObject({ title: "Renamed" });
    await resolver.select("chat", "project");
    await expect(resolver.removeRuntime("project")).rejects.toThrow("仍被 chat 使用");
    await resolver.reset("chat");
    await resolver.removeRuntime("project");
    await expect(resolver.addRuntime("outside", tmpdir())).rejects.toThrow(WorkspaceError);

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
    const select = makeWorkspaceCardPayload("secret", "chat-a", "select", { mode: "reset" }, 1000);
    expect(verifyWorkspaceCardPayload("secret", select as unknown as Record<string, unknown>, "chat-a", 1001)).toMatchObject({ action: "select", mode: "reset" });
  });
});

describe("workspace card structure", () => {
  it("使用澄清卡片式下拉选择，避免为每个工作区重复渲染路径和按钮", () => {
    const card: any = buildWorkspaceCard("secret", "chat", { id: "first", title: "First", path: "C:/first", status: "available", source: "default" }, [
      { id: "first", title: "First", path: "C:/first", status: "available" },
      { id: "second", title: "Second", path: "C:/second", status: "available" },
    ], 1000);
    const select = card.body.elements.find((element: any) => element.tag === "select_static");
    expect(select).toMatchObject({
      element_id: "workspace-select",
      placeholder: { tag: "plain_text", content: "选择工作区…" },
      value: { kind: "workspace", action: "select", chatId: "chat", mode: "reset" },
    });
    expect(select.options).toEqual([
      { value: "__workspace_reset__", text: { tag: "plain_text", content: "A. 恢复默认工作区" } },
      { value: "first", text: { tag: "plain_text", content: "B. First" } },
      { value: "second", text: { tag: "plain_text", content: "C. Second" } },
    ]);
    const markdown = card.body.elements.filter((element: any) => element.tag === "markdown");
    expect(markdown[0]).toMatchObject({ content: "请选择工作区，当前工作区：First" });
    expect(markdown[1]).toMatchObject({ content: "当前路径：C:/first" });
    expect(markdown[2]).toMatchObject({ content: "切换工作区默认会重置上下文，可通过 `/workspace use <id> --keep-context` 保留上下文切换" });
    expect(markdown[3]).toMatchObject({ content: "**A. 恢复默认工作区** · 使用配置中的默认工作区" });
    expect(markdown.map((element: any) => element.content.join?.() ?? element.content).join("\n")).not.toContain("C:/second");
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
    await expect(manager.getEffectiveWorkspace("chat")).resolves.toMatchObject({ id: "second" });
    rmSync(root, { recursive: true, force: true });
  });
});
