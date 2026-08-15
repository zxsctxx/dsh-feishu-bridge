/**
 * PresetPrefsStore — per-chat 预设偏好与全局默认持久化（飞书桥自有，不影响宿主 settings）
 *
 * 与 PrefsStore 平行的独立文件，字段语义清晰、互不干扰。
 * 存储路径：~/.dsh-feishu-bridge/preset-prefs.json
 *
 * 解析优先级（ensureAgent / switchPreset 时）：
 *   per-chat 偏好 > 全局默认（/preset default 设置）> config.preset > 宿主默认（agentPresets.defaultId）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

/** 日志回调（可选） */
type DebugFn = (msg: string) => void;

/** 隔离偏好文件结构 */
interface PresetPrefsFile {
  /** 全局默认预设 id；缺省表示未设置（回落 config.preset / 宿主默认） */
  default?: string;
  /** sessionKey → per-chat 预设偏好 */
  perChat: Record<string, string>;
}

export class PresetPrefsStore {
  /** 全局默认预设（内存态） */
  private globalDefault?: string;
  /** per-key 预设偏好（内存态） */
  private perChat = new Map<string, string>();
  /** 隔离偏好文件路径 */
  private readonly prefsPath: string;
  private readonly debugLog?: DebugFn;

  /** 默认存储路径：~/.dsh-feishu-bridge/preset-prefs.json */
  static defaultPrefsPath(): string {
    return resolve(homedir(), ".dsh-feishu-bridge", "preset-prefs.json");
  }

  /** prefsPathOverride 仅供测试注入临时路径，避免污染用户真实偏好文件 */
  constructor(debugLog?: DebugFn, prefsPathOverride?: string) {
    this.prefsPath = prefsPathOverride ?? PresetPrefsStore.defaultPrefsPath();
    this.debugLog = debugLog;
    this.load();
  }

  // ── 全局默认 ──

  /** 读取全局默认预设 id */
  getDefault(): string | undefined {
    return this.globalDefault;
  }

  /** 设置全局默认预设 id；undefined 表示清除 */
  setDefault(id: string | undefined): void {
    this.globalDefault = id;
    this.write();
  }

  // ── Per-chat 偏好 ──

  hasChatPreset(sessionKey: string): boolean {
    return this.perChat.has(sessionKey);
  }

  getChatPreset(sessionKey: string): string | undefined {
    return this.perChat.get(sessionKey);
  }

  setChatPreset(sessionKey: string, id: string): void {
    this.perChat.set(sessionKey, id);
    this.write();
  }

  clearChatPreset(sessionKey: string): boolean {
    const deleted = this.perChat.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  // ── 私有方法 ──

  private load(): void {
    try {
      if (!existsSync(this.prefsPath)) return;
      const content = readFileSync(this.prefsPath, "utf8");
      const data = JSON.parse(content) as PresetPrefsFile;
      if (typeof data.default === "string" && data.default) {
        this.globalDefault = data.default;
      }
      if (data.perChat && typeof data.perChat === "object") {
        for (const [key, id] of Object.entries(data.perChat)) {
          if (typeof id === "string" && id) {
            this.perChat.set(key, id);
          }
        }
      }
    } catch (err) {
      this.debugLog?.(`loadPresetPrefs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.prefsPath), { recursive: true });
      const data: PresetPrefsFile = {
        ...(this.globalDefault ? { default: this.globalDefault } : {}),
        perChat: Object.fromEntries(this.perChat.entries()),
      };
      writeFileSync(this.prefsPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      this.debugLog?.(`writePresetPrefs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}