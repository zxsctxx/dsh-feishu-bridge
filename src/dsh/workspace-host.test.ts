import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BridgeConfig } from "../config.js";
import type { WorkspaceBackend } from "./workspace-backend.js";
import { WorkspaceError, WorkspaceResolver } from "./workspace.js";
import { DisabledWorkspaceResolver, HostWorkspaceResolver, WorkspaceHostMigrationStore } from "./workspace-host.js";
import { WorkspacePrefsStore } from "./workspace-prefs.js";

describe("WorkspaceHostMigrationStore", () => {
  it("以 version/mode/mappings 原子持久化并可恢复", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-migration-"));
    const path = join(root, "mapping.json");
    const store = new WorkspaceHostMigrationStore(path);
    store.set("legacy", { hostId: "host-1", canonicalPath: join(root, "project") });

    const restored = new WorkspaceHostMigrationStore(path);
    expect(restored.get("legacy")).toEqual({ hostId: "host-1", canonicalPath: join(root, "project") });
    expect(restored.findAlias("host-1")).toBe("legacy");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, mode: "host" });
    rmSync(root, { recursive: true, force: true });
  });

  it("映射文件损坏时 fail closed，不覆盖原文件", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-migration-corrupt-"));
    const path = join(root, "mapping.json");
    writeFileSync(path, "{bad", "utf8");
    const store = new WorkspaceHostMigrationStore(path);
    expect(() => store.get("legacy")).toThrow(WorkspaceError);
    expect(readFileSync(path, "utf8")).toBe("{bad");
    rmSync(root, { recursive: true, force: true });
  });

  it("版本或模式不匹配时拒绝写入", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-migration-version-"));
    const path = join(root, "mapping.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, mode: "local", mappings: {} }), "utf8");
    const store = new WorkspaceHostMigrationStore(path);
    expect(() => store.list()).toThrow("版本无效");
    rmSync(root, { recursive: true, force: true });
  });

  it("V2 chat selection 改写 host ID 前保留 v1 备份", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-prefs-"));
    const path = join(root, "workspace-prefs.json");
    const prefs = new WorkspacePrefsStore(path);
    prefs.set("app:chat", "legacy");
    expect(prefs.migrateIds(new Map([["legacy", "host-1"]]))).toBe(true);
    expect(new WorkspacePrefsStore(path).get("app:chat")).toBe("host-1");
    expect(readFileSync(path + ".v1.bak", "utf8")).toContain("legacy");
    expect(prefs.migrateIds(new Map([["legacy", "host-1"]]))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("host 映射损坏不阻止 Resolver 构造，但首次读取 fail-closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-lazy-error-"));
    const mappingPath = join(root, "mapping.json");
    writeFileSync(mappingPath, "{bad", "utf8");
    const config = { appId: "app", cwd: root, workspaceRoots: [root], workspaces: [], workspaceMigration: "read-only" } as BridgeConfig;
    const local = new WorkspaceResolver(config, join(root, "prefs.json"), undefined, join(root, "registry.json"), false, true);
    const backend = { mode: "host", list: async () => [], get: async () => undefined, resolveByPath: async () => undefined, create: async () => { throw new Error("unused"); }, delete: async () => false, rename: async () => { throw new Error("unused"); } } as unknown as WorkspaceBackend;
    const resolver = new HostWorkspaceResolver(config, backend, join(root, "prefs.json"), local, undefined, mappingPath);
    await expect(resolver.list()).rejects.toThrow("映射文件损坏");
    rmSync(root, { recursive: true, force: true });
  });

  it("host add 继续受 workspaceRoots 约束", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-roots-"));
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    const config = { appId: "app", cwd: root, workspaceRoots: [allowed], workspaces: [], workspaceMigration: "disabled" } as BridgeConfig;
    const local = new WorkspaceResolver(config, join(root, "prefs.json"), undefined, join(root, "registry.json"), false, true);
    const backend = { mode: "host", list: async () => [], get: async () => undefined, resolveByPath: async () => undefined, create: async (path: string) => ({ id: "host-1", title: "Host", path, status: "available" as const }), delete: async () => true, rename: async () => { throw new Error("unused"); } } as unknown as WorkspaceBackend;
    const resolver = new HostWorkspaceResolver(config, backend, join(root, "prefs.json"), local, undefined, join(root, "mapping.json"));
    await expect(resolver.addRuntime("inside", allowed)).resolves.toMatchObject({ id: "host-1" });
    await expect(resolver.addRuntime("duplicate", allowed)).rejects.toThrow("其他 alias");
    await expect(resolver.addRuntime("outside", outside)).rejects.toThrow("workspaceRoots");
    rmSync(root, { recursive: true, force: true });
  });

  it("disabled Resolver 只保留 legacy cwd 并拒绝 CRUD", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-disabled-"));
    const config = { appId: "app", cwd: root } as BridgeConfig;
    const resolver = new DisabledWorkspaceResolver(config);
    await expect(resolver.list()).resolves.toMatchObject([{ id: "default", path: root }]);
    await expect(resolver.addRuntime("x", root)).rejects.toThrow("已禁用");
    await expect(resolver.select("chat", "default")).rejects.toThrow("已禁用");
    rmSync(root, { recursive: true, force: true });
  });

  it("并发 list 共享同一次迁移，不重复 create；失败后可重试且不 fallback local", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-host-mutex-"));
    mkdirSync(join(root, "legacy"));
    let createCalls = 0;
    let failCreate = true;
    const backend = {
      mode: "host",
      list: async () => [],
      get: async () => undefined,
      resolveByPath: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return undefined;
      },
      create: async (path: string, title?: string) => {
        createCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (failCreate) throw new Error("host storage failure");
        return { id: "host-1", title: title ?? "legacy", path, status: "available" as const };
      },
      delete: async () => true,
      rename: async () => { throw new Error("unused"); },
      attachSession: async () => {},
    } as unknown as WorkspaceBackend;
    const config = {
      appId: "app",
      cwd: root,
      workspaceRoots: [root],
      workspaces: [{ id: "legacy", title: "Legacy", path: join(root, "legacy") }],
      workspaceMigration: "write",
    } as BridgeConfig;
    const local = new WorkspaceResolver(config, join(root, "prefs.json"), undefined, join(root, "registry.json"), false, true);
    const resolver = new HostWorkspaceResolver(config, backend, join(root, "prefs.json"), local, undefined, join(root, "mapping.json"));

    // 失败路径：并发调用共享同一次迁移运行，只尝试一次 create，全部失败
    const failed = await Promise.allSettled([resolver.list(), resolver.list(), resolver.list()]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(createCalls).toBe(1);

    // 修复后重试：一次成功，后续并发复用同一已解决的 promise，不重复 create
    failCreate = false;
    const rows = await Promise.all([resolver.list(), resolver.list(), resolver.list()]);
    expect(createCalls).toBe(2);
    expect(rows[0]).toEqual([]);
    expect(rows[1]).toEqual([]);
    expect(rows[2]).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
