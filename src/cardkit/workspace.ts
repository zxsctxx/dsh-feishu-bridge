import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkspaceInfo, EffectiveWorkspace } from "../dsh/workspace.js";

export type WorkspaceCardActionName = "use" | "select" | "reset" | "list";
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
export const WORKSPACE_RESET_OPTION = "__workspace_reset__";

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
  if (typeof payload.action !== "string" || !["use", "select", "reset", "list"].includes(payload.action)) throw new Error("工作区卡片操作无效");
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
  const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  const availableRows = rows.filter((row) => row.status === "available");
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      element_id: "workspace-question",
      content: "请选择工作区，当前工作区：" + current.title,
      text_size: "title_2",
    },
    {
      tag: "markdown",
      element_id: "workspace-path",
      content: "当前路径：" + current.path,
      text_size: "notation",
    },
    {
      tag: "markdown",
      content: "切换工作区默认会重置上下文，可通过 `/workspace use <id> --keep-context` 保留上下文切换",
      text_size: "notation",
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: "**A. 恢复默认工作区** · 使用配置中的默认工作区",
      text_size: "notation",
    },
    ...rows.map((row, index) => ({
      tag: "markdown",
      content: `**${letters[index + 1] ?? index + 2}. ${row.title}** · ${row.status === "available" ? "可用" : "目录不可用"}`,
      text_size: "notation",
    })),
    {
      tag: "select_static",
      element_id: "workspace-select",
      options: [
        { value: WORKSPACE_RESET_OPTION, text: { tag: "plain_text", content: "A. 恢复默认工作区" } },
        ...availableRows.map((row) => ({
          value: row.id,
          text: { tag: "plain_text", content: `${letters[rows.indexOf(row) + 1] ?? rows.indexOf(row) + 2}. ${row.title}` },
        })),
      ],
      placeholder: { tag: "plain_text", content: "选择工作区…" },
      value: makeWorkspaceCardPayload(secret, chatId, "select", { mode: "reset" }, now),
    },
  ];
  return { schema: "2.0", body: { elements } };
}
