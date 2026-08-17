import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { BridgeConfig } from "../config.js";
import type { WorkspaceBackend } from "./workspace-backend.js";
import { workspaceBackendErrorMessage } from "./workspace-backend.js";
import { WorkspaceError, type EffectiveWorkspace, type WorkspaceController, type WorkspaceInfo } from "./workspace.js";
import { WorkspacePrefsStore } from "./workspace-prefs.js";

/**
 * 只使用宿主 Registry 的异步 Workspace Resolver（V3-only）。
 * 不做本地/V2 注册、不做 legacy cwd 回退、不做迁移。
 */
export class HostWorkspaceResolver implements WorkspaceController {
  private readonly prefs: WorkspacePrefsStore;

  constructor(
    private readonly config: BridgeConfig,
    private readonly backend: WorkspaceBackend,
    prefsPath?: string,
    private readonly warn?: (message: string) => void,
  ) {
    this.prefs = new WorkspacePrefsStore(prefsPath);
  }

  currentSelection(chatId: string): string | undefined {
    return this.prefs.get(this.scopeKeyFor(chatId));
  }

  async list(): Promise<WorkspaceInfo[]> {
    return this.backend.list();
  }

  async getEffective(chatId: string): Promise<EffectiveWorkspace> {
    const selectedId = this.currentSelection(chatId);
    if (selectedId) {
      const selected = await this.resolveNamed(selectedId, "chat", false);
      if (selected) return selected;
      this.prefs.clear(this.scopeKeyFor(chatId));
      this.warn?.("cleared stale workspace preference: chat=" + chatId + " workspace=" + selectedId);
    }

    const defaultId = this.config.defaultWorkspace;
    if (defaultId) {
      const selected = await this.resolveNamed(defaultId, "default", false);
      if (selected) return selected;
    }

    const rows = await this.backend.list();
    const fallback = rows.find((row) => row.status === "available") ?? rows[0];
    if (!fallback) throw new WorkspaceError("宿主没有可用工作区");
    return { ...fallback, source: "default" };
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

  async addRuntime(workspaceId: string, path: string, title?: string): Promise<WorkspaceInfo> {
    const id = workspaceId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new WorkspaceError("工作区 ID 无效：只能使用字母、数字、点、下划线和短横线");
    }
    const canonical = this.validateRuntimePath(path);
    try {
      const existing = await this.backend.resolveByPath(canonical);
      return existing ?? await this.backend.create(canonical, title?.trim() || id);
    } catch (error) {
      throw new WorkspaceError("宿主工作区注册失败：" + workspaceBackendErrorMessage(error), { cause: error });
    }
  }

  async removeRuntime(workspaceId: string): Promise<void> {
    const target = await this.registeredWorkspace(workspaceId, false);
    if (this.prefsHasWorkspace(target.id) || this.prefsHasWorkspace(target.title)) {
      throw new WorkspaceError("工作区仍被 chat 使用，请先切换或 reset：" + target.id);
    }
    try {
      const deleted = await this.backend.delete(target.id);
      if (!deleted) throw new WorkspaceError("未找到宿主工作区：" + target.id);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("宿主工作区删除失败：" + workspaceBackendErrorMessage(error), { cause: error });
    }
  }

  async renameRuntime(workspaceId: string, title: string): Promise<WorkspaceInfo> {
    const nextTitle = title.trim();
    if (!nextTitle) throw new WorkspaceError("工作区名称不能为空");
    const target = await this.registeredWorkspace(workspaceId, false);
    try {
      return await this.backend.rename(target.id, nextTitle);
    } catch (error) {
      throw new WorkspaceError("宿主工作区重命名失败：" + workspaceBackendErrorMessage(error), { cause: error });
    }
  }

  async workspaceIdForPath(path: string): Promise<string | undefined> {
    if (!existsSync(path) || !statSync(path).isDirectory()) return undefined;
    const target = await this.backend.resolveByPath(path);
    return target?.id;
  }

  async adoptSessionPath(chatId: string, path: string): Promise<EffectiveWorkspace> {
    const workspaceId = await this.workspaceIdForPath(path);
    if (!workspaceId) throw new WorkspaceError("会话工作区未注册：" + path);
    this.prefs.set(this.scopeKeyFor(chatId), workspaceId);
    return this.getEffective(chatId);
  }

  async attachSession(workspaceId: string, sessionId: string): Promise<void> {
    const target = await this.resolveId(workspaceId);
    if (!target) throw new WorkspaceError("未找到宿主工作区：" + workspaceId);
    await this.backend.attachSession(target.id, sessionId);
  }

  matchesPath(left: string, right: string): boolean {
    return canonicalForCompare(left) === canonicalForCompare(right);
  }

  private async resolveId(idOrTitle: string): Promise<WorkspaceInfo | undefined> {
    const direct = await this.backend.get(idOrTitle);
    if (direct) return direct;
    // 便捷查找：defaultWorkspace / /workspace use 也可直接写宿主工作区标题。
    // 标题不是唯一键，存在重名时取宿主列表顺序中的第一个。
    const rows = await this.backend.list();
    return rows.find((row) => row.title === idOrTitle);
  }

  private async resolveNamed(id: string, source: "chat" | "default", _strict: boolean): Promise<EffectiveWorkspace | undefined> {
    const info = await this.resolveId(id);
    return info ? { ...info, source } : undefined;
  }

  private prefsHasWorkspace(id: string): boolean {
    return this.prefs.hasWorkspaceSelection(id);
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

  private scopeKeyFor(chatId: string): string {
    return this.config.appId + ":" + chatId;
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