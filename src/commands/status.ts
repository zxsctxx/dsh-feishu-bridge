/** 状态查询命令：/status /feishu /help（dsh 版） */

import { accessRiskWarning, DEFAULT_ACCESS_POLICY } from "../access/policy.js";
import { formatMetrics } from "../monitoring/metrics.js";
import { formatDoctor, runDoctor } from "../monitoring/doctor.js";
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from "../version.js";
import type { CommandContext, CommandHandler } from "./types.js";

const FEISHU_USAGE = "/feishu status | monitor [reset] | config | doctor | help";

export const statusCommand: CommandHandler = {
  name: "/status",
  help: "查看 DSH 状态",
  async handle(ctx) {
    const pending = ctx.queues.pendingFor(ctx.chatId);
    const appId = ctx.config.appId ? `****${ctx.config.appId.slice(-4)}` : "未设置";
    const status = await ctx.manager.getStatus(ctx.chatId);
    const usage = ctx.manager.getTokenUsage(ctx.chatId);

    let reply = `DSH 状态:\n- 飞书连接: ${ctx.client?.getStatus() ?? "未启动"}\n- App ID: ${appId}`;

    const warning = accessRiskWarning(ctx.config);
    if (warning) reply += `\n- ${warning}`;

    if (pending > 0) reply += `\n- 排队: ${pending} 条`;
    else if (!ctx.manager.isIdleFor(ctx.chatId)) reply += "\n- 状态: 处理中";
    else reply += "\n- 状态: 空闲";

    reply += `\n- 会话: ${status.sessionId?.slice(0, 8) ?? "未创建"}（${status.messageCount ?? 0} 条消息）`;
    // 思考强度口径与页脚一致：首字母大写（max → Max），off/none 视为关闭不显示
    const effort =
      status.reasoningEffort && status.reasoningEffort !== "off" && status.reasoningEffort !== "none"
        ? ` ${status.reasoningEffort.charAt(0).toUpperCase()}${status.reasoningEffort.slice(1)}`
        : "";
    reply += `\n- 模型: ${status.provider && status.model ? `${status.provider}/${status.model}${effort}` : "宿主默认"}`;
    if (status.preset) reply += `\n- Preset: ${status.preset}`;
    if (usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0) {
      // in = billed 输入总量（含缓存命中/写入），对齐 footer 与 dsh Web 口径
      const billedInput = usage.input + usage.cacheRead + usage.cacheWrite;
      reply += `\n- Tokens: in ${billedInput} / out ${usage.output} / cacheR ${usage.cacheRead} / cacheW ${usage.cacheWrite}`;
    }
    reply += `\n- 工作区: ${status.workspaceTitle ?? "默认工作区"} [${status.workspaceId ?? "default"}]`;
    reply += `\n- 工作区路径: ${status.cwd ?? "未知"}`;
    if (status.workspaceSource) reply += `\n- 工作区来源: ${status.workspaceSource}`;
    return reply;
  },
};

export const feishuCommand: CommandHandler = {
  name: "/feishu",
  help: FEISHU_USAGE,
  async handle(ctx) {
    switch (ctx.args.toLowerCase() || "help") {
      case "monitor":
        return formatMetrics(ctx.metrics.snapshot());

      case "monitor reset":
        ctx.metrics.reset();
        return "监控指标已清零。";

      case "doctor": {
        const connected = ctx.client?.getStatus() === "connected";
        const cardkit = connected ? await ctx.client!.checkCardKitAvailability() : null;
        return formatDoctor(runDoctor(ctx.config, connected, cardkit, ctx.workspaceBackend));
      }

      case "status": {
        const warning = accessRiskWarning(ctx.config);
        return (
          `${PRODUCT_NAME} ${PRODUCT_VERSION} (${PRODUCT_ID})\n` +
          `飞书连接: ${ctx.client?.getStatus() ?? "未启动"}\n` +
          `访问策略: ${ctx.config.accessPolicy ?? DEFAULT_ACCESS_POLICY}` +
          (warning ? `\n${warning}` : "")
        );
      }

      case "config":
        return [
          `域名: ${ctx.config.domain ?? "feishu"}`,
          `展示推理: ${ctx.config.showThinking ?? false}`,
          `任务超时: ${ctx.config.taskTimeoutSec ?? 900}s`,
          `同会话忙时策略: ${ctx.config.sameChatBusyPolicy ?? "queue"}`,
          `访问策略: ${ctx.config.accessPolicy ?? DEFAULT_ACCESS_POLICY}`,
          `允许的群聊数: ${ctx.config.allowedChatIds?.length ?? 0}`,
          `允许的用户数: ${ctx.config.allowedOpenIds?.length ?? 0}`,
        ].join("\n");

      default:
        return FEISHU_USAGE;
    }
  },
};

export const helpCommand: CommandHandler = {
  name: "/help",
  help: "显示帮助",
  async handle(ctx: CommandContext) {
    return [
      "可用命令:",
      "  /new       - 新建 DSH 会话（清空上下文）",
      "  /resume    - 列出/恢复历史会话（/resume · /resume <序号|sessionId>）",
      "  /stop      - 中断当前处理，清空排队",
      "  /queue     - 查看排队状态",
      "  /model     - 查看/切换模型（如 /model deepseek/deepseek-chat）",
      "  /reasoning - 查看/切换思考强度（如 /reasoning high；/reasoning default 重置）",
      "  /preset    - 查看/切换 Agent 预设（/preset [id]；/preset default [id] 设全局默认）",
      "  /workspace - 查看/切换工作区（/workspace use <id>）",
      "  /status    - 查看 DSH 状态",
      "  /help      - 显示帮助",
      "",
      "飞书管理:",
      `  ${FEISHU_USAGE}`,
      "",
      "更多配置与安全边界说明见项目 README。",
    ].join("\n");
  },
};