import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkspaceInfo, EffectiveWorkspace } from "../dsh/workspace.js";

export type WorkspaceCardActionName = "use" | "reset" | "list";
export type WorkspaceCardMode = "reset" | "keep-context";

export interface WorkspaceCardPayload {
  kind: "workspace";
  action: WorkspaceCardActionName;
  chatId: string;
  workspaceId?: string;
  mode?: WorkspaceCardMode;
  expiresAt: number;
  token: string;
}

const CARD_TTL_MS = 10 * 60 * 1000;

function signingText(payload: Omit<WorkspaceCardPayload, "token">): string {
  return [payload.kind, payload.action, payload.chatId, payload.workspaceId ?? "", payload.mode ?? "", String(payload.expiresAt)].join("|");
}

function sign(secret: string, payload: Omit<WorkspaceCardPayload, "token">): string {
  return createHmac("sha256", secret).update(signingText(payload)).digest("hex");
}

export function makeWorkspaceCardPayload(
  secret: string,
  chatId: string,
  action: WorkspaceCardActionName,
  options: { workspaceId?: string; mode?: WorkspaceCardMode } = {},
  now = Date.now(),
): WorkspaceCardPayload {
  const unsigned = {
    kind: "workspace" as const,
    action,
    chatId,
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    expiresAt: now + CARD_TTL_MS,
  };
  return { ...unsigned, token: sign(secret, unsigned) };
}

export function verifyWorkspaceCardPayload(
  secret: string,
  value: Record<string, unknown>,
  actualChatId: string,
  now = Date.now(),
): WorkspaceCardPayload {
  const payload = value as Partial<WorkspaceCardPayload>;
  if (payload.kind !== "workspace" || payload.chatId !== actualChatId) throw new Error("工作区卡片不属于当前 chat");
  if (typeof payload.action !== "string" || !["use", "reset", "list"].includes(payload.action)) throw new Error("工作区卡片操作无效");
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < now) throw new Error("工作区卡片已过期，请重新发送 /workspace");
  if (typeof payload.token !== "string" || !payload.token) throw new Error("工作区卡片签名缺失");
  const unsigned = {
    kind: "workspace" as const,
    action: payload.action as WorkspaceCardActionName,
    chatId: actualChatId,
    ...(typeof payload.workspaceId === "string" ? { workspaceId: payload.workspaceId } : {}),
    ...(payload.mode === "reset" || payload.mode === "keep-context" ? { mode: payload.mode } : {}),
    expiresAt: payload.expiresAt,
  };
  const expected = sign(secret, unsigned);
  const actual = Buffer.from(payload.token);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error("工作区卡片签名无效");
  return { ...unsigned, token: payload.token };
}

export function buildWorkspaceCard(
  secret: string,
  chatId: string,
  current: EffectiveWorkspace,
  rows: WorkspaceInfo[],
  now = Date.now(),
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    { tag: "markdown", content: "**当前工作区**\n" + current.title + " [" + current.id + "]\n路径：" + current.path },
    { tag: "hr" },
  ];
  for (const row of rows) {
    const status = row.status === "available" ? "可用" : "目录不可用";
    elements.push({ tag: "markdown", content: "**" + row.title + "** [" + row.id + "] · " + status + "\n" + row.path });
    if (row.status === "available") {
      elements.push({
        tag: "button",
        text: { tag: "plain_text", content: "切换并重置上下文" },
        type: "default",
        name: "workspace-use-reset-" + row.id,
        value: makeWorkspaceCardPayload(secret, chatId, "use", { workspaceId: row.id, mode: "reset" }, now),
      });
      elements.push({
        tag: "button",
        text: { tag: "plain_text", content: "切换并复制上下文" },
        type: "primary",
        name: "workspace-use-keep-" + row.id,
        value: makeWorkspaceCardPayload(secret, chatId, "use", { workspaceId: row.id, mode: "keep-context" }, now),
      });
    }
  }
  elements.push({
    tag: "button",
    text: { tag: "plain_text", content: "恢复默认工作区" },
    type: "default",
    name: "workspace-reset",
    value: makeWorkspaceCardPayload(secret, chatId, "reset", {}, now),
  });
  return { schema: "2.0", body: { elements } };
}
