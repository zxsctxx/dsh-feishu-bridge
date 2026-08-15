/**
 * PresetPrefsStore 单元测试：per-chat 偏好 + 全局默认的读写与持久化。
 * 使用临时目录注入路径，避免污染用户真实 ~/.dsh-feishu-bridge/。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PresetPrefsStore } from "./preset-prefs.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "preset-prefs-"));
  const store = new PresetPrefsStore(undefined, join(dir, "preset-prefs.json"));
  return { store, dir };
}

describe("PresetPrefsStore", () => {
  it("默认值：无全局默认、无 per-chat 偏好", () => {
    const { store } = makeStore();
    expect(store.getDefault()).toBeUndefined();
    expect(store.hasChatPreset("k")).toBe(false);
  });

  it("per-chat 偏好：set/get/has/clear", () => {
    const { store } = makeStore();
    store.setChatPreset("feishu:app:oc_a", "code");
    expect(store.getChatPreset("feishu:app:oc_a")).toBe("code");
    expect(store.hasChatPreset("feishu:app:oc_a")).toBe(true);
    expect(store.hasChatPreset("feishu:app:oc_b")).toBe(false);
    expect(store.clearChatPreset("feishu:app:oc_a")).toBe(true);
    expect(store.getChatPreset("feishu:app:oc_a")).toBeUndefined();
    // 清除不存在的键返回 false 且不写文件
    expect(store.clearChatPreset("feishu:app:oc_a")).toBe(false);
  });

  it("全局默认：setDefault/getDefault，undefined 清除", () => {
    const { store } = makeStore();
    expect(store.setDefault("minimal")).toBeUndefined();
    expect(store.getDefault()).toBe("minimal");
    store.setDefault(undefined);
    expect(store.getDefault()).toBeUndefined();
  });

  it("持久化：重建实例读回全部状态", () => {
    const dir = mkdtempSync(join(tmpdir(), "preset-prefs-"));
    const path = join(dir, "preset-prefs.json");
    const first = new PresetPrefsStore(undefined, path);
    first.setDefault("standard");
    first.setChatPreset("feishu:app:oc_a", "code");
    first.setChatPreset("feishu:app:oc_b", "minimal");

    const second = new PresetPrefsStore(undefined, path);
    expect(second.getDefault()).toBe("standard");
    expect(second.getChatPreset("feishu:app:oc_a")).toBe("code");
    expect(second.getChatPreset("feishu:app:oc_b")).toBe("minimal");
    expect(second.hasChatPreset("feishu:app:oc_c")).toBe(false);

    // 清除后重建：不残留
    second.clearChatPreset("feishu:app:oc_a");
    second.setDefault(undefined);
    const third = new PresetPrefsStore(undefined, path);
    expect(third.getDefault()).toBeUndefined();
    expect(third.getChatPreset("feishu:app:oc_a")).toBeUndefined();
    expect(third.getChatPreset("feishu:app:oc_b")).toBe("minimal");

    rmSync(dir, { recursive: true, force: true });
  });

  it("损坏文件：静默降级为空状态（不留错误）", () => {
    const dir = mkdtempSync(join(tmpdir(), "preset-prefs-"));
    const path = join(dir, "preset-prefs.json");
    writeFileSync(path, "{ not json", "utf8");
    const store = new PresetPrefsStore(undefined, path);
    expect(store.getDefault()).toBeUndefined();
    expect(store.hasChatPreset("k")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});