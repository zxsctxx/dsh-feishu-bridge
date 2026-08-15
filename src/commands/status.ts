/** 状态查询命令：/status /feishu /help（dsh 版） */

import { accessRiskWarning, DEFAULT_ACCESS_POLICY } from "../access/policy.js";
import { formatMetrics } from "../monitoring/metrics.js";
import { formatDoctor, runDoctor } from "../monitoring/doctor.js";
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from "../version.js";
import type { CommandContext, CommandHandler } from "./types.js";

const FEISHU_USAGE = "/feishu status | monitor [reset] | config [reload] | doctor | help";

export const statusCommand: CommandHandler = {
  name: "/status",
  help: "查看 DSH 状态",
  async handle(ctx) {
    const pending = ctx.queues.pendingFor(ctx.chatId);
    const appId = ctx.config.appId ? `****${ctx.config.appId.slice(-4)}` : "未设置";
    const status = ctx.manager.getStatus();
    const usage = ctx.manager.getTokenUsage();

    let reply = `DSH 状态:\n- 飞书连接: ${ctx.client?.getStatus() ?? "未启动"}\n- App ID: ${appId}`;

    const warning = accessRiskWarning(ctx.config);
    if (warning) reply += `\n- ${warning}`;

    if (pending > 0) reply += `\n- 排队: ${pending} 条`;
    else if (!ctx.manager.isIdle) reply += "\n- 状态: 处理中";
    else reply += "\n- 状态: 空闲";

    reply += `\n- 会话: ${status.sessionId?.slice(0, 8) ?? "未创建"}（${status.messageCount ?? 0} 条消息）`;
    reply += `\n- 模型: ${status.provider && status.model ? `${status.provider}/${status.model}` : "宿主默认"}`;
    if (status.preset) reply += `\n- Preset: ${status.preset}`;
    if (usage.input > 0 || usage.output > 0) {
      reply += `\n- Tokens: in ${usage.input} / out ${usage.output} / cacheR ${usage.cacheRead} / cacheW ${usage.cacheWrite}`;
    }
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
        return formatDoctor(runDoctor(ctx.config, connected, cardkit));
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
          `Domain: ${ctx.config.domain ?? "feishu"}`,
          `Show thinking: ${ctx.config.showThinking ?? false}`,
          `Task timeout: ${ctx.config.taskTimeoutSec ?? 900}s`,
          `Same-chat busy: ${ctx.config.sameChatBusyPolicy ?? "queue"}`,
          `Access policy: ${ctx.config.accessPolicy ?? DEFAULT_ACCESS_POLICY}`,
          `Allowed chats: ${ctx.config.allowedChatIds?.length ?? 0}`,
          `Allowed users: ${ctx.config.allowedOpenIds?.length ?? 0}`,
        ].join("\n");

      case "config reload": {
        const result = await ctx.configReload.request(
          ctx.manager.isIdle,
          () => ctx.reloadConfig(),
        );
        return result === "deferred"
          ? "配置将在当前 Agent 处理完后重载。"
          : "配置已重载。";
      }

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