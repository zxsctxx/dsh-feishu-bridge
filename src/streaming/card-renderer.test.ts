import { describe, expect, it } from "vitest";
import { CardSession } from "./card-session.js";
import {
  buildPanelElement,
  buildTerminalStatus,
  DEFAULT_FOOTER_LINES,
  formatFooterContent,
  panelContent,
} from "./card-renderer.js";

// ─── 渲染面板选项 ─────────────────────────────────────

const OPTIONS = {
  showThinking: true,
  panelExpanded: false,
  maxToolSteps: 20,
  maxThinkingRounds: 20,
  printStrategy: "delay" as const,
  printStep: 4,
  maxReasoningChars: 50,
  maxToolDetailChars: 30,
  maxToolOutputChars: 40,
};

function makeSession(): CardSession {
  return new CardSession("req-1", "chat-1", "msg-1", 70);
}

function renderPanelText(session: CardSession): string {
  return panelContent(buildPanelElement(session, OPTIONS));
}

// ─── 推理正文截断标注 ──────────────────────────────────

describe("推理正文截断标注", () => {
  it("thinking 超限时标注已截断且附原文长度", () => {
    const s = makeSession();
    const long = "思".repeat(120);
    s.appendThinking(long);
    const text = renderPanelText(s);
    expect(text).toContain("已截断，共 120 字");
  });

  it("thinking 未超限时不含截断标注", () => {
    const s = makeSession();
    s.appendThinking("短推理");
    const text = renderPanelText(s);
    expect(text).toContain("短推理");
    expect(text).not.toContain("已截断");
  });

  it("已完成轮次的推理同样标注（thinkingRounds 路径）", () => {
    const s = makeSession();
    s.appendThinking("前一轮".repeat(40)); // 120 字，超 50 上限
    s.finishThinking();
    const text = renderPanelText(s);
    expect(text).toContain("已截断，共 120 字");
  });
});

// ─── 工具 detail / output 截断标注 ─────────────────────

describe("工具 detail/output 截断标注", () => {
  it("工具 detail 超限时标注已截断", () => {
    const s = makeSession();
    const id = "tool-1";
    s.recordTool(id);
    s.tools.start(id, "bash", { command: "c".repeat(200) });
    const text = renderPanelText(s);
    expect(text).toContain("已截断");
  });

  it("工具 output 超限时标注已截断", () => {
    const s = makeSession();
    const id = "tool-2";
    s.recordTool(id);
    s.tools.start(id, "bash", { command: "echo hi" });
    s.tools.end(id, { content: [{ type: "text", text: "o".repeat(200) }] }, false);
    const text = renderPanelText(s);
    expect(text).toContain("已截断");
  });

  it("工具 detail 未超限时不标注", () => {
    const s = makeSession();
    const id = "tool-3";
    s.recordTool(id);
    s.tools.start(id, "read", { path: "a.ts" });
    const text = renderPanelText(s);
    expect(text).not.toContain("已截断");
  });
});

// ─── 其他调用点不受影响 ────────────────────────────────

describe("页脚 model 字段（模型 + 思考强度）", () => {
  it("默认行包含 model，渲染为「显示名 + effort」", () => {
    const s = makeSession();
    s.footer.model = "DeepSeek V4 Flash";
    s.footer.reasoningEffort = "max";
    const content = formatFooterContent(s, DEFAULT_FOOTER_LINES);
    expect(content).toContain("DeepSeek V4 Flash Max");
  });

  it("effort=off/none 不显示后缀", () => {
    const s = makeSession();
    s.footer.model = "DeepSeek V4 Flash";
    s.footer.reasoningEffort = "none";
    const content = formatFooterContent(s, [["model"]]);
    expect(content).toBe("DeepSeek V4 Flash");
  });

  it("无模型信息显示未知模型", () => {
    const s = makeSession();
    expect(formatFooterContent(s, [["model"]])).toBe("未知模型");
  });
});

describe("页脚 input/output 字段（会话 billed 总量口径，对齐 dsh Web）", () => {
  it("input 含缓存命中/写入（uncached + cacheRead + cacheWrite）", () => {
    const s = makeSession();
    s.footer.inputTokens = 100;
    s.footer.cacheRead = 400;
    s.footer.cacheWrite = 50;
    expect(formatFooterContent(s, [["input"]])).toBe("输入 550 tok");
  });

  it("无缓存时 input 即 uncached 值", () => {
    const s = makeSession();
    s.footer.inputTokens = 1200;
    expect(formatFooterContent(s, [["input"]])).toBe("输入 1.2K tok");
  });

  it("output 为会话累计输出", () => {
    const s = makeSession();
    s.footer.outputTokens = 1600;
    expect(formatFooterContent(s, [["output"]])).toBe("输出 1.6K tok");
  });
});

describe("非三处的 truncate 调用保持原样", () => {
  it("错误信息截断不带标注（buildTerminalStatus 路径）", () => {
    const s = makeSession();
    s.errorMessage = "e".repeat(2500);
    const status = buildTerminalStatus(s);
    expect(status.content).toContain("\u2026"); // 仍显示省略号
    expect(status.content).not.toContain("已截断");
  });
});
