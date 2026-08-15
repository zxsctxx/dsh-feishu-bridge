/**
 * 会话 token / 费用累计（适配 dsh 事件结构）。
 *
 * 输入为 dsh SessionEvent[]（agent.session.events），口径：
 * 遍历全部 assistant/message 事件的 usage（TokenUsage）累加，
 * input 不含缓存读/写（三者 disjoint，账单 input = 三者之和）。
 */

export interface MessageUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** 无推理 token 时为 undefined，避免 footer 显示 0 */
  reasoningTokens: number | undefined;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** 最近一次有缓存的请求的命中率（%） */
  cacheHitPercent: number | undefined;
}

/** session 条目中形如 assistant message 的部分 */
export interface UsageEntry {
  type?: string;
  message?: { role?: string; usage?: MessageUsage };
}

/** 把 dsh SessionEvent[] 归一化为 UsageEntry[]（供 accumulateUsage 消费） */
export function entriesFromDshEvents(events: readonly unknown[]): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const raw of events) {
    const event = raw as { type?: string; data?: { message?: unknown; usage?: Record<string, unknown> } };
    if (event?.type !== "assistant/message") continue;
    const usage = event.data?.usage as
      | { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
      | undefined;
    if (!usage) continue;
    entries.push({
      type: "assistant/message",
      message: {
        role: "assistant",
        usage: {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          reasoning: usage.reasoningTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
        },
      },
    });
  }
  return entries;
}

/**
 * 累加 assistant usage。
 *
 * `pending` 用于当前条尚未落盘的情况；dsh 的 session/event 为 post-commit
 * 事件（events 已含当前条），正常无需传 pending。
 */
export function accumulateUsage(
  entries: readonly UsageEntry[],
  pending?: MessageUsage,
): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let cacheHitPercent: number | undefined;

  const apply = (usage: MessageUsage | undefined): void => {
    if (!usage) return;
    const input = usage.input ?? 0;
    const cr = usage.cacheRead ?? 0;
    const cw = usage.cacheWrite ?? 0;
    inputTokens += input;
    outputTokens += usage.output ?? 0;
    if (typeof usage.reasoning === "number") reasoningTokens += usage.reasoning;
    cacheRead += cr;
    cacheWrite += cw;
    cost += usage.cost?.total ?? 0;
    // 命中率取最近一次有缓存的请求，与终端 CH 字段口径一致
    const promptTokens = input + cr + cw;
    if (promptTokens > 0 && (cr > 0 || cw > 0)) {
      cacheHitPercent = (cr / promptTokens) * 100;
    }
  };

  for (const entry of entries) {
    if (entry.type !== "assistant/message") continue;
    if (entry.message?.role === "assistant") apply(entry.message.usage);
  }
  apply(pending);

  return {
    inputTokens,
    outputTokens,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
    cacheRead,
    cacheWrite,
    cost,
    cacheHitPercent,
  };
}

/** 流式质量指标：首 token 平均延迟（ms）与最近一步输出速率（tok/s） */
export interface StreamMetrics {
  ttftAvgMs: number | null;
  outputSpeedTps: number | null;
}

/**
 * 从 dsh SessionEvent[] 计算流式指标：只统计最后一场 turn
 * （最后一次 turn/start 之后）；每个 step 的 ttft = 首个文本/推理 chunk 时间
 * − step/start 时间，跨 step 平均；速率 = 该 step 的 usage.outputTokens /
 * (assistant/message 时间 − step/start 时间)，取最近一步。
 */
export function streamMetricsFromEvents(events: readonly unknown[]): StreamMetrics {
  let startIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as { type?: string }).type === "turn/start") { startIdx = i; break; }
  }
  const scope = startIdx >= 0 ? events.slice(startIdx) : events;

  let stepStartTime: number | null = null;
  let firstChunkTime: number | null = null;
  let ttftSum = 0;
  let ttftCount = 0;
  let lastSpeed: number | null = null;

  for (const raw of scope) {
    const event = raw as {
      type?: string;
      time?: number;
      data?: { chunk?: { type?: string }; usage?: { outputTokens?: number } };
    };
    if (event.type === "step/start") {
      stepStartTime = event.time ?? null;
      firstChunkTime = null;
      continue;
    }
    if (event.type === "assistant/chunk") {
      const chunk = event.data?.chunk;
      if (
        firstChunkTime === null &&
        (chunk?.type === "text-delta" || chunk?.type === "reasoning-delta") &&
        event.time !== undefined && stepStartTime !== null && event.time >= stepStartTime
      ) {
        firstChunkTime = event.time;
        ttftSum += event.time - stepStartTime;
        ttftCount += 1;
      }
      continue;
    }
    if (event.type === "assistant/message" && event.data?.usage) {
      const outputTokens = event.data.usage.outputTokens ?? 0;
      if (stepStartTime !== null && event.time !== undefined && event.time > stepStartTime) {
        lastSpeed = outputTokens / ((event.time - stepStartTime) / 1000);
      }
    }
  }

  return {
    ttftAvgMs: ttftCount > 0 ? ttftSum / ttftCount : null,
    outputSpeedTps: lastSpeed,
  };
}