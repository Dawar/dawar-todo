"use client";

const DEVICE_ID_KEY = "dawar-todo-device-id-v1";
const DEVICE_ID_PATTERN = /^[0-9a-f-]{36}$/i;
let sessionDeviceId = "";

export function getOrCreateDeviceId() {
  if (typeof window === "undefined") return "";
  try {
    const stored = window.localStorage.getItem(DEVICE_ID_KEY)?.trim() ?? "";
    if (DEVICE_ID_PATTERN.test(stored)) return stored;
    const created = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_ID_KEY, created);
    console.info("[todo-push] device identity created");
    return created;
  } catch (error) {
    sessionDeviceId ||= crypto.randomUUID();
    console.warn("[todo-push] persistent device identity unavailable; using session identity", { error });
    return sessionDeviceId;
  }
}

export function headersWithDeviceId(headers?: HeadersInit) {
  const result = new Headers(headers);
  const deviceId = getOrCreateDeviceId();
  if (deviceId) result.set("X-Dawar-Device-Id", deviceId);
  return result;
}
