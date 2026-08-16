import type { WorkspaceInfo } from "./workspace.js";

/** V3 工作区后端选择；默认 local 保持 V2 行为。 */
export type WorkspaceBackendMode = "local" | "host" | "disabled";
export type WorkspaceBackendState = "local" | "host" | "disabled" | "unavailable";

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

/** V2 本地后端的异步门面；local 实现仍由 WorkspaceResolver 维护。 */
export class LocalWorkspaceBackend implements WorkspaceBackend {
  readonly mode = "local" as const;

  constructor(private readonly resolver: LocalWorkspaceResolverLike) {}

  async list(): Promise<WorkspaceInfo[]> {
    return this.resolver.list();
  }

  async get(id: string): Promise<WorkspaceInfo | undefined> {
    try {
      return await this.resolver.registeredWorkspace(id, false);
    } catch {
      return undefined;
    }
  }

  async resolveByPath(path: string): Promise<WorkspaceInfo | undefined> {
    const id = await this.resolver.workspaceIdForPath(path);
    if (!id || id === "legacy") return undefined;
    return this.get(id);
  }

  async create(path: string, title?: string): Promise<WorkspaceInfo> {
    return this.resolver.addRuntime("host-created", path, title);
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.resolver.removeRuntime(id);
      return true;
    } catch {
      return false;
    }
  }

  async rename(id: string, title: string): Promise<WorkspaceInfo> {
    return this.resolver.renameRuntime(id, title);
  }

  async attachSession(_workspaceId: string, _sessionId: string): Promise<void> {
    // V2 local registry 没有宿主 session membership。
  }
}

/**
 * 宿主 Registry 的 CRUD 适配器。宿主服务不存在或尚未激活时直接报错，
 * 不会把任何写操作降级到 V2 local registry。
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
    if (!this.registry) throw new WorkspaceBackendError("workspaceRegistry 宿主服务不可用，host 模式已 fail-closed");
    return this.registry;
  }
}

/** 显式 host 模式缺少宿主能力时的 fail-closed 后端，禁止静默回退到 local。 */
export class UnavailableWorkspaceBackend implements WorkspaceBackend {
  readonly mode = "host" as const;

  async list(): Promise<WorkspaceInfo[]> {
    throw unavailableError();
  }

  async get(_id: string): Promise<WorkspaceInfo | undefined> {
    throw unavailableError();
  }

  async resolveByPath(_path: string): Promise<WorkspaceInfo | undefined> {
    throw unavailableError();
  }

  async create(_path: string, _title?: string): Promise<WorkspaceInfo> {
    throw unavailableError();
  }

  async delete(_id: string): Promise<boolean> {
    throw unavailableError();
  }

  async rename(_id: string, _title: string): Promise<WorkspaceInfo> {
    throw unavailableError();
  }

  async attachSession(_workspaceId: string, _sessionId: string): Promise<void> {
    throw unavailableError();
  }
}

export class DisabledWorkspaceBackend implements WorkspaceBackend {
  readonly mode = "disabled" as const;

  async list(): Promise<WorkspaceInfo[]> {
    return [];
  }

  async get(_id: string): Promise<WorkspaceInfo | undefined> {
    return undefined;
  }

  async resolveByPath(_path: string): Promise<WorkspaceInfo | undefined> {
    return undefined;
  }

  async create(_path: string, _title?: string): Promise<WorkspaceInfo> {
    throw new WorkspaceBackendError("Workspace 功能已禁用");
  }

  async delete(_id: string): Promise<boolean> {
    return false;
  }

  async rename(_id: string, _title: string): Promise<WorkspaceInfo> {
    throw new WorkspaceBackendError("Workspace 功能已禁用");
  }

  async attachSession(_workspaceId: string, _sessionId: string): Promise<void> {
    throw new WorkspaceBackendError("Workspace 功能已禁用");
  }
}

export interface LocalWorkspaceResolverLike {
  list(): Promise<WorkspaceInfo[]>;
  workspaceIdForPath(path: string): Promise<string | "legacy" | undefined>;
  registeredWorkspace(workspaceId: string, requireAvailable?: boolean): Promise<WorkspaceInfo>;
  addRuntime(workspaceId: string, path: string, title?: string): Promise<WorkspaceInfo>;
  removeRuntime(workspaceId: string): Promise<void>;
  renameRuntime(workspaceId: string, title: string): Promise<WorkspaceInfo>;
}

export function workspaceBackendMode(value: unknown): WorkspaceBackendMode {
  if (value === "host" || value === "disabled") return value;
  return "local";
}

export function workspaceBackendDiagnostic(
  requested: WorkspaceBackendMode,
  hostAvailable = false,
): WorkspaceBackendDiagnostic {
  if (requested === "host") {
    return hostAvailable
      ? { requested, state: "host", message: "Workspace Registry: host/shared" }
      : { requested, state: "unavailable", message: "Workspace Registry: host-unavailable/fail-closed" };
  }
  if (requested === "disabled") {
    return { requested, state: "disabled", message: "Workspace Registry: disabled/legacy" };
  }
  return { requested, state: "local", message: "Workspace Registry: local/v2-fallback" };
}

export function createWorkspaceBackend(
  requested: WorkspaceBackendMode,
  resolver?: LocalWorkspaceResolverLike,
  registry?: WorkspaceRegistryLike,
): WorkspaceBackend {
  if (requested === "disabled") return new DisabledWorkspaceBackend();
  if (requested === "host") return registry ? new HostWorkspaceBackend(registry) : new UnavailableWorkspaceBackend();
  if (!resolver) throw new WorkspaceBackendError("local 模式需要 WorkspaceResolver");
  return new LocalWorkspaceBackend(resolver);
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

function unavailableError(): WorkspaceBackendError {
  return new WorkspaceBackendError("workspaceRegistry 宿主服务不可用，host 模式已 fail-closed");
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
