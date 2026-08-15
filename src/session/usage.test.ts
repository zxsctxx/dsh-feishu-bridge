/**
 * dsh 会话 usage 适配测试：SessionEvent[] → 累计统计。
 */
import { describe, expect, it } from "vitest";
import { accumulateUsage, entriesFromDshEvents, streamMetricsFromEvents } from "./usage.js";

describe("entriesFromDshEvents + accumulateUsage", () => {
  it("累计 assistant/message 的 usage", () => {
    const events = [
      { type: "user/message", seq: 0, time: 1, data: { source: { kind: "user" } } },
      {
        type: "assistant/message",
        seq: 1,
        time: 2,
        data: {
          message: { role: "assistant", source: { kind: "model", provider: "p", model: "m" } },
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
        },
      },
      {
        type: "assistant/message",
        seq: 2,
        time: 3,
        data: {
          message: { role: "assistant", source: { kind: "model", provider: "p", model: "m" } },
          usage: { inputTokens: 30, outputTokens: 5 },
        },
      },
    ];
    const totals = accumulateUsage(entriesFromDshEvents(events));
    expect(totals.inputTokens).toBe(130);
    expect(totals.outputTokens).toBe(25);
    expect(totals.cacheRead).toBe(50);
    expect(totals.cacheWrite).toBe(0);
    // 最近一次有缓存的请求：100 + 50 = 150，命中 50 → 33.33%
    expect(totals.cacheHitPercent).toBeCloseTo(33.33, 1);
  });

  it("忽略非 assistant/message 事件", () => {
    const events = [
      { type: "assistant/chunk", seq: 0, time: 1, data: { chunk: { type: "text-delta", index: 0, text: "hi" } } },
      { type: "user/message", seq: 1, time: 2, data: { source: { kind: "user" } } },
    ];
    const totals = accumulateUsage(entriesFromDshEvents(events));
    expect(totals.inputTokens).toBe(0);
    expect(totals.outputTokens).toBe(0);
  });

  it("无 usage 时不显示 reasoning 0", () => {
    const events: unknown[] = [];
    const totals = accumulateUsage(entriesFromDshEvents(events));
    expect(totals.reasoningTokens).toBeUndefined();
  });
});

describe("streamMetricsFromEvents", () => {
  it("计算最近一场 turn 的首 token 平均延迟与最近一步速率", () => {
    const events = [
      // 上一场 turn（应被排除）
      { type: "turn/start", seq: 0, time: 1000, data: {} },
      { type: "step/start", seq: 1, time: 1000, data: { turn: 1, step: 0 } },
      { type: "assistant/chunk", seq: 2, time: 3000, data: { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "a" } } },
      { type: "assistant/message", seq: 3, time: 5000, data: { turn: 1, step: 0, message: {}, usage: { outputTokens: 200 } } },
      // 当前场 turn（step1 用 reasoning 首块；step2 无 chunk 只有消息）
      { type: "turn/start", seq: 4, time: 10_000, data: {} },
      { type: "step/start", seq: 5, time: 10_000, data: { turn: 2, step: 0 } },
      { type: "assistant/chunk", seq: 6, time: 13_600, data: { turn: 2, step: 0, chunk: { type: "reasoning-delta", index: 0, text: "思考" } } },
      { type: "assistant/message", seq: 7, time: 15_000, data: { turn: 2, step: 0, message: {}, usage: { outputTokens: 300 } } },
      { type: "step/start", seq: 8, time: 15_000, data: { turn: 2, step: 1 } },
      { type: "assistant/chunk", seq: 9, time: 16_000, data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "b" } } },
      { type: "assistant/message", seq: 10, time: 20_000, data: { turn: 2, step: 1, message: {}, usage: { outputTokens: 740 } } },
    ];
    const metrics = streamMetricsFromEvents(events);
    // step0 ttft=3.6s，step1 ttft=1s → 平均 2.3s
    expect(metrics.ttftAvgMs).toBeCloseTo(2300, 0);
    // 最近一步 raw 速率 = 740 / 5s = 148
    expect(metrics.outputSpeedTps).toBeCloseTo(148, 1);
  });

  it("无 turn 时返回 null 指标", () => {
    expect(streamMetricsFromEvents([])).toEqual({ ttftAvgMs: null, outputSpeedTps: null });
  });
});