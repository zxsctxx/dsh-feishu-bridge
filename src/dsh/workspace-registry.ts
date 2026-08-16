/**
 * V2 的 bridge-local workspace registry。
 * 配置中声明的同 ID 工作区始终优先；本地 registry 只保存运行时新增/迁移条目。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { WorkspaceDefinition } from "../config.js";

interface RegistryFile {
  version: 1;
  workspaces: WorkspaceDefinition[];
}

export class WorkspaceRegistryError extends Error {}

export class WorkspaceRegistryStore {
  private readonly filePath: string;
  private readonly entries = new Map<string, WorkspaceDefinition>();
  private loadError?: WorkspaceRegistryError;

  constructor(filePath?: string, deferLoadErrors = false) {
    this.filePath = filePath ?? resolve(homedir(), ".dsh-feishu-bridge", "workspace-registry.json");
    try {
      this.load();
    } catch (error) {
      if (!deferLoadErrors) throw error;
      this.loadError = error instanceof WorkspaceRegistryError
        ? error
        : new WorkspaceRegistryError("工作区 registry 加载失败：" + this.filePath, { cause: error });
    }
  }

  list(): WorkspaceDefinition[] {
    this.ensureHealthy();
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  has(id: string): boolean {
    this.ensureHealthy();
    return this.entries.has(id);
  }

  get(id: string): WorkspaceDefinition | undefined {
    this.ensureHealthy();
    const entry = this.entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  add(definition: WorkspaceDefinition): void {
    this.ensureHealthy();
    if (this.entries.has(definition.id)) {
      throw new WorkspaceRegistryError("运行时工作区已存在：" + definition.id);
    }
    this.entries.set(definition.id, { ...definition });
    this.write();
  }

  remove(id: string): void {
    this.ensureHealthy();
    if (!this.entries.delete(id)) {
      throw new WorkspaceRegistryError("未找到运行时工作区：" + id);
    }
    this.write();
  }

  rename(id: string, title: string): WorkspaceDefinition {
    this.ensureHealthy();
    const current = this.entries.get(id);
    if (!current) throw new WorkspaceRegistryError("未找到运行时工作区：" + id);
    const next = { ...current, title };
    this.entries.set(id, next);
    this.write();
    return { ...next };
  }

  migrate(definitions: WorkspaceDefinition[]): void {
    this.ensureHealthy();
    let changed = false;
    for (const definition of definitions) {
      if (this.entries.has(definition.id)) continue;
      this.entries.set(definition.id, { ...definition });
      changed = true;
    }
    if (changed) this.write();
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
      throw new WorkspaceRegistryError("工作区 registry 文件损坏：" + this.filePath, { cause: error });
    }
    const data = parsed as Partial<RegistryFile>;
    if (data.version !== 1 || !Array.isArray(data.workspaces)) {
      throw new WorkspaceRegistryError("工作区 registry 文件版本无效：" + this.filePath);
    }
    for (const definition of data.workspaces) {
      if (!definition || typeof definition !== "object" || typeof definition.id !== "string"
        || !definition.id.trim() || typeof definition.path !== "string" || !definition.path.trim()) {
        throw new WorkspaceRegistryError("工作区 registry 包含无效条目：" + this.filePath);
      }
      if (this.entries.has(definition.id)) {
        throw new WorkspaceRegistryError("工作区 registry 包含重复 ID：" + definition.id);
      }
      this.entries.set(definition.id, { id: definition.id, path: definition.path, ...(definition.title ? { title: definition.title } : {}) });
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = this.filePath + ".tmp-" + process.pid;
    const data: RegistryFile = { version: 1, workspaces: this.list() };
    writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }
}
