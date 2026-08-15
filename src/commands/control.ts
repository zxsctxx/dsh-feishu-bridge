/** 运行控制命令：/stop /queue /model（dsh 版） */

import type { CommandHandler } from "./types.js";

export const stopCommand: CommandHandler = {
  name: "/stop",
  help: "中断当前任务并清空队列",
  async handle(ctx) {
    ctx.clearTaskTimeout();
    await ctx.clarify?.abort();

    const streamingHere = ctx.streaming?.activeSession?.chatId === ctx.chatId;
    if (streamingHere) await ctx.streaming!.abort("用户已停止当前任务");

    const clearedCount = ctx.queues.pendingFor(ctx.chatId);
    if (streamingHere) ctx.client?.stopTyping(ctx.chatId, false).catch(() => {});
    ctx.queues.reset(ctx.chatId);

    // 取消 dsh agent 的当前轮次（turn/end 到达后 settle 封卡）
    ctx.manager.cancel();

    if (clearedCount > 0) return `已中断当前处理，并清空 ${clearedCount} 条排队消息。`;
    return "已中断当前处理。";
  },
};

export const queueCommand: CommandHandler = {
  name: "/queue",
  help: "查看队列状态",
  async handle(ctx) {
    const active = ctx.streaming?.activeSession?.chatId === ctx.chatId;
    const count = ctx.queues.pendingFor(ctx.chatId);
    if (!active && count === 0) return "队列为空，当前空闲。";

    let reply = ctx.manager.isIdle ? "状态: 空闲" : "状态: 处理中";
    if (count > 0) reply += `\n排队中: ${count} 条消息`;
    return reply;
  },
};

export const modelCommand: CommandHandler = {
  name: "/model",
  help: "查看/切换模型（/model <provider/model>）",
  async handle(ctx) {
    const current = ctx.manager.getEffectiveModel();

    if (!ctx.args.trim()) {
      const models = ctx.manager.listAvailableModels();
      const header = models.length > 0
        ? `可配置模型（settings.yaml，共 ${models.length} 个）:`
        : "settings.yaml 未配置模型列表；请直接指定 provider/model。";
      return [
        current
          ? `当前: ${current.provider}/${current.model}`
          : "当前: （宿主默认模型）",
        "用法: /model <provider>/<model>",
        "示例: /model deepseek/deepseek-chat",
        "",
        header,
        ...models.slice(0, 30).map((m) => `  ${m.provider}/${m.id}${m.name ? ` (${m.name})` : ""}`),
        ...(models.length > 30 ? ["  …（其余省略）"] : []),
      ].join("\n");
    }

    const arg = ctx.args.trim();
    const slash = arg.indexOf("/");
    if (slash <= 0 || slash === arg.length - 1) {
      return "格式错误：请使用 /model <provider>/<model>，如 /model deepseek/deepseek-chat";
    }
    const route = { provider: arg.slice(0, slash), model: arg.slice(slash + 1) };

    try {
      const busyNote = ctx.manager.current && !ctx.manager.isIdle
        ? "\n（当前任务已中断，会话已用新模型重建，可重新发送消息）"
        : "";
      await ctx.manager.setModelOverride(route);
      return `已切换模型: ${route.provider}/${route.model}${busyNote}`;
    } catch (error) {
      return `切换失败：${error instanceof Error ? error.message : String(error)}`;
    }
  },
};