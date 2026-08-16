import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceBackend,
  HostWorkspaceBackend,
  UnavailableWorkspaceBackend,
  workspaceBackendDiagnostic,
  workspaceBackendMode,
} from "./workspace-backend.js";

const hostRegistry = {
  list: () => [
    { id: "host-one", title: "Host One", path: "C:/host-one" },
    { id: "host-two", path: "C:/host-two" },
  ],
  get: (id: string) => id === "host-one" ? { id: "host-one", title: "Host One", path: "C:/host-one", setTitle: async () => {} } : undefined,
  resolveByPath: async (path: string) => path === "C:/host-one"
    ? { id: "host-one", title: "Host One", path }
    : undefined,
  create: async (path: string, title?: string) => ({ id: "created", title: title ?? "created", path, setTitle: async () => {} }),
  delete: async () => true,
};

describe("V3 workspace backend", () => {
  it("默认模式保持 V2 local fallback，且不依赖宿主服务", () => {
    expect(workspaceBackendMode(undefined)).toBe("local");
    expect(workspaceBackendDiagnostic("local")).toMatchObject({ state: "local", message: "Workspace Registry: local/v2-fallback" });
  });

  it("host 适配器只读 DTO，不按 workspaceRoots 过滤宿主条目", async () => {
    const backend = new HostWorkspaceBackend(hostRegistry);
    await expect(backend.list()).resolves.toEqual([
      { id: "host-one", title: "Host One", path: "C:/host-one", status: "available" },
      { id: "host-two", title: "host-two", path: "C:/host-two", status: "available" },
    ]);
    await expect(backend.resolveByPath("C:/host-one")).resolves.toMatchObject({ id: "host-one" });
    expect(workspaceBackendDiagnostic("host", true).message).toBe("Workspace Registry: host/shared");
  });

  it("host CRUD 返回真实宿主 ID，并透传重命名与删除", async () => {
    const backend = new HostWorkspaceBackend(hostRegistry);
    await expect(backend.create("C:/created", "Created")).resolves.toMatchObject({ id: "created", title: "Created" });
    await expect(backend.rename("host-one", "Renamed")).resolves.toMatchObject({ id: "host-one" });
    await expect(backend.delete("host-one")).resolves.toBe(true);
  });

  it("宿主状态为 missing-dir 时不伪装为 available", async () => {
    const backend = new HostWorkspaceBackend({
      ...hostRegistry,
      list: () => [{ id: "missing", path: "C:/missing", status: async () => "missing-dir" }],
    });
    await expect(backend.list()).resolves.toEqual([{ id: "missing", title: "missing", path: "C:/missing", status: "missing" }]);
  });

  it("attachSession 拒绝同一 session 已归属其他 Workspace，且不调用目标 attach", async () => {
    const targetAttach = vi.fn(async () => {});
    const registry = {
      list: () => [
        { id: "host-a", title: "A", path: "C:/a", attachSession: targetAttach },
        { id: "host-b", title: "B", path: "C:/b", sessionIds: ["session-1"] },
      ],
      get: (id: string) => id === "host-a" ? { id: "host-a", title: "A", path: "C:/a", attachSession: targetAttach } : undefined,
      resolveByPath: async () => undefined,
      create: async (path: string) => ({ id: "new", path }),
      delete: async () => true,
    };
    const backend = new HostWorkspaceBackend(registry);
    await expect(backend.attachSession("host-a", "session-1")).rejects.toThrow("已归属其他工作区");
    expect(targetAttach).not.toHaveBeenCalled();
  });

  it("attachSession 对单一归属正常透传并允许目标自身已持有该 session", async () => {
    const targetAttach = vi.fn(async () => {});
    const registry = {
      list: () => [
        { id: "host-a", title: "A", path: "C:/a", sessionIds: ["session-1"], attachSession: targetAttach },
        { id: "host-b", title: "B", path: "C:/b" },
      ],
      get: (id: string) => id === "host-a" ? { id: "host-a", title: "A", path: "C:/a", attachSession: targetAttach } : undefined,
      resolveByPath: async () => undefined,
      create: async (path: string) => ({ id: "new", path }),
      delete: async () => true,
    };
    const backend = new HostWorkspaceBackend(registry);
    await expect(backend.attachSession("host-a", "session-1")).resolves.toBeUndefined();
    expect(targetAttach).toHaveBeenCalledWith("session-1");
  });

  it("host 能力缺失时 fail closed，不静默回退 local", async () => {
    const backend = createWorkspaceBackend("host");
    expect(backend).toBeInstanceOf(UnavailableWorkspaceBackend);
    await expect(backend.list()).rejects.toThrow("host 模式已 fail-closed");
    expect(workspaceBackendDiagnostic("host").state).toBe("unavailable");
  });
});
