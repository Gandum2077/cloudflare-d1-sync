import { describe, expect, it } from "vitest";
import { api, bind, dataOf, errorOf, json } from "./helpers";

describe.sequential("device management", () => {
  it("binds, rebinds, lists, and patches a device", async () => {
    await bind("device-management", "Original");
    const rebound = await api("/v1/devices/bind", {
      method: "POST",
      body: {
        device_id: "device-management",
        name: "Rebound",
        platform: "ios",
        app_version: "2.0.0",
      },
    });
    expect(rebound.status).toBe(200);

    const patched = await api("/v1/devices/device-management", {
      method: "PATCH",
      deviceId: "device-management",
      body: { name: "Patched", platform: null },
    });
    expect(patched.status).toBe(200);
    const device = dataOf(await json(patched)).device as Record<string, unknown>;
    expect(device).toMatchObject({ id: "device-management", name: "Patched", platform: null, deleted: 0 });

    const listed = await api("/v1/devices", { deviceId: "device-management" });
    expect(listed.status).toBe(200);
    const devices = dataOf(await json(listed)).devices as Record<string, unknown>[];
    expect(devices.some((row) => row.id === "device-management")).toBe(true);
  });

  it("unbinds idempotently and blocks the device from protected routes", async () => {
    const first = await api("/v1/devices/device-management", {
      method: "DELETE",
      deviceId: "device-management",
    });
    expect(first.status).toBe(200);
    expect((dataOf(await json(first)).device as Record<string, unknown>).deleted).toBe(1);

    await bind("device-admin", "Admin");
    const second = await api("/v1/devices/device-management", {
      method: "DELETE",
      deviceId: "device-admin",
    });
    expect(second.status).toBe(200);

    const blocked = await api("/v1/info", { deviceId: "device-management" });
    expect(blocked.status).toBe(403);
    expect(errorOf(await json(blocked)).code).toBe("DEVICE_NOT_BOUND");
  });

  it("validates metadata and patch shape", async () => {
    const invalidBind = await api("/v1/devices/bind", {
      method: "POST",
      body: { device_id: "invalid", name: "" },
    });
    expect(invalidBind.status).toBe(400);

    const emptyPatch = await api("/v1/devices/device-admin", {
      method: "PATCH",
      deviceId: "device-admin",
      body: {},
    });
    expect(emptyPatch.status).toBe(400);

    const malformedPath = await api("/v1/devices/%", {
      method: "PATCH",
      deviceId: "device-admin",
      body: { name: "Ignored" },
    });
    expect(malformedPath.status).toBe(404);
  });
});
