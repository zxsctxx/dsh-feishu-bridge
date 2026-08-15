/**
 * PrefsStore — per-chat 模型偏好持久化（移植自 dsh-qqbot）
 *
 * 隔离文件 I/O 操作，便于单元测试时 mock。
 * 存储路径：~/.dsh-feishu-bridge/model-prefs.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { ModelRoute } from "./model-resolver.js";

/** 日志回调（可选） */
type DebugFn = (msg: string) => void;

/** 隔离偏好文件结构 */
interface PrefsFile {
  overrides: Record<string, ModelRoute>;
  /** sessionKey → 最新 sessionId（fork/new 后更新，重启恢复用） */
  sessionIds: Record<string, string>;
  /** sessionKey → reasoningEffort override（per-chat 思考强度） */
  effortOverrides: Record<string, string>;
}

export class PrefsStore {
  /** per-key 模型偏好（内存态） */
  private overrides = new Map<string, ModelRoute>();
  /** per-key 最新 sessionId（内存态） */
  private sessionIds = new Map<string, string>();
  /** per-key 思考强度 override（内存态） */
  private effortOverrides = new Map<string, string>();
  /** 隔离偏好文件路径 */
  private readonly prefsPath: string;
  private readonly debugLog?: DebugFn;

  constructor(debugLog?: DebugFn) {
    this.prefsPath = resolve(homedir(), ".dsh-feishu-bridge", "model-prefs.json");
    this.debugLog = debugLog;
    this.load();
  }

  // ── Override 操作 ──

  getOverride(sessionKey: string): ModelRoute | undefined {
    return this.overrides.get(sessionKey);
  }

  setOverride(sessionKey: string, route: ModelRoute): void {
    this.overrides.set(sessionKey, route);
    this.write();
  }

  clearOverride(sessionKey: string): boolean {
    const deleted = this.overrides.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  hasOverride(sessionKey: string): boolean {
    return this.overrides.has(sessionKey);
  }

  // ── SessionId 操作 ──

  getSessionId(sessionKey: string): string | undefined {
    return this.sessionIds.get(sessionKey);
  }

  setSessionId(sessionKey: string, sessionId: string): void {
    this.sessionIds.set(sessionKey, sessionId);
    this.write();
  }

  clearSessionId(sessionKey: string): boolean {
    const deleted = this.sessionIds.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  // ── EffortOverride 操作 ──

  getEffortOverride(sessionKey: string): string | undefined {
    return this.effortOverrides.get(sessionKey);
  }

  setEffortOverride(sessionKey: string, effort: string): void {
    this.effortOverrides.set(sessionKey, effort);
    this.write();
  }

  clearEffortOverride(sessionKey: string): boolean {
    const deleted = this.effortOverrides.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  // ── 私有方法 ──

  private load(): void {
    try {
      if (!existsSync(this.prefsPath)) return;
      const content = readFileSync(this.prefsPath, "utf8");
      const data = JSON.parse(content) as PrefsFile;
      if (data.overrides && typeof data.overrides === "object") {
        for (const [key, route] of Object.entries(data.overrides)) {
          if (route.provider && route.model) {
            this.overrides.set(key, { provider: route.provider, model: route.model });
          }
        }
      }
      if (data.sessionIds && typeof data.sessionIds === "object") {
        for (const [key, sessionId] of Object.entries(data.sessionIds)) {
          if (typeof sessionId === "string" && sessionId) {
            this.sessionIds.set(key, sessionId);
          }
        }
      }
      if (data.effortOverrides && typeof data.effortOverrides === "object") {
        for (const [key, effort] of Object.entries(data.effortOverrides)) {
          if (typeof effort === "string" && effort) {
            this.effortOverrides.set(key, effort);
          }
        }
      }
    } catch (err) {
      this.debugLog?.(`loadPrefs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.prefsPath), { recursive: true });
      const data: PrefsFile = {
        overrides: Object.fromEntries(this.overrides.entries()),
        sessionIds: Object.fromEntries(this.sessionIds.entries()),
        effortOverrides: Object.fromEntries(this.effortOverrides.entries()),
      };
      writeFileSync(this.prefsPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      this.debugLog?.(`writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}