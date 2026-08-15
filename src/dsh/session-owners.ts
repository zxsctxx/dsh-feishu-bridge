/**
 * Feishu chat 与 session 的归属索引。
 * /resume 只能看到该索引中的 session，未知历史记录默认拒绝，避免跨 chat 泄露上下文。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

interface SessionOwnersFile {
  version: 1;
  owners: Record<string, string[]>;
}

export class SessionOwnershipStore {
  private readonly filePath: string;
  private readonly owners = new Map<string, Set<string>>();

  constructor(filePath?: string) {
    this.filePath = filePath ?? resolve(homedir(), ".dsh-feishu-bridge", "session-owners.json");
    this.load();
  }

  has(scopeKey: string, sessionId: string): boolean {
    return this.owners.get(scopeKey)?.has(sessionId) ?? false;
  }

  add(scopeKey: string, sessionId: string): void {
    let entries = this.owners.get(scopeKey);
    if (!entries) {
      entries = new Set<string>();
      this.owners.set(scopeKey, entries);
    }
    if (entries.has(sessionId)) return;
    entries.add(sessionId);
    this.write();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new Error("session 归属文件损坏：" + this.filePath, { cause: error });
    }
    const data = parsed as Partial<SessionOwnersFile>;
    if (data.version !== 1 || !data.owners || typeof data.owners !== "object") {
      throw new Error("session 归属文件版本无效：" + this.filePath);
    }
    for (const [scopeKey, ids] of Object.entries(data.owners)) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) {
        throw new Error("session 归属文件包含无效记录：" + scopeKey);
      }
      this.owners.set(scopeKey, new Set(ids));
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = this.filePath + ".tmp-" + process.pid;
    const data: SessionOwnersFile = {
      version: 1,
      owners: Object.fromEntries(
        [...this.owners.entries()].map(([scopeKey, ids]) => [scopeKey, [...ids]]),
      ),
    };
    writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }
}
