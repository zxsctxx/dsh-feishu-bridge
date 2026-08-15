/**
 * config 适配测试：FEISHU_* 环境变量叠加 + 启动校验。
 */
import { describe, expect, it } from "vitest";
import { applyEnvOverrides, validateConfig, type BridgeConfig } from "./config.js";

function baseConfig(): BridgeConfig {
  return {
    appId: "",
    appSecret: "",
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

describe("applyEnvOverrides", () => {
  it("环境变量覆盖同名配置项", () => {
    const config = applyEnvOverrides(baseConfig(), {
      FEISHU_APP_ID: "cli_appid",
      FEISHU_APP_SECRET: "cli_secret",
      FEISHU_DOMAIN: "lark",
      FEISHU_SHOW_THINKING: "true",
      FEISHU_MAX_TOOL_STEPS: "42",
      FEISHU_ALLOWED_CHAT_IDS: "oc_a,oc_b",
    });
    expect(config.appId).toBe("cli_appid");
    expect(config.appSecret).toBe("cli_secret");
    expect(config.domain).toBe("lark");
    expect(config.showThinking).toBe(true);
    expect(config.maxToolSteps).toBe(42);
    expect(config.allowedChatIds).toEqual(["oc_a", "oc_b"]);
  });

  it("未设置的环境变量不覆盖配置", () => {
    const config = applyEnvOverrides(baseConfig(), {});
    expect(config.appId).toBe("");
    expect(config.domain).toBe("feishu");
    expect(config.maxToolSteps).toBe(20);
  });

  it("非法数值/布尔回落到原配置", () => {
    const config = applyEnvOverrides(baseConfig(), {
      FEISHU_MAX_TOOL_STEPS: "abc",
      FEISHU_SHOW_THINKING: "not-a-bool",
      FEISHU_ALLOWED_OPEN_IDS: "",
    });
    expect(config.maxToolSteps).toBe(20);
    expect(config.showThinking).toBe(false);
    expect(config.allowedOpenIds).toEqual([]);
  });

  it("布尔值兼容 1/true/yes", () => {
    const config = applyEnvOverrides(baseConfig(), {
      FEISHU_REQUIRE_MENTION_IN_GROUP: "1",
      FEISHU_PANEL_EXPANDED: "yes",
    });
    expect(config.requireMentionInGroup).toBe(true);
    expect(config.panelExpanded).toBe(true);
  });
});

describe("validateConfig", () => {
  it("缺少凭据时报错", () => {
    const problems = validateConfig({ ...baseConfig(), accessPolicy: "open" });
    expect(problems.map((p) => p.field)).toEqual(["appId", "appSecret"]);
  });

  it("allowlist 空名单告警", () => {
    const cfg = { ...baseConfig(), appId: "x", appSecret: "y" };
    const problems = validateConfig(cfg);
    expect(problems.some((p) => p.field === "allowedOpenIds")).toBe(true);
  });

  it("open 策略不告警", () => {
    const cfg = { ...baseConfig(), appId: "x", appSecret: "y", accessPolicy: "open" as const };
    expect(validateConfig(cfg)).toEqual([]);
  });
});