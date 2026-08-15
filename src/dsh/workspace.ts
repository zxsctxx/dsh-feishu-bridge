import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { BridgeConfig, WorkspaceDefinition } from "../config.js";
import { WorkspacePrefsStore } from "./workspace-prefs.js";

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
  private readonly definitions: WorkspaceDefinition[];
  private readonly definitionMap: Map<string, WorkspaceDefinition>;

  constructor(
    private readonly config: BridgeConfig,
    prefsPath?: string,
    private readonly warn?: (message: string) => void,
  ) {
    this.prefs = new WorkspacePrefsStore(prefsPath);
    this.definitions = config.workspaces ?? [];
    this.definitionMap = new Map(this.definitions.map((item) => [item.id, item]));
  }

  scopeKeyFor(chatId: string): string {
    return this.config.appId + ":" + chatId;
  }

  currentSelection(chatId: string): string | undefined {
    return this.prefs.get(this.scopeKeyFor(chatId));
  }

  list(): WorkspaceInfo[] {
    if (this.definitions.length === 0) return [this.legacyInfo()];
    return this.definitions.map((definition) => this.inspectDefinition(definition));
  }

  getEffective(chatId: string): EffectiveWorkspace {
    const selectedId = this.currentSelection(chatId);
    if (selectedId) {
      if (!this.definitionMap.has(selectedId)) {
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

  workspaceIdForPath(path: string): string | "legacy" | undefined {
    if (this.samePath(path, this.legacyPath())) return "legacy";
    for (const definition of this.definitions) {
      if (this.samePath(path, definition.path)) return definition.id;
    }
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
    const definition = this.definitionMap.get(workspaceId);
    if (!definition) throw new WorkspaceError("未找到工作区：" + workspaceId);

    const info = this.inspectDefinition(definition);
    if (strict && info.status === "missing") {
      throw new WorkspaceError("工作区目录不可用：" + info.path);
    }
    return { ...info, source };
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
