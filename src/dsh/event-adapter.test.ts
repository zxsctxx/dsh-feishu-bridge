/**
 * event-adapter 核心映射测试：dsh session/event → 卡片事件流（per-chat 路由）。
 */
import { describe, expect, it, vi } from "vitest";
import { DshEventAdapter, type SettleHooks } from "./event-adapter.js";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";

function makeEvent(type: string, data: unknown, sessionId = "sess-1"): SessionEvent {
  return { type, seq: 0, time: 0, data } as SessionEvent;
}

function makeEnv(config: { showThinking?: boolean } = {}) {
  const activeSession: any = {
    chatId: "oc_test",
    phase: "completed",
    footer: { apiCalls: 0, stopReason: undefined },
  };
  const streaming: any = {
    sessionFor: (chatId: string) => (chatId === "oc_test" ? activeSession : null),
    onTextDelta: vi.fn(),
    onThinkingDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolUpdate: vi.fn(),
    onToolEnd: vi.fn(),
    recordError: vi.fn(),
    onAgentEnd: vi.fn(),
    settle: vi.fn().mockResolvedValue(activeSession),
    abort: vi.fn().mockResolvedValue(activeSession),
    release: vi.fn(),
  };
  const manager: any = {
    sessionId: SessionId("sess-1"),
    isOwnedSession: (id: unknown) => String(id) === "sess-1",
    chatIdForSession: (id: unknown) => (String(id) === "sess-1" ? "oc_test" : undefined),
    resolveModelLabel: (provider: string, model: string) => `Display-${model}`,
    getTokenUsage: vi.fn().mockReturnValue({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
    getLatestRequestStats: vi.fn().mockReturnValue({ inputTokens: 10, contextWindow: 1000 }),
    getStreamMetrics: vi.fn().mockReturnValue({ ttftAvgMs: 3600, outputSpeedTps: 148 }),
  };
  const client: any = { stopTyping: vi.fn().mockResolvedValue(undefined) };
  const queues: any = { setProcessing: vi.fn() };
  const hooks: SettleHooks = { onSettled: vi.fn().mockResolvedValue(undefined) };
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const adapter = new DshEventAdapter(
    manager,
    () => streaming,
    () => client,
    queues,
    { showThinking: true, debug: false, ...config },
    logger,
    hooks,
  );
  return { adapter, streaming, client, queues, hooks, logger, activeSession };
}

describe("DshEventAdapter", () => {
  it("text-delta chunk → onTextDelta（按 chat 路由）", () => {
    const env = makeEnv();
    env.adapter["handle"](SessionId("sess-1"), makeEvent("assistant/chunk", {
      turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "你好" },
    }));
    expect(env.streaming.onTextDelta).toHaveBeenCalledWith("oc_test", "你好");
  });

  it("reasoning-delta → onThinkingDelta（showThinking 由渲染层控制，适配层总是转发）", () => {
    const env = makeEnv();
    env.adapter["handle"](SessionId("sess-1"), makeEvent("assistant/chunk", {
      turn: 1, step: 0, chunk: { type: "reasoning-delta", index: 0, text: "思考中" },
    }));
    expect(env.streaming.onThinkingDelta).toHaveBeenCalledWith("oc_test", "思考中");
  });

  it("reasoning-delta 且 showThinking=false 仍转发（轮次计数不依赖展示开关）", () => {
    const env = makeEnv({ showThinking: false });
    env.adapter["handle"](SessionId("sess-1"), makeEvent("assistant/chunk", {
      turn: 1, step: 0, chunk: { type: "reasoning-delta", index: 0, text: "思考中" },
    }));
    expect(env.streaming.onThinkingDelta).toHaveBeenCalledWith("oc_test", "思考中");
  });

  it("finish chunk → footer.stopReason", () => {
    const env = makeEnv();
    env.adapter["handle"](SessionId("sess-1"), makeEvent("assistant/chunk", {
      turn: 1, step: 0, chunk: { type: "finish", reason: { kind: "stop" } },
    }));
    expect(env.activeSession.footer.stopReason).toBe("stop");
  });

  it("tool/call → onToolStart（arguments 为解析后对象）", () => {
    const env = makeEnv();
    env.adapter["handle"](SessionId("sess-1"), makeEvent("tool/call", {
      turn: 1, step: 0, callId: "call-1", name: "bash", arguments: '{"cmd":"ls"}',
    }));
    expect(env.streaming.onToolStart).toHaveBeenCalledWith("oc_test", "call-1", "bash", { cmd: "ls" });
  });

  it("tool/result → onToolEnd（提取文本 + 错误标志）", () => {
    const env = makeEnv();
    env.adapter["handle"](SessionId("sess-1"), makeEvent("tool/result", {
      turn: 1, step: 0,
      message: {
        source: { kind: "tool", callId: "call-1" },
        content: [{ type: "text", text: "ls 输出" }],
      },
      error: undefined,
    }));
    expect(env.streaming.onToolEnd).toHaveBeenCalledWith("oc_test", "call-1", "ls 输出", false);
  });

  it("request/header → footer.model 显示名 + reasoningEffort", () => {
    const env = makeEnv();
    env.adapter["handle"](SessionId("sess-1"), makeEvent("request/header", {
      header: { config: { provider: "opencode", model: "deepseek-v4-flash", reasoningEffort: "max" } },
      reason: "initial",
    }));
    expect(env.activeSession.footer.model).toBe("Display-deepseek-v4-flash");
    expect(env.activeSession.footer.reasoningEffort).toBe("max");
  });

  it("assistant/message → footer.model 显示名（source.model）", () => {
    const env = makeEnv();
    env.adapter["handle"](SessionId("sess-1"), makeEvent("assistant/message", {
      turn: 1, step: 0,
      message: { source: { kind: "model", provider: "opencode", model: "deepseek-v4-flash" }, content: [] },
      usage: undefined,
    }));
    expect(env.activeSession.footer.model).toBe("Display-deepseek-v4-flash");
  });

  it("turn/end completed → settle + footer usage + onSettled", async () => {
    const env = makeEnv();
    await env.adapter["handleTurnEnd"]("oc_test", makeEvent("turn/end", {
      turn: 1, reason: { kind: "completed" },
    }));
    expect(env.activeSession.footer.inputTokens).toBe(10);
    expect(env.activeSession.footer.outputTokens).toBe(5);
    expect(env.streaming.settle).toHaveBeenCalledWith("oc_test");
    expect(env.client.stopTyping).toHaveBeenCalledWith("oc_test", true);
    expect(env.hooks.onSettled).toHaveBeenCalledWith("oc_test", "completed");
  });

  it("turn/end error → recordError + abort(llm_error)", async () => {
    const env = makeEnv();
    await env.adapter["handleTurnEnd"]("oc_test", makeEvent("turn/end", {
      turn: 1, reason: { kind: "error", error: { message: "rate limit", code: "RATE_LIMIT" } },
    }));
    expect(env.streaming.recordError).toHaveBeenCalledWith("oc_test", "rate limit");
    expect(env.streaming.abort).toHaveBeenCalledWith("oc_test", "LLM 调用失败", "llm_error");
  });

  it("aborted 且卡片未终态 → abort 封卡后仍 settle + onSettled（P1-1 回归）", async () => {
    const env = makeEnv();
    env.activeSession.terminal = false;
    await env.adapter["handleTurnEnd"]("oc_test", makeEvent("turn/end", {
      turn: 1, reason: { kind: "aborted" },
    }));
    expect(env.streaming.abort).toHaveBeenCalledWith("oc_test", "任务已中断", "user_abort");
    expect(env.streaming.settle).toHaveBeenCalled();
    expect(env.hooks.onSettled).toHaveBeenCalled();
  });

  it("settle 成功路径不调用 streaming.release（release 归 onSettled，P0-2 回归）", async () => {
    const env = makeEnv();
    await env.adapter["settle"]("oc_test");
    expect(env.streaming.settle).toHaveBeenCalledWith("oc_test");
    expect(env.streaming.release).not.toHaveBeenCalled();
    expect(env.hooks.onSettled).toHaveBeenCalled();
  });

  it("其他 session 的事件被忽略", () => {
    const env = makeEnv();
    env.adapter["handle"](SessionId("other-sess"), makeEvent("assistant/chunk", {
      turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "别人的" },
    }));
    expect(env.streaming.onTextDelta).not.toHaveBeenCalled();
  });
});