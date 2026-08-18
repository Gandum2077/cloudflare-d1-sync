import { describe, expect, it } from "vitest";
import { api, dataOf, errorOf, json, MASTER_KEY } from "./helpers";

describe("authentication and system routes", () => {
  it("serves the public health endpoint with security headers", async () => {
    const response = await api("/v1/health", { key: "omit", apiVersion: "omit" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(dataOf(await json(response))).toMatchObject({
      service: "cloudflare-d1-sync",
      api_version: 1,
    });
  });

  it("accepts only the configured bearer secret", async () => {
    const missing = await api("/v1/auth/verify", { key: "omit" });
    expect(missing.status).toBe(401);
    expect(errorOf(await json(missing)).code).toBe("UNAUTHORIZED");

    const wrong = await api("/v1/auth/verify", { key: "f".repeat(64) });
    expect(wrong.status).toBe(401);

    const correct = await api("/v1/auth/verify", { key: MASTER_KEY });
    expect(correct.status).toBe(200);
    expect(dataOf(await json(correct))).toMatchObject({ authenticated: true, api_version: 1 });
  });

  it("does not accept credentials from the URL and rejects unsupported API versions", async () => {
    const queryOnly = await api(`/v1/auth/verify?token=${MASTER_KEY}`, { key: "omit" });
    expect(queryOnly.status).toBe(401);

    const unsupported = await api("/v1/auth/verify", { apiVersion: "2" });
    expect(unsupported.status).toBe(400);
    expect(errorOf(await json(unsupported)).code).toBe("UNSUPPORTED_API_VERSION");
  });
});
