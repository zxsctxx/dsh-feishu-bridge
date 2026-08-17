import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { BridgeConfig, WorkspaceDefinition } from "../config.js";
import type { WorkspaceBackend } from "./workspace-backend.js";
import { workspaceBackendErrorMessage } from "./workspace-backend.js";
import { WorkspaceError, type EffectiveWorkspace, type WorkspaceController, type WorkspaceInfo, type WorkspaceResolver } from "./workspace.js";
import { WorkspacePrefsStore } from "./workspace-prefs.js";

interface HostMigrationEntry {
  hostId: string;
  canonicalPath: string;
}

interface HostMigrationFile {
  version: 1;
  mode: "host";
  mappings: Record<string, HostMigrationEntry>;
}

/** V2 alias 到宿主 UUID 的最小持久化映射，不复制宿主实体数据。 */
export class WorkspaceHostMigrationStore {
  private readonly entries = new Map<string, HostMigrationEntry>();
  private loadError?: WorkspaceError;

  constructor(private readonly filePath = resolve(homedir(), ".dsh-feishu-bridge", "workspace-host-migration.json")) {
    try {
      this.load();
    } catch (error) {
      this.loadError = error instanceof WorkspaceError
        ? error
        : new WorkspaceError("宿主 Workspace 映射加载失败：" + this.filePath, { cause: error });
    }
  }

  get(alias: string): HostMigrationEntry | undefined {
    this.ensureHealthy();
    const entry = this.entries.get(alias);
    return entry ? { ...entry } : undefined;
  }

  findAlias(hostId: string): string | undefined {
    this.ensureHealthy();
    for (const [alias, entry] of this.entries) if (entry.hostId === hostId) return alias;
    return undefined;
  }

  set(alias: string, entry: HostMigrationEntry): void {
    this.ensureHealthy();
    this.entries.set(alias, { ...entry });
    this.write();
  }

  delete(alias: string): boolean {
    this.ensureHealthy();
    const deleted = this.entries.delete(alias);
    if (deleted) this.write();
    return deleted;
  }

  list(): Array<{ alias: string; entry: HostMigrationEntry }> {
    this.ensureHealthy();
    return [...this.entries.entries()].map(([alias, entry]) => ({ alias, entry: { ...entry } }));
  }

  private ensureHealthy(): void {
    if (this.loadError) throw this.loadError;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new WorkspaceError("宿主 Workspace 映射文件损坏：" + this.filePath, { cause: error });
    }
    const data = parsed as Partial<HostMigrationFile>;
    if (data.version !== 1 || data.mode !== "host" || !data.mappings || typeof data.mappings !== "object") {
      throw new WorkspaceError("宿主 Workspace 映射文件版本无效：" + this.filePath);
    }
    for (const [alias, value] of Object.entries(data.mappings)) {
      if (!alias.trim() || !value || typeof value !== "object"
        || typeof value.hostId !== "string" || !value.hostId.trim()
        || typeof value.canonicalPath !== "string" || !value.canonicalPath.trim()) {
        throw new WorkspaceError("宿主 Workspace 映射包含无效条目：" + alias);
      }
      this.entries.set(alias, { hostId: value.hostId, canonicalPath: value.canonicalPath });
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = this.filePath + ".tmp-" + process.pid;
    const data: HostMigrationFile = {
      version: 1,
      mode: "host",
      mappings: Object.fromEntries(this.entries.entries()),
    };
    writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }
}

/**
 * 使用宿主 Registry 的异步 Workspace Resolver。
 * localResolver 仅作为 V2 只读迁移源，host 模式不会调用其配置迁移写入。
 */
export class HostWorkspaceResolver implements WorkspaceController {
  private readonly prefs: WorkspacePrefsStore;
  private readonly localResolver: WorkspaceResolver;
  private readonly migration: WorkspaceHostMigrationStore;
  private readonly configuredDefinitions: WorkspaceDefinition[];
  /** 同实例迁移互斥：并发 list/getEffective/attach 共享同一次迁移，避免重复 create/写映射。 */
  private migrationPromise?: Promise<void>;

  constructor(
    private readonly config: BridgeConfig,
    private readonly backend: WorkspaceBackend,
    prefsPath: string | undefined,
    localResolver: WorkspaceResolver,
    private readonly warn: ((message: string) => void) | undefined,
    migrationPath?: string,
  ) {
    this.prefs = new WorkspacePrefsStore(prefsPath);
    this.localResolver = localResolver;
    this.migration = new WorkspaceHostMigrationStore(migrationPath);
    this.configuredDefinitions = config.workspaces ?? [];
  }

  currentSelection(chatId: string): string | undefined {
    return this.prefs.get(this.scopeKeyFor(chatId));
  }

  async list(): Promise<WorkspaceInfo[]> {
    await this.migrate(false);
    return this.withAliases(await this.backend.list());
  }

  async getEffective(chatId: string): Promise<EffectiveWorkspace> {
    await this.migrate(false);
    const selectedId = this.currentSelection(chatId);
    if (selectedId) {
      const selected = await this.resolveNamed(selectedId, "chat", false);
      if (selected) return selected;
      throw new WorkspaceError("未找到宿主工作区选择：" + selectedId + "，请联系管理员修复迁移映射");
    }

    const defaultId = this.config.defaultWorkspace;
    if (defaultId) {
      const selected = await this.resolveNamed(defaultId, "default", false);
      if (selected) return selected;
    }

    const legacy = this.legacyInfo();
    return { ...legacy, source: "legacy" };
  }

  async select(chatId: string, workspaceId: string): Promise<EffectiveWorkspace> {
    const target = await this.registeredWorkspace(workspaceId, true);
    this.prefs.set(this.scopeKeyFor(chatId), target.id);
    return { ...target, source: "chat" };
  }

  async reset(chatId: string): Promise<EffectiveWorkspace> {
    this.prefs.clear(this.scopeKeyFor(chatId));
    return this.getEffective(chatId);
  }

  async registeredWorkspace(workspaceId: string, requireAvailable = true): Promise<WorkspaceInfo> {
    const resolved = await this.resolveId(workspaceId);
    if (!resolved) throw new WorkspaceError("未找到宿主工作区：" + workspaceId);
    if (requireAvailable && resolved.status === "missing") throw new WorkspaceError("工作区目录不可用：" + resolved.path);
    return resolved;
  }

  async addRuntime(workspaceAlias: string, path: string, title?: string): Promise<WorkspaceInfo> {
    const alias = workspaceAlias.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) throw new WorkspaceError("工作区 alias 无效：只能使用字母、数字、点、下划线和短横线");
    if (this.migration.get(alias)) throw new WorkspaceError("工作区 alias 已存在：" + alias);
    const canonical = this.validateRuntimePath(path);
    try {
      const existing = await this.backend.resolveByPath(canonical);
      const created = existing ?? await this.backend.create(canonical, title?.trim() || alias);
      const previousAlias = this.migration.findAlias(created.id);
      if (previousAlias && previousAlias !== alias) {
        throw new WorkspaceError("宿主工作区已绑定其他 alias：" + previousAlias);
      }
      this.migration.set(alias, { hostId: created.id, canonicalPath: created.path });
      return { ...created, alias };
    } catch (error) {
      throw new WorkspaceError("宿主工作区注册失败：" + workspaceBackendErrorMessage(error), { cause: error });
    }
  }

  async removeRuntime(workspaceId: string): Promise<void> {
    if (this.configuredDefinitions.some((definition) => definition.id === workspaceId)) {
      throw new WorkspaceError("配置中的工作区不能运行时删除，请修改 profile 配置：" + workspaceId);
    }
    const target = await this.registeredWorkspace(workspaceId, false);
    if (target.alias && this.configuredDefinitions.some((definition) => definition.id === target.alias)) {
      throw new WorkspaceError("配置中的工作区不能运行时删除，请修改 profile 配置：" + target.alias);
    }
    if (this.prefsHasWorkspace(target.id)) throw new WorkspaceError("工作区仍被 chat 使用，请先切换或 reset：" + target.id);
    try {
      const deleted = await this.backend.delete(target.id);
      if (!deleted) throw new WorkspaceError("未找到宿主工作区：" + target.id);
      const alias = target.alias ?? this.migration.findAlias(target.id);
      if (alias) this.migration.delete(alias);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("宿主工作区删除失败：" + workspaceBackendErrorMessage(error), { cause: error });
    }
  }

  async renameRuntime(workspaceId: string, title: string): Promise<WorkspaceInfo> {
    if (this.configuredDefinitions.some((definition) => definition.id === workspaceId)) {
      throw new WorkspaceError("配置中的工作区不能运行时重命名，请修改 profile 配置：" + workspaceId);
    }
    const nextTitle = title.trim();
    if (!nextTitle) throw new WorkspaceError("工作区名称不能为空");
    const target = await this.registeredWorkspace(workspaceId, false);
    try {
      return { ...(await this.backend.rename(target.id, nextTitle)), ...(target.alias ? { alias: target.alias } : {}) };
    } catch (error) {
      throw new WorkspaceError("宿主工作区重命名失败：" + workspaceBackendErrorMessage(error), { cause: error });
    }
  }

  async workspaceIdForPath(path: string): Promise<string | "legacy" | undefined> {
    if (!existsSync(path) || !statSync(path).isDirectory()) return undefined;
    const target = await this.backend.resolveByPath(path);
    if (target) return target.id;
    return this.matchesPath(path, this.config.cwd) ? "legacy" : undefined;
  }

  async adoptSessionPath(chatId: string, path: string): Promise<EffectiveWorkspace> {
    const workspaceId = await this.workspaceIdForPath(path);
    if (!workspaceId) throw new WorkspaceError("会话工作区未注册：" + path);
    if (workspaceId === "legacy") this.prefs.clear(this.scopeKeyFor(chatId));
    else this.prefs.set(this.scopeKeyFor(chatId), workspaceId);
    return this.getEffective(chatId);
  }

  async attachSession(workspaceId: string, sessionId: string): Promise<void> {
    await this.migrate(false);
    const target = await this.resolveId(workspaceId);
    if (!target) throw new WorkspaceError("未找到宿主工作区：" + workspaceId);
    await this.backend.attachSession(target.id, sessionId);
  }

  matchesPath(left: string, right: string): boolean {
    return canonicalForCompare(left) === canonicalForCompare(right);
  }

  private async migrate(forceWrite: boolean): Promise<void> {
    const mode = this.config.workspaceMigration ?? "disabled";
    if (!forceWrite && mode === "disabled") return;
    // 同实例并发只启动一次迁移；失败后清空，允许后续调用重试，但绝不 fallback local。
    if (!this.migrationPromise) {
      this.migrationPromise = this.runMigration(mode).catch((error) => {
        this.migrationPromise = undefined;
        throw error;
      });
    }
    return this.migrationPromise;
  }

  private async runMigration(mode: "disabled" | "read-only" | "write"): Promise<void> {
    const sources = await this.localResolver.list();
    for (const source of sources) {
      if (source.status === "missing") continue;
      const canonicalPath = canonicalForCompare(source.path);
      const existing = this.migration.get(source.id);
      if (existing) {
        if (canonicalForCompare(existing.canonicalPath) !== canonicalPath) {
          throw new WorkspaceError("宿主 Workspace 映射路径已变化，需要人工修复：" + source.id);
        }
        const host = await this.backend.get(existing.hostId);
        if (host) continue;
      }
      const host = await this.backend.resolveByPath(source.path);
      if (host) {
        if (mode === "write") this.migration.set(source.id, { hostId: host.id, canonicalPath: host.path });
        continue;
      }
      if (mode !== "write") continue;
      const created = await this.backend.create(source.path, source.title);
      this.migration.set(source.id, { hostId: created.id, canonicalPath: created.path });
    }
    if (mode === "write") {
      this.prefs.migrateIds(new Map(this.migration.list().map(({ alias, entry }) => [alias, entry.hostId])));
    }
  }

  private async resolveId(idOrAlias: string): Promise<WorkspaceInfo | undefined> {
    const direct = await this.backend.get(idOrAlias);
    if (direct) return this.addAlias(direct);
    const mapping = this.migration.get(idOrAlias);
    if (!mapping) {
      // 便捷查找：defaultWorkspace / /workspace use 也可直接写宿主工作区标题。
      // 标题不是唯一键，存在重名时取宿主列表顺序中的第一个。
      const rows = await this.backend.list();
      const byTitle = rows.find((row) => row.title === idOrAlias);
      return byTitle ? this.addAlias(byTitle) : undefined;
    }
    const mapped = await this.backend.get(mapping.hostId);
    if (!mapped) return undefined;
    if (!this.matchesPath(mapped.path, mapping.canonicalPath)) throw new WorkspaceError("宿主 Workspace 映射路径不一致：" + idOrAlias);
    return { ...mapped, alias: idOrAlias };
  }

  private async resolveNamed(id: string, source: "chat" | "default", _strict: boolean): Promise<EffectiveWorkspace | undefined> {
    const info = await this.resolveId(id);
    return info ? { ...info, source } : undefined;
  }

  private async withAliases(rows: WorkspaceInfo[]): Promise<WorkspaceInfo[]> {
    return rows.map((row) => this.addAlias(row));
  }

  private addAlias(row: WorkspaceInfo): WorkspaceInfo {
    const alias = this.migration.findAlias(row.id);
    return alias ? { ...row, alias } : row;
  }

  private prefsHasWorkspace(id: string): boolean {
    return this.prefs.hasWorkspaceSelection(id) || this.migration.list().some(({ alias }) => this.prefs.hasWorkspaceSelection(alias));
  }

  private validateRuntimePath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) throw new WorkspaceError("工作区目录不能为空");
    const candidate = resolve(trimmed);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) throw new WorkspaceError("工作区目录不存在或不是目录：" + candidate);
    const canonical = realpathSync.native(candidate);
    const roots = this.config.workspaceRoots ?? [];
    if (roots.length === 0) throw new WorkspaceError("未配置 workspaceRoots，禁止运行时注册目录");
    const allowed = roots.some((root) => {
      if (!existsSync(root) || !statSync(root).isDirectory()) return false;
      return isWithin(canonical, realpathSync.native(root));
    });
    if (!allowed) throw new WorkspaceError("目录不在允许的 workspaceRoots 内：" + canonical);
    return canonical;
  }

  private legacyInfo(): WorkspaceInfo {
    return { id: "default", title: "默认工作区", path: this.config.cwd, status: "available" };
  }

  private scopeKeyFor(chatId: string): string {
    return this.config.appId + ":" + chatId;
  }
}

/** disabled 模式只保留 legacy cwd，不注册、选择或修改 Workspace。 */
export class DisabledWorkspaceResolver implements WorkspaceController {
  constructor(private readonly config: BridgeConfig) {}

  currentSelection(_chatId: string): string | undefined {
    return undefined;
  }

  async list(): Promise<WorkspaceInfo[]> {
    return [this.legacyInfo()];
  }

  async getEffective(_chatId: string): Promise<EffectiveWorkspace> {
    return { ...this.legacyInfo(), source: "legacy" };
  }

  async select(_chatId: string, _workspaceId: string): Promise<EffectiveWorkspace> {
    throw new WorkspaceError("Workspace 功能已禁用");
  }

  async reset(_chatId: string): Promise<EffectiveWorkspace> {
    return this.getEffective(_chatId);
  }

  async registeredWorkspace(workspaceId: string, requireAvailable = true): Promise<WorkspaceInfo> {
    if (workspaceId !== "default") throw new WorkspaceError("Workspace 功能已禁用");
    const info = this.legacyInfo();
    if (requireAvailable && info.status === "missing") throw new WorkspaceError("工作区目录不可用：" + info.path);
    return info;
  }

  async addRuntime(_workspaceId: string, _path: string, _title?: string): Promise<WorkspaceInfo> {
    throw new WorkspaceError("Workspace 功能已禁用");
  }

  async removeRuntime(_workspaceId: string): Promise<void> {
    throw new WorkspaceError("Workspace 功能已禁用");
  }

  async renameRuntime(_workspaceId: string, _title: string): Promise<WorkspaceInfo> {
    throw new WorkspaceError("Workspace 功能已禁用");
  }

  async workspaceIdForPath(path: string): Promise<string | "legacy" | undefined> {
    return this.matchesPath(path, this.config.cwd) ? "legacy" : undefined;
  }

  async adoptSessionPath(chatId: string, path: string): Promise<EffectiveWorkspace> {
    if (!(await this.workspaceIdForPath(path))) throw new WorkspaceError("会话工作区未注册：" + path);
    return this.getEffective(chatId);
  }

  async attachSession(_workspaceId: string, _sessionId: string): Promise<void> {
    throw new WorkspaceError("Workspace 功能已禁用");
  }

  matchesPath(left: string, right: string): boolean {
    return canonicalForCompare(left) === canonicalForCompare(right);
  }

  private legacyInfo(): WorkspaceInfo {
    const path = this.config.cwd;
    return { id: "default", title: "默认工作区", path, status: existsSync(path) && statSync(path).isDirectory() ? "available" : "missing" };
  }
}

function isWithin(candidate: string, root: string): boolean {
  const left = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const right = process.platform === "win32" ? root.toLowerCase() : root;
  return left === right || left.startsWith(right.endsWith(sep) ? right : right + sep);
}

function canonicalForCompare(path: string): string {
  const normalized = resolve(path).replace(/[\\/]$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

