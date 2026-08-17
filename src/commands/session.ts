/**
 * 会话生命周期命令：/new /resume（dsh 版）。
 *
 * /new：释放当前共享 agent，改用全新 sessionId（历史仍持久化可恢复）。
 * /resume：列出持久化会话 / 恢复指定 sessionId。
 */

import { describeError } from "../log.js";
import type { PersistedSessionInfo } from "../dsh/types.js";
import type { CommandContext, CommandHandler } from "./types.js";

/**
 * 无参数 /resume 的列表渲染：宿主 Workspace 有归属时按组输出，
 * 未归属显示“未分组”；序号仍对应扁平 session 列表。
 */
export function formatResumeList(sessions: PersistedSessionInfo[], current: string): string {
  const flat = (session: PersistedSessionInfo, index: number): string => {
    const marker = session.id === current ? " ← 当前" : "";
    return `  ${index + 1}. ${session.id}${marker}`;
  };

  if (!sessions.some((session) => session.workspaceId !== undefined)) {
    const lines = [`可恢复会话（共 ${sessions.length} 个）：`];
    sessions.forEach((session, index) => lines.push(flat(session, index)));
    lines.push("", "用法: /resume <序号或 sessionId>");
    return lines.join("\n");
  }

  const groups: Array<{ title: string; path?: string; lines: string[] }> = [];
  const byKey = new Map<string, { title: string; path?: string; lines: string[] }>();
  for (const [index, session] of sessions.entries()) {
    const key = session.workspaceId ?? "";
    let group = byKey.get(key);
    if (!group) {
      group = {
        title: session.workspaceId ? (session.workspaceTitle ?? session.workspaceId) : "未分组",
        path: session.workspacePath,
        lines: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.lines.push(flat(session, index));
  }

  const blocks: string[] = [`可恢复会话（共 ${sessions.length} 个，按工作区分组）：`];
  for (const group of groups) {
    const header = group.title === "未分组" ? "未分组" : `工作区: ${group.title}${group.path ? `\n  路径: ${group.path}` : ""}`;
    blocks.push("", `- ${header}`);
    blocks.push(...group.lines);
  }
  blocks.push("", "用法: /resume <序号或 sessionId>");
  return blocks.join("\n");
}

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
    let sessions: PersistedSessionInfo[];
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
      return formatResumeList(sessions, ctx.manager.sessionIdFor(ctx.chatId));
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