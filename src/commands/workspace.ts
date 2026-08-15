import type { CommandContext, CommandHandler } from "./types.js";

const USAGE = [
  "/workspace                  查看当前工作区与可用列表",
  "/workspace list             列出已注册工作区",
  "/workspace use <id>         切换当前 chat 工作区",
  "/workspace reset            恢复默认工作区",
].join("\n");

function sourceLabel(source: "chat" | "default" | "legacy"): string {
  if (source === "chat") return "当前 chat 选择";
  if (source === "default") return "配置默认";
  return "兼容旧 cwd";
}

function formatList(ctx: CommandContext): string {
  const current = ctx.manager.getEffectiveWorkspace(ctx.chatId);
  const rows = ctx.manager.listWorkspaces();
  const lines = [
    "当前工作区:",
    "- 名称: " + current.title,
    "- ID: " + current.id,
    "- 路径: " + current.path,
    "- 来源: " + sourceLabel(current.source),
    "",
    "可用工作区:",
  ];
  for (const row of rows) {
    const status = row.status === "available" ? "可用" : "目录不可用";
    lines.push("- " + row.id + "：" + row.title + "（" + status + "）");
    lines.push("  " + row.path);
  }
  return lines.join("\n");
}

function canChange(ctx: CommandContext): boolean {
  return ctx.manager.isWorkspaceAdmin(ctx.senderOpenId, ctx.chatType);
}

export const workspaceCommand: CommandHandler = {
  name: "/workspace",
  help: "查看/切换当前 chat 工作区（/workspace use <id>）",
  async handle(ctx) {
    const parts = ctx.args.trim().split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase() ?? "list";

    if (action === "help") return USAGE;
    if (action === "list") return formatList(ctx);

    if (action === "use") {
      const workspaceId = parts[1];
      if (!workspaceId) return "缺少工作区 ID。\n\n" + USAGE;
      if (!canChange(ctx)) return "无权切换工作区：群聊需要在 workspaceAdminOpenIds 中配置你的 open_id。";
      if (!ctx.manager.isIdleFor(ctx.chatId)) return "当前 chat 正在处理中，请等待完成或先执行 /stop，再切换工作区。";
      await ctx.prepareSessionControl();
      const result = await ctx.manager.switchWorkspace(ctx.chatId, workspaceId);
      if (!result.changed) return "当前已经是工作区：" + result.workspace.title;
      return "已切换工作区：" + result.workspace.title + "\n路径：" + result.workspace.path + "\n已创建新的会话；旧会话仍可通过 /resume 恢复。";
    }

    if (action === "reset") {
      if (!canChange(ctx)) return "无权恢复默认工作区：群聊需要在 workspaceAdminOpenIds 中配置你的 open_id。";
      if (!ctx.manager.isIdleFor(ctx.chatId)) return "当前 chat 正在处理中，请等待完成或先执行 /stop，再恢复默认工作区。";
      await ctx.prepareSessionControl();
      const result = await ctx.manager.resetWorkspace(ctx.chatId);
      if (!result.changed) return "当前 chat 没有单独的工作区选择，仍使用：" + result.workspace.title;
      return "已恢复默认工作区：" + result.workspace.title + "\n路径：" + result.workspace.path + "\n已创建新的会话；旧会话仍可通过 /resume 恢复。";
    }

    return USAGE;
  },
};
