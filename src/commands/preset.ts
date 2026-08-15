/**
 * Agent 预设命令：/preset（dsh 版）
 *
 * /preset              查看当前生效预设（含来源）与可用列表
 * /preset <id>         切换本 chat 的预设（保存 per-chat 偏好，fork 保留上下文）
 * /preset default      查看全局默认预设
 * /preset default <id> 设置全局默认预设（作用于未单独设置偏好的 chat）
 * /preset default clear 清除全局默认预设
 */

import type { CommandContext, CommandHandler } from "./types.js";

const SOURCE_LABEL: Record<string, string> = {
  "per-chat": "本 chat 偏好",
  global: "全局默认",
  config: "配置(preset)",
  host: "宿主默认",
};

export const presetCommand: CommandHandler = {
  name: "/preset",
  help: "查看/切换 Agent 预设（/preset [id]；/preset default [id] 设全局默认）",
  async handle(ctx) {
    const arg = ctx.args.trim();

    // ── /preset default [id|clear]：全局默认 ──
    if (arg === "default" || arg.startsWith("default ")) {
      const rest = arg.slice("default".length).trim();
      if (!rest) {
        const current = ctx.manager.getDefaultPresetPref();
        return current
          ? `当前全局默认预设: ${current}\n（作用于未单独设置预设偏好的 chat）`
          : "未设置全局默认预设。\n（回落顺序: config.preset → 宿主默认）";
      }
      if (rest === "clear") {
        ctx.manager.setDefaultPreset(undefined);
        return "已清除全局默认预设。\n（回落顺序: config.preset → 宿主默认）";
      }
      const resolved = await ctx.manager.resolvePresetId(rest);
      if (!resolved) return `预设不存在: ${rest}\n（用 /preset 查看可用预设列表）`;
      ctx.manager.setDefaultPreset(resolved);
      return `已设置全局默认预设: ${resolved}。\n下次该 chat 新建会话时将生效（已有 per-chat 偏好的 chat 除外）。`;
    }

    // ── /preset <id>：切换本 chat ──
    if (arg) {
      const result = await ctx.manager.switchPreset(ctx.chatId, arg);
      return result.message;
    }

    // ── /preset：查看 ──
    const current = ctx.manager.currentPreset(ctx.chatId);
    const perChat = ctx.manager.getChatPresetPref(ctx.chatId);
    const global = ctx.manager.getDefaultPresetPref();
    const configPreset = ctx.config.preset;
    const hostDefault = ctx.manager.hostDefaultPresetId;

    const lines: string[] = [];
    lines.push(`当前预设: ${current.presetId ?? "（宿主未指定默认）"}`);
    lines.push(`来源: ${SOURCE_LABEL[current.source] ?? current.source}`);
    if (perChat) lines.push(`- 本 chat 偏好: ${perChat}`);
    if (global) lines.push(`- 全局默认: ${global}`);
    if (configPreset) lines.push(`- 配置预设: ${configPreset}`);
    if (hostDefault) lines.push(`- 宿主默认: ${hostDefault}`);
    lines.push("");
    lines.push("用法: /preset <id> 切换本 chat；/preset default <id> 设全局默认；/preset default clear 清除");

    const presets = await ctx.manager.listAvailablePresets();
    lines.push("");
    if (presets.length > 0) {
      lines.push(`可用预设（共 ${presets.length} 个）:`);
      for (const p of presets) {
        const mark = p.id === current.presetId ? " ※" : "";
        const name = p.name && p.name !== p.id ? ` - ${p.name}` : "";
        lines.push(`  ${p.id}${mark}${name}`);
      }
    } else {
      lines.push("（宿主未枚举到可用预设）");
    }
    return lines.join("\n");
  },
};