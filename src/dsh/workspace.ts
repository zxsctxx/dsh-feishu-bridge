export type WorkspaceSource = "chat" | "default";
export type WorkspaceAvailability = "available" | "missing";

export interface WorkspaceInfo {
  id: string;
  title: string;
  path: string;
  status: WorkspaceAvailability;
  /** 宿主 header 校验后的 session membership。 */
  sessionIds?: string[];
}

export interface EffectiveWorkspace extends WorkspaceInfo {
  source: WorkspaceSource;
}

/** 宿主 Resolver 使用的异步业务接口。 */
export interface WorkspaceController {
  currentSelection(chatId: string): string | undefined;
  list(): Promise<WorkspaceInfo[]>;
  getEffective(chatId: string): Promise<EffectiveWorkspace>;
  select(chatId: string, workspaceId: string): Promise<EffectiveWorkspace>;
  reset(chatId: string): Promise<EffectiveWorkspace>;
  registeredWorkspace(workspaceId: string, requireAvailable?: boolean): Promise<WorkspaceInfo>;
  addRuntime(workspaceId: string, path: string, title?: string): Promise<WorkspaceInfo>;
  removeRuntime(workspaceId: string): Promise<void>;
  renameRuntime(workspaceId: string, title: string): Promise<WorkspaceInfo>;
  workspaceIdForPath(path: string): Promise<string | undefined>;
  adoptSessionPath(chatId: string, path: string): Promise<EffectiveWorkspace>;
  attachSession(workspaceId: string, sessionId: string): Promise<void>;
  matchesPath(left: string, right: string): boolean;
}

export class WorkspaceError extends Error {}