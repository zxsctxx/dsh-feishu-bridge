/**
 * DshSessionManager 预设解析测试：currentPreset 优先级与来源标注。
 * 通过 presetPrefsPath 注入临时文件，隔离用户真实偏好。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshSessionManager } from "./session-manager.js";
import type { BridgeConfig } from "../config.js";

function baseConfig(): BridgeConfig {
  return {
    appId: "cli_app",
    appSecret: "secret",
    domain: "feishu",
    cwd: process.cwd(),
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

function makeManager(configOverrides: Partial<BridgeConfig> = {}) {
  const config = { ...baseConfig(), ...configOverrides };
  const dir = mkdtempSync(join(tmpdir(), "session-manager-preset-"));
  const presetPrefsPath = join(dir, "preset-prefs.json");
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
  const ctx: any = { agentPresets: presets, get: () => undefined };
  const agents: any = {
    get: () => undefined,
    resume: async () => { throw new Error("no persistence in test"); },
    create: async () => { throw new Error("create not expected"); },
  };
  const logger: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const manager = new DshSessionManager(ctx, agents, config, logger, () => {}, presetPrefsPath);
  return { manager, dir, config };
}

describe("DshSessionManager 预设解析", () => {
  it("config.preset 未设时回落宿主默认（source=host）", () => {
    const { manager, dir } = makeManager();
    const current = manager.currentPreset("oc_a");
    expect(current).toEqual({ presetId: "minimal", source: "host" });
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