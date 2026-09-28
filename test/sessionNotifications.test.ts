import { afterEach, expect, test } from "bun:test";
import { notifySession } from "../web/ui/src/lib/native";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "window", original);
  else Reflect.deleteProperty(globalThis, "window");
});
const mockWindow = (notification?: unknown) => Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI__: { notification } } });

test("native delivery uses existing permission; declined permission leaves the in-app fallback", async () => {
  const delivered: unknown[] = [];
  mockWindow({ isPermissionGranted: async () => true, requestPermission: async () => { throw new Error("Already granted"); }, sendNotification: (n: unknown) => delivered.push(n) });
  expect(await notifySession("Dashboard", "Keep the export?")).toBe(true);
  expect(delivered).toEqual([{ title: "Dashboard", body: "Keep the export?" }]);
  mockWindow({ isPermissionGranted: async () => false, requestPermission: async () => "denied", sendNotification: () => { throw new Error("Must not send"); } });
  expect(await notifySession("Dashboard", "Keep the export?")).toBe(false);
  mockWindow(); expect(await notifySession("Dashboard", "Keep the export?")).toBe(false);
});
