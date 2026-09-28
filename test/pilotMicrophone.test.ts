import { describe, expect, test } from "bun:test";
import { listPilotMicrophones, openPilotMicrophone, readPilotMicrophone, savePilotMicrophone } from "../web/ui/src/lib/pilotMicrophone";

describe("pilot microphones", () => {
  test("captures the requested input exactly, or follows the system default", async () => {
    const constraints: unknown[] = [];
    const stream = {} as MediaStream;
    const devices = { getUserMedia: async (input: unknown) => { constraints.push(input); return stream; } };
    expect(await openPilotMicrophone("usb-mic", devices)).toBe(stream);
    await openPilotMicrophone("", devices);
    expect(constraints).toEqual([{ audio: { deviceId: { exact: "usb-mic" } } }, { audio: true }]);
  });

  test("an unavailable selection fails clearly without recording another input", async () => {
    let calls = 0;
    const devices = { getUserMedia: async () => {
      calls++;
      throw Object.assign(new Error("gone"), { name: "OverconstrainedError" });
    } };
    await expect(openPilotMicrophone("unplugged", devices)).rejects.toThrow("selected microphone is unavailable");
    expect(calls).toBe(1);
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    await expect(openPilotMicrophone("usb", { getUserMedia: async () => { throw denied; } })).rejects.toBe(denied);
  });

  test("listing is passive unless requested and permission probes always release their tracks", async () => {
    let opens = 0;
    let stops = 0;
    const devices = {
      getUserMedia: async () => { opens++; return { getTracks: () => [{ stop: () => stops++ }] } as unknown as MediaStream; },
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "", label: "" },
        { kind: "audioinput", deviceId: "default", label: "Default" },
        { kind: "audioinput", deviceId: "usb", label: "USB mic" },
        { kind: "videoinput", deviceId: "camera", label: "Camera" },
      ] as MediaDeviceInfo[],
    };
    expect((await listPilotMicrophones(false, devices)).map(d => d.deviceId)).toEqual(["usb"]);
    expect(opens).toBe(0);
    await listPilotMicrophones(true, devices);
    expect(opens).toBe(1);
    expect(stops).toBe(1);
    await expect(listPilotMicrophones(true, { ...devices, enumerateDevices: async () => { throw new Error("enumeration failed"); } })).rejects.toThrow("enumeration failed");
    expect(stops).toBe(2);
  });

  test("a subsequent hold rereads another window's saved choice", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let stored: string | null = null;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: () => stored, setItem: (_: string, value: string) => { stored = value; },
    } });
    try {
      savePilotMicrophone("usb");
      expect(readPilotMicrophone()).toBe("usb");
      stored = "headset";
      expect(readPilotMicrophone()).toBe("headset");
      savePilotMicrophone("");
      expect(readPilotMicrophone()).toBe("");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
