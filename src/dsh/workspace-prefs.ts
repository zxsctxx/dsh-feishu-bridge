/**
 * Feishu chat 的工作区选择持久化。
 * 只保存 workspace id，不保存本机路径和任何凭据。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

interface WorkspacePrefsFile {
  version: 1;
  selections: Record<string, string>;
}

export class WorkspacePrefsStore {
  private readonly prefsPath: string;
  private readonly selections = new Map<string, string>();

  constructor(prefsPath?: string) {
    this.prefsPath = prefsPath ?? resolve(homedir(), ".dsh-feishu-bridge", "workspace-prefs.json");
    this.load();
  }

  get(scopeKey: string): string | undefined {
    return this.selections.get(scopeKey);
  }

  set(scopeKey: string, workspaceId: string): void {
    this.selections.set(scopeKey, workspaceId);
    this.write();
  }

  clear(scopeKey: string): boolean {
    const deleted = this.selections.delete(scopeKey);
    if (deleted) this.write();
    return deleted;
  }

  private load(): void {
    if (!existsSync(this.prefsPath)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.prefsPath, "utf8"));
    } catch (error) {
      throw new Error("工作区偏好文件损坏：" + this.prefsPath, { cause: error });
    }

    const data = parsed as Partial<WorkspacePrefsFile>;
    if (data.version !== 1 || !data.selections || typeof data.selections !== "object") {
      throw new Error("工作区偏好文件版本无效：" + this.prefsPath);
    }

    for (const [scopeKey, workspaceId] of Object.entries(data.selections)) {
      if (typeof workspaceId !== "string" || !workspaceId.trim()) {
        throw new Error("工作区偏好文件包含无效选择：" + scopeKey);
      }
      this.selections.set(scopeKey, workspaceId);
    }
  }

  private write(): void {
    const directory = dirname(this.prefsPath);
    mkdirSync(directory, { recursive: true });
    const tempPath = this.prefsPath + ".tmp-" + process.pid;
    const data: WorkspacePrefsFile = {
      version: 1,
      selections: Object.fromEntries(this.selections.entries()),
    };
    writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tempPath, this.prefsPath);
  }
}
