import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { BridgeConfig, WorkspaceDefinition } from "../config.js";
import { WorkspacePrefsStore } from "./workspace-prefs.js";
import { WorkspaceRegistryError, WorkspaceRegistryStore } from "./workspace-registry.js";

export type WorkspaceSource = "chat" | "default" | "legacy";
export type WorkspaceAvailability = "available" | "missing";

export interface WorkspaceInfo {
  id: string;
  title: string;
  path: string;
  status: WorkspaceAvailability;
}

export interface EffectiveWorkspace extends WorkspaceInfo {
  source: WorkspaceSource;
}

export class WorkspaceError extends Error {}

export class WorkspaceResolver {
  private readonly prefs: WorkspacePrefsStore;
  private readonly registry: WorkspaceRegistryStore;
  private readonly configuredDefinitions: WorkspaceDefinition[];

  constructor(
    private readonly config: BridgeConfig,
    prefsPath?: string,
    private readonly warn?: (message: string) => void,
    registryPath?: string,
  ) {
    this.prefs = new WorkspacePrefsStore(prefsPath);
    this.registry = new WorkspaceRegistryStore(registryPath);
    this.configuredDefinitions = config.workspaces ?? [];
    this.registry.migrate(this.configuredDefinitions);
  }

  scopeKeyFor(chatId: string): string {
    return this.config.appId + ":" + chatId;
  }

  currentSelection(chatId: string): string | undefined {
    return this.prefs.get(this.scopeKeyFor(chatId));
  }

  list(): WorkspaceInfo[] {
    const definitions = this.allDefinitions();
    if (definitions.length === 0) return [this.legacyInfo()];
    return definitions.map((definition) => this.inspectDefinition(definition));
  }

  getEffective(chatId: string): EffectiveWorkspace {
    const selectedId = this.currentSelection(chatId);
    if (selectedId) {
      if (!this.findDefinition(selectedId)) {
        this.prefs.clear(this.scopeKeyFor(chatId));
        this.warn?.("cleared stale workspace preference: chat=" + chatId + " workspace=" + selectedId);
      } else {
        return this.resolveNamed(selectedId, "chat", false);
      }
    }

    const defaultId = this.config.defaultWorkspace;
    if (defaultId) return this.resolveNamed(defaultId, "default", false);

    return { ...this.legacyInfo(), source: "legacy" };
  }

  select(chatId: string, workspaceId: string): EffectiveWorkspace {
    const target = this.resolveNamed(workspaceId, "chat", true);
    this.prefs.set(this.scopeKeyFor(chatId), target.id);
    return target;
  }

  reset(chatId: string): EffectiveWorkspace {
    this.prefs.clear(this.scopeKeyFor(chatId));
    return this.getEffective(chatId);
  }

  registeredWorkspace(workspaceId: string, requireAvailable = true): WorkspaceInfo {
    const definition = this.findDefinition(workspaceId);
    if (!definition) throw new WorkspaceError("未找到工作区：" + workspaceId);
    const info = this.inspectDefinition(definition);
    if (requireAvailable && info.status === "missing") {
      throw new WorkspaceError("工作区目录不可用：" + info.path);
    }
    return info;
  }

  addRuntime(workspaceId: string, path: string, title?: string): WorkspaceInfo {
    const id = workspaceId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new WorkspaceError("工作区 ID 无效：只能使用字母、数字、点、下划线和短横线");
    }
    if (this.findDefinition(id)) throw new WorkspaceError("工作区 ID 已存在：" + id);
    const canonical = this.validateRuntimePath(path);
    const definition: WorkspaceDefinition = { id, path: canonical, ...(title?.trim() ? { title: title.trim() } : {}) };
    try {
      this.registry.add(definition);
    } catch (error) {
      if (error instanceof WorkspaceRegistryError) throw new WorkspaceError(error.message);
      throw error;
    }
    return this.inspectDefinition(definition);
  }

  removeRuntime(workspaceId: string): void {
    if (this.configuredDefinitions.some((definition) => definition.id === workspaceId)) {
      throw new WorkspaceError("配置中的工作区不能运行时删除，请修改 profile 配置：" + workspaceId);
    }
    if (this.prefs.hasWorkspaceSelection(workspaceId)) {
      throw new WorkspaceError("工作区仍被 chat 使用，请先切换或 reset：" + workspaceId);
    }
    try {
      this.registry.remove(workspaceId);
    } catch (error) {
      if (error instanceof WorkspaceRegistryError) throw new WorkspaceError(error.message);
      throw error;
    }
  }

  renameRuntime(workspaceId: string, title: string): WorkspaceInfo {
    if (this.configuredDefinitions.some((definition) => definition.id === workspaceId)) {
      throw new WorkspaceError("配置中的工作区不能运行时重命名，请修改 profile 配置：" + workspaceId);
    }
    const nextTitle = title.trim();
    if (!nextTitle) throw new WorkspaceError("工作区名称不能为空");
    try {
      return this.inspectDefinition(this.registry.rename(workspaceId, nextTitle));
    } catch (error) {
      if (error instanceof WorkspaceRegistryError) throw new WorkspaceError(error.message);
      throw error;
    }
  }

  workspaceIdForPath(path: string): string | "legacy" | undefined {
    for (const definition of this.allDefinitions()) {
      if (this.samePath(path, definition.path)) return definition.id;
    }
    if (this.samePath(path, this.legacyPath())) return "legacy";
    return undefined;
  }

  adoptSessionPath(chatId: string, path: string): EffectiveWorkspace {
    const workspaceId = this.workspaceIdForPath(path);
    if (!workspaceId) throw new WorkspaceError("会话工作区未注册：" + path);
    if (workspaceId === "legacy") this.prefs.clear(this.scopeKeyFor(chatId));
    else this.prefs.set(this.scopeKeyFor(chatId), workspaceId);
    return this.getEffective(chatId);
  }

  matchesPath(left: string, right: string): boolean {
    return this.samePath(left, right);
  }

  private resolveNamed(
    workspaceId: string,
    source: Exclude<WorkspaceSource, "legacy">,
    strict: boolean,
  ): EffectiveWorkspace {
    const info = this.registeredWorkspace(workspaceId, strict);
    return { ...info, source };
  }

  private allDefinitions(): WorkspaceDefinition[] {
    const byId = new Map<string, WorkspaceDefinition>();
    for (const definition of this.configuredDefinitions) byId.set(definition.id, definition);
    for (const definition of this.registry.list()) {
      if (!byId.has(definition.id) && this.runtimeDefinitionAllowed(definition)) byId.set(definition.id, definition);
    }
    return [...byId.values()];
  }

  private runtimeDefinitionAllowed(definition: WorkspaceDefinition): boolean {
    const roots = this.config.workspaceRoots ?? [];
    return roots.some((root) => {
      if (!existsSync(root) || !statSync(root).isDirectory()) return false;
      return this.isWithin(this.canonicalPath(definition.path), this.canonicalPath(root));
    });
  }

  private findDefinition(workspaceId: string): WorkspaceDefinition | undefined {
    return this.allDefinitions().find((definition) => definition.id === workspaceId);
  }

  private inspectDefinition(definition: WorkspaceDefinition): WorkspaceInfo {
    return this.inspect(definition.id, definition.title || definition.id, definition.path);
  }

  private inspect(id: string, title: string, configuredPath: string): WorkspaceInfo {
    const path = resolve(configuredPath || process.cwd());
    if (!existsSync(path)) return { id, title, path, status: "missing" };
    try {
      if (!statSync(path).isDirectory()) return { id, title, path, status: "missing" };
      return { id, title, path: realpathSync.native(path), status: "available" };
    } catch {
      return { id, title, path, status: "missing" };
    }
  }

  private validateRuntimePath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) throw new WorkspaceError("工作区目录不能为空");
    const candidate = resolve(trimmed);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
      throw new WorkspaceError("工作区目录不存在或不是目录：" + candidate);
    }
    const canonical = this.canonicalPath(candidate);
    const roots = this.config.workspaceRoots ?? [];
    if (roots.length === 0) throw new WorkspaceError("未配置 workspaceRoots，禁止运行时注册目录");
    const allowed = roots.some((root) => {
      if (!existsSync(root) || !statSync(root).isDirectory()) return false;
      return this.isWithin(canonical, this.canonicalPath(root));
    });
    if (!allowed) throw new WorkspaceError("目录不在允许的 workspaceRoots 内：" + canonical);
    return canonical;
  }

  private isWithin(candidate: string, root: string): boolean {
    const left = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    const right = process.platform === "win32" ? root.toLowerCase() : root;
    return left === right || left.startsWith(right.endsWith(sep) ? right : right + sep);
  }

  private legacyInfo(): WorkspaceInfo {
    const path = this.legacyPath();
    if (!existsSync(path)) return { id: "default", title: "默认工作区", path, status: "missing" };
    try {
      return {
        id: "default",
        title: "默认工作区",
        path,
        status: statSync(path).isDirectory() ? "available" : "missing",
      };
    } catch {
      return { id: "default", title: "默认工作区", path, status: "missing" };
    }
  }

  private legacyPath(): string {
    return this.config.cwd || process.cwd();
  }

  private samePath(left: string, right: string): boolean {
    const normalizedLeft = this.canonicalPath(left);
    const normalizedRight = this.canonicalPath(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  }

  private canonicalPath(path: string): string {
    const absolute = resolve(path);
    if (existsSync(absolute)) {
      try {
        return realpathSync.native(absolute);
      } catch {
        return absolute;
      }
    }
    return absolute;
  }
}
