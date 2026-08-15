/**
 * 会话生命周期命令：/new /resume（dsh 版）。
 *
 * /new：释放当前共享 agent，改用全新 sessionId（历史仍持久化可恢复）。
 * /resume：列出持久化会话 / 恢复指定 sessionId。
 */

import { describeError } from "../log.js";
import type { CommandContext, CommandHandler } from "./types.js";

export const newCommand: CommandHandler = {
  name: "/new",
  help: "新建会话（清空上下文，重新开始）",
  async handle(ctx) {
    await ctx.prepareSessionControl();
    const statusMessageId = await ctx.client?.sendStatusCard(ctx.chatId, "正在新建会话…", ctx.msgId);
    try {
      const newId = await ctx.manager.reset(ctx.chatId);
      const text = `已新建会话。先前上下文已清空，可继续对话。\n（新 session: ${newId.slice(0, 8)}…；如需找回，用 /resume）`;
      if (ctx.client && statusMessageId) {
        await ctx.client.updateTextCard(statusMessageId, text).catch(() => {});
      } else {
        await ctx.client?.sendMessage(ctx.chatId, text, ctx.msgId);
      }
    } catch (error) {
      const text = `新建会话失败：${describeError(error)}`;
      if (ctx.client && statusMessageId) {
        await ctx.client.updateTextCard(statusMessageId, text).catch(() => {});
      } else {
        await ctx.client?.sendMessage(ctx.chatId, text, ctx.msgId);
      }
    }
  },
};

export const resumeCommand: CommandHandler = {
  name: "/resume",
  help: "列出/恢复历史会话（/resume 列表；/resume <sessionId> 恢复）",
  async handle(ctx: CommandContext): Promise<string | void> {
    const arg = ctx.args.trim();
    let sessions: Array<{ id: string }>;
    try {
      sessions = await ctx.manager.listPersistedSessions(ctx.chatId);
    } catch (error) {
      return `列出会话失败：${describeError(error)}`;
    }

    if (sessions.length === 0) {
      return "没有可恢复的历史会话。（需要宿主配置 sessionPersistence 持久化）";
    }

    // 无参数 → 仅列表
    if (!arg) {
      const current = ctx.manager.sessionIdFor(ctx.chatId);
      const lines = sessions.map((s, i) => {
        const marker = s.id === current ? " ← 当前" : "";
        return `  ${i + 1}. ${s.id}${marker}`;
      });
      return [`可恢复会话（共 ${sessions.length} 个）：`, ...lines, "", "用法: /resume <序号或 sessionId>"].join("\n");
    }

    // 序号解析
    let target: string | undefined;
    if (/^\d+$/.test(arg)) {
      const idx = Number(arg) - 1;
      const hit = sessions[idx];
      if (!hit) return `序号 ${arg} 超出范围（共 ${sessions.length} 个）。`;
      target = hit.id;
    } else if (sessions.some((s) => s.id.startsWith(arg))) {
      target = sessions.find((s) => s.id.startsWith(arg))!.id;
    } else {
      return `未找到匹配的会话：${arg}\n（用 /resume 查看全部会话 id）`;
    }

    if (target === ctx.manager.sessionIdFor(ctx.chatId) && ctx.manager.recordFor(ctx.chatId)) {
      return "已在该会话中。";
    }

    await ctx.prepareSessionControl();
    const statusMessageId = await ctx.client?.sendStatusCard(ctx.chatId, `正在恢复会话：${target.slice(0, 8)}…`, ctx.msgId);
    const ok = await ctx.manager.resumeSession(ctx.chatId, target);
    const text = ok ? `已恢复会话：${target}` : `恢复会话失败：${target}`;
    if (ctx.client && statusMessageId) {
      await ctx.client.updateTextCard(statusMessageId, text).catch(() => {});
    } else {
      await ctx.client?.sendMessage(ctx.chatId, text, ctx.msgId);
    }
  },
};