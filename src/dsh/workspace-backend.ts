import type { WorkspaceInfo } from "./workspace.js";

/** V3 工作区后端：固定使用宿主 workspaceRegistry。 */
export type WorkspaceBackendMode = "host";
export type WorkspaceBackendState = "host" | "unavailable";

export interface WorkspaceBackendDiagnostic {
  requested: WorkspaceBackendMode;
  state: WorkspaceBackendState;
  message: string;
}

/**
 * 只声明宿主 Registry 的最小结构，避免 bridge 对可选 workspace 包产生运行时依赖。
 * Entity 只在适配器内读取叶子字段，不跨边界序列化 live 对象。
 */
export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceEntityLike[];
  get(id: string): WorkspaceEntityLike | undefined;
  resolveByPath(path: string): Promise<WorkspaceEntityLike | undefined>;
  create(path: string, title?: string): Promise<WorkspaceEntityLike>;
  delete(id: string): Promise<boolean>;
}

export interface WorkspaceEntityLike {
  id: string;
  path: string;
  title?: string;
  sessionIds?: readonly string[];
  setTitle?(title: string): Promise<void>;
  attachSession?(sessionId: string): Promise<void>;
  status?(): Promise<"ok" | "missing-dir">;
}

export interface WorkspaceBackend {
  readonly mode: WorkspaceBackendMode;
  list(): Promise<WorkspaceInfo[]>;
  get(id: string): Promise<WorkspaceInfo | undefined>;
  resolveByPath(path: string): Promise<WorkspaceInfo | undefined>;
  create(path: string, title?: string): Promise<WorkspaceInfo>;
  delete(id: string): Promise<boolean>;
  rename(id: string, title: string): Promise<WorkspaceInfo>;
  attachSession(workspaceId: string, sessionId: string): Promise<void>;
}

export class WorkspaceBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBackendError";
  }
}

/**
 * 宿主 Registry 的 CRUD 适配器。宿主服务不存在或尚未激活时直接报错，
 * 不会回退到任何本地/V2 工作区。
 */
export class HostWorkspaceBackend implements WorkspaceBackend {
  readonly mode = "host" as const;
  private registry?: WorkspaceRegistryLike;

  constructor(registry?: WorkspaceRegistryLike) {
    this.registry = registry;
  }

  setRegistry(registry: WorkspaceRegistryLike | undefined): void {
    this.registry = registry;
  }

  async list(): Promise<WorkspaceInfo[]> {
    const registry = this.requireRegistry();
    return Promise.all(registry.list().map((entity) => toWorkspaceInfo(entity)));
  }

  async get(id: string): Promise<WorkspaceInfo | undefined> {
    const entity = this.requireRegistry().get(id);
    return entity ? toWorkspaceInfo(entity) : undefined;
  }

  async resolveByPath(path: string): Promise<WorkspaceInfo | undefined> {
    const entity = await this.requireRegistry().resolveByPath(path);
    return entity ? toWorkspaceInfo(entity) : undefined;
  }

  async create(path: string, title?: string): Promise<WorkspaceInfo> {
    return toWorkspaceInfo(await this.requireRegistry().create(path, title));
  }

  async delete(id: string): Promise<boolean> {
    return this.requireRegistry().delete(id);
  }

  async rename(id: string, title: string): Promise<WorkspaceInfo> {
    const entity = this.requireRegistry().get(id);
    if (!entity) throw new WorkspaceBackendError("未找到宿主工作区：" + id);
    if (!entity.setTitle) throw new WorkspaceBackendError("宿主 Workspace 不支持重命名：" + id);
    await entity.setTitle(title);
    return toWorkspaceInfo(entity);
  }

  async attachSession(workspaceId: string, sessionId: string): Promise<void> {
    const registry = this.requireRegistry();
    const entity = registry.get(workspaceId);
    if (!entity) throw new WorkspaceBackendError("未找到宿主工作区：" + workspaceId);
    if (!entity.attachSession) throw new WorkspaceBackendError("宿主 Workspace 不支持 session attach：" + workspaceId);
    // 唯一归属：同一 session 不得同时属于两个 Workspace；发现冲突直接拒绝，
    // 不自动 detach 其他实体（归属修复属于显式流程）。
    for (const other of registry.list()) {
      if (other.id === workspaceId) continue;
      if (other.sessionIds?.includes(sessionId)) {
        throw new WorkspaceBackendError(`会话已归属其他工作区：session=${sessionId} 已存在于 workspace=${other.id}`);
      }
    }
    await entity.attachSession(sessionId);
  }

  private requireRegistry(): WorkspaceRegistryLike {
    if (!this.registry) throw new WorkspaceBackendError("workspaceRegistry 宿主服务不可用，已 fail-closed");
    return this.registry;
  }
}

export function workspaceBackendDiagnostic(hostAvailable: boolean): WorkspaceBackendDiagnostic {
  return hostAvailable
    ? { requested: "host", state: "host", message: "Workspace Registry: host/shared" }
    : { requested: "host", state: "unavailable", message: "Workspace Registry: host-unavailable/fail-closed" };
}

async function toWorkspaceInfo(entity: WorkspaceEntityLike): Promise<WorkspaceInfo> {
  const status = entity.status ? await entity.status() : "ok";
  return {
    id: entity.id,
    title: entity.title || entity.id,
    path: entity.path,
    status: status === "ok" ? "available" : "missing",
    ...(entity.sessionIds ? { sessionIds: [...entity.sessionIds] } : {}),
  };
}

export function isWorkspaceRegistryLike(value: unknown): value is WorkspaceRegistryLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceRegistryLike>;
  return typeof candidate.list === "function"
    && typeof candidate.get === "function"
    && typeof candidate.resolveByPath === "function"
    && typeof candidate.create === "function"
    && typeof candidate.delete === "function";
}

export function asWorkspaceRegistryLike(value: unknown): WorkspaceRegistryLike | undefined {
  return isWorkspaceRegistryLike(value) ? value : undefined;
}

export function workspaceBackendErrorMessage(error: unknown): string {
  return error instanceof WorkspaceBackendError ? error.message : error instanceof Error ? error.message : String(error);
}