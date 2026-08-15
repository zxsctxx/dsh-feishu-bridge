import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BridgeConfig } from "../config.js";
import { SessionOwnershipStore } from "./session-owners.js";
import { WorkspaceError, WorkspaceResolver } from "./workspace.js";

function config(root: string): BridgeConfig {
  return {
    appId: "cli_test",
    appSecret: "secret",
    domain: "feishu",
    cwd: root,
    workspaces: [
      { id: "alpha", title: "Alpha", path: join(root, "alpha") },
      { id: "beta", title: "Beta", path: join(root, "beta") },
    ],
    defaultWorkspace: "alpha",
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

describe("WorkspaceResolver", () => {
  it("按 default、chat selection、reset 解析工作区并跨实例持久化", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-resolver-"));
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "beta"));
    const prefsPath = join(root, "workspace-prefs.json");
    const resolver = new WorkspaceResolver(config(root), prefsPath);

    expect(resolver.getEffective("chat-a")).toMatchObject({ id: "alpha", title: "Alpha", source: "default" });
    resolver.select("chat-a", "beta");
    expect(resolver.getEffective("chat-a")).toMatchObject({ id: "beta", title: "Beta", source: "chat" });
    expect(resolver.getEffective("chat-b")).toMatchObject({ id: "alpha", source: "default" });

    const restored = new WorkspaceResolver(config(root), prefsPath);
    expect(restored.getEffective("chat-a")).toMatchObject({ id: "beta", path: join(root, "beta"), source: "chat" });
    restored.reset("chat-a");
    expect(restored.getEffective("chat-a")).toMatchObject({ id: "alpha", source: "default" });

    rmSync(root, { recursive: true, force: true });
  });

  it("陈旧 chat 选择会清理并回退默认工作区", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-resolver-"));
    mkdirSync(join(root, "alpha"));
    const prefsPath = join(root, "workspace-prefs.json");
    writeFileSync(prefsPath, JSON.stringify({ version: 1, selections: { "cli_test:chat-a": "removed" } }));
    const resolver = new WorkspaceResolver(config(root), prefsPath);

    expect(resolver.getEffective("chat-a")).toMatchObject({ id: "alpha", source: "default" });
    rmSync(root, { recursive: true, force: true });
  });

  it("拒绝未知或不可用工作区，列表保留目录状态", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-resolver-"));
    const cfg = config(root);
    cfg.workspaces = [{ id: "missing", path: join(root, "missing") }];
    const resolver = new WorkspaceResolver(cfg, join(root, "prefs.json"));

    expect(resolver.list()).toEqual([{ id: "missing", title: "missing", path: join(root, "missing"), status: "missing" }]);
    expect(() => resolver.select("chat-a", "unknown")).toThrow(WorkspaceError);
    expect(() => resolver.select("chat-a", "missing")).toThrow("工作区目录不可用");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("SessionOwnershipStore", () => {
  it("按 chat 隔离 session 归属并跨实例持久化", () => {
    const root = mkdtempSync(join(tmpdir(), "session-owners-"));
    const path = join(root, "owners.json");
    const store = new SessionOwnershipStore(path);
    store.add("app:chat-a", "session-a");

    expect(store.has("app:chat-a", "session-a")).toBe(true);
    expect(store.has("app:chat-b", "session-a")).toBe(false);
    expect(new SessionOwnershipStore(path).has("app:chat-a", "session-a")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
