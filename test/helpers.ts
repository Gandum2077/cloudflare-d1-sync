import { env } from "cloudflare:workers";
import worker from "../src/index";

export const MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export interface ApiCallOptions {
  method?: string;
  deviceId?: string;
  body?: unknown;
  key?: string;
  apiVersion?: string;
}

export async function api(path: string, options: ApiCallOptions = {}): Promise<Response> {
  const headers = new Headers();
  if (options.key !== "omit") headers.set("Authorization", `Bearer ${options.key ?? MASTER_KEY}`);
  headers.set("X-API-Version", options.apiVersion ?? "1");
  if (options.deviceId !== undefined) headers.set("X-Device-ID", options.deviceId);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const request = new Request(`https://sync.example${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return await worker.fetch(request, env);
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("response was not a JSON object");
  }
  return value as Record<string, unknown>;
}

export function dataOf(envelope: Record<string, unknown>): Record<string, unknown> {
  const data = envelope.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("response data was not an object");
  }
  return data as Record<string, unknown>;
}

export function errorOf(envelope: Record<string, unknown>): Record<string, unknown> {
  const error = envelope.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    throw new Error("response error was not an object");
  }
  return error as Record<string, unknown>;
}

export async function bind(deviceId: string, name = deviceId): Promise<void> {
  const response = await api("/v1/devices/bind", {
    method: "POST",
    body: { device_id: deviceId, name, platform: "test", app_version: "1.0.0" },
  });
  if (response.status !== 200) throw new Error(`failed to bind device: ${response.status}`);
}
