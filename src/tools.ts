/**
 * 暴露给 LLM 的飞书工具（dsh 版，注册进共享 agent 的 scoped ctx.tools）。
 *
 * 目标 chat 的解析顺序：显式参数 → 当前流式会话 → 最近活跃聊天。
 *
 * 注册时机：agents.create / agents.resume 的 setup 回调中通过 agent.ctx 注册，
 * 因此只有共享 agent 能看到这些工具，宿主 Web GUI 会话不受影响。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import type { FeishuClient } from "./feishu-client.js";
import type { BridgeConfig } from "./config.js";
import type { StreamingCardManager } from "./streaming/card-manager.js";
import type { ClarifyManager, ClarifyOption } from "./clarify/manager.js";
import { describeError } from "./log.js";

/** 通过 getter 读取插件的可变状态，避免注册时快照 */
export interface ToolDeps {
  readonly client: FeishuClient | null;
  readonly config: BridgeConfig;
  readonly streaming: StreamingCardManager | null;
  readonly clarify: ClarifyManager | null;
  readonly latestChatId: string | null;
  /** 卡片正文里降一级标题，避免飞书渲染出过大的字号 */
  downgradeHeadings(text: string): string;
}

type ToolResultValue = {
  ok: boolean;
  message: string;
  [key: string]: unknown;
};

/** 渲染工具结果为模型可见文本 */
function renderResult(_args: unknown, value: ToolResultValue): ContentBlock[] {
  return [{ type: "text", text: value.message }];
}

/** 输出 schema：通用对象（ObjectValueSchemaSpec 必须显式 additionalProperties） */
const OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" as const, required: true as const },
    message: { type: "string" as const, required: true as const },
  },
} as const;

/** 解析目标 chat，并确认连接可用；返回 null 表示失败（message 为原因） */
function resolveTarget(
  deps: ToolDeps,
  explicitChatId?: string,
): { chatId: string } | { error: string } {
  if (!deps.client || deps.client.getStatus() !== "connected") {
    return { error: "错误: 飞书 Bot 未连接。" };
  }
  const chatId = explicitChatId || deps.streaming?.activeSession?.chatId || deps.latestChatId;
  if (!chatId) {
    return { error: "错误: 没有活跃的飞书聊天。请先在飞书中发送一条消息。" };
  }
  return { chatId };
}

/** 归一化选项：options 优先，否则 choices 纯字符串转为 {value,label} */
function normalizeOptions(params: { options?: Array<{ value: string; label: string; description?: string }>; choices?: string[] }): ClarifyOption[] {
  if (params.options?.length) {
    return params.options.map((o) => {
      const option: ClarifyOption = { value: o.value, label: o.label };
      if (o.description) option.description = o.description;
      return option;
    });
  }
  return (params.choices ?? []).map((c) => ({ value: c, label: c }));
}

/**
 * 注册飞书工具到传入的 agent scoped context。
 * 由 DshSessionManager 的 setupExtra 在 agent 创建/恢复时调用。
 */
export function registerBridgeTools(agentCtx: Context, deps: ToolDeps): void {
  const register = (def: unknown): void => {
    agentCtx.tools.register(def as Parameters<typeof agentCtx.tools.register>[0]);
  };

  register(defineTool({
    name: "ask_feishu",
    description:
      "通过飞书交互式选择卡片向授权用户澄清问题，并等待其选择。仅当对话通过飞书远程进行时使用（向飞书用户提问）；在本机 Web GUI 会话中请改用 user-questions 能力。",
    parameters: {
      question: { type: "string", description: "需要用户澄清的问题", required: true },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "选项列表（纯文本，兼容旧用法；有 options 时忽略）",
      },
      options: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: { type: "string", description: "选中后返回的值", required: true },
            label: { type: "string", description: "按钮显示文本", required: true },
            description: { type: "string", description: "可选描述，显示在按钮下方" },
          },
        },
        description: "结构化选项（value/label/description）；存在时优先于 choices",
      },
      chat_id: { type: "string", description: "目标聊天 ID；留空使用当前聊天" },
      timeout_seconds: { type: "number", description: "等待秒数，默认使用配置值" },
    },
    output: { schema: OUTPUT, render: renderResult },
    async execute(params, exec) {
      const target = resolveTarget(deps, params.chat_id);
      if ("error" in target) return { ok: false, message: target.error };

      if (!deps.clarify || !params.question) {
        return { ok: false, message: "错误: 澄清管理器不可用或参数不完整。" };
      }
      const options = normalizeOptions(params);
      if (!options.length) {
        return { ok: false, message: "错误: 澄清管理器不可用或参数不完整。" };
      }
      // 澄清卡会等待用户操作，必须遵守 allowlist
      if (deps.config.allowedChatIds?.length && !deps.config.allowedChatIds.includes(target.chatId)) {
        return { ok: false, message: "错误: 目标聊天不在 allowlist 中。" };
      }

      const timeout =
        Math.min(3600, Math.max(5, Number(params.timeout_seconds ?? deps.config.clarifyTimeoutSec ?? 300))) * 1000;
      try {
        const choice = await deps.clarify.ask(
          target.chatId,
          params.question,
          options,
          deps.config.allowedOpenIds ?? [],
          timeout,
          exec.signal,
        );
        return { ok: true, message: `用户选择：${choice}（chat: ${target.chatId}）` };
      } catch (error) {
        return { ok: false, message: `澄清失败：${describeError(error)}（chat: ${target.chatId}）` };
      }
    },
  }));

  register(defineTool({
    name: "send_to_feishu",
    description: "发送消息到飞书聊天界面。当用户要求通过飞书发送消息时使用。",
    parameters: {
      message: { type: "string", description: "要发送的消息内容", required: true },
      chat_id: { type: "string", description: "目标聊天 ID（飞书 chat_id），留空则发送到最近活跃的聊天" },
    },
    output: { schema: OUTPUT, render: renderResult },
    async execute(params) {
      const target = resolveTarget(deps, params.chat_id);
      if ("error" in target) return { ok: false, message: target.error };

      await deps.client!.sendMessage(target.chatId, deps.downgradeHeadings(params.message));
      return { ok: true, message: `已发送到飞书 [${target.chatId}]: ${params.message}` };
    },
  }));

  register(defineTool({
    name: "send_image_to_feishu",
    description: "将本地图片文件上传到飞书并发送。当需要发送图片到飞书聊天时使用。",
    parameters: {
      file_path: { type: "string", description: "本地图片文件路径", required: true },
      chat_id: { type: "string", description: "目标聊天 ID，留空则发送到最近活跃的聊天" },
    },
    output: { schema: OUTPUT, render: renderResult },
    async execute(params) {
      const target = resolveTarget(deps, params.chat_id);
      if ("error" in target) return { ok: false, message: target.error };

      const imageKey = await deps.client!.uploadImage(params.file_path);
      if (!imageKey) return { ok: false, message: "错误: 图片上传失败。" };

      await deps.client!.sendImage(target.chatId, imageKey);
      return { ok: true, message: `图片已发送到飞书 [${target.chatId}]: ${params.file_path}` };
    },
  }));

  register(defineTool({
    name: "send_file_to_feishu",
    description: "将本地文件上传到飞书并发送。当需要发送文件到飞书聊天时使用。",
    parameters: {
      file_path: { type: "string", description: "本地文件路径", required: true },
      file_name: { type: "string", description: "文件名", required: true },
      chat_id: { type: "string", description: "目标聊天 ID，留空则发送到最近活跃的聊天" },
    },
    output: { schema: OUTPUT, render: renderResult },
    async execute(params) {
      const target = resolveTarget(deps, params.chat_id);
      if ("error" in target) return { ok: false, message: target.error };

      const fileKey = await deps.client!.uploadFile(params.file_path, params.file_name);
      if (!fileKey) return { ok: false, message: "错误: 文件上传失败。" };

      await deps.client!.sendFile(target.chatId, fileKey);
      return { ok: true, message: `文件已发送到飞书 [${target.chatId}]: ${params.file_name}` };
    },
  }));
}