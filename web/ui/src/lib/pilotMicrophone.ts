// A microphone is a preference of this device/origin, not vault content.
// Read it on every hold so the palette hears choices made in the main window.
export const PILOT_MICROPHONE_KEY = "bb-pilot-microphone";
let choice = "";

export function readPilotMicrophone(): string {
  try {
    choice = localStorage.getItem(PILOT_MICROPHONE_KEY) ?? "";
  } catch {
    /* Storage unavailable: keep this page's choice. */
  }
  return choice;
}

export function savePilotMicrophone(deviceId: string): void {
  choice = deviceId;
  try {
    localStorage.setItem(PILOT_MICROPHONE_KEY, deviceId);
  } catch {
    /* The current page still uses the selected microphone. */
  }
}

export async function openPilotMicrophone(
  deviceId: string,
  devices: Pick<MediaDevices, "getUserMedia"> | undefined = navigator.mediaDevices,
): Promise<MediaStream> {
  if (!devices) throw new Error("Microphone access is unavailable in this window.");
  try {
    return await devices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
  } catch (error) {
    if (deviceId && error instanceof Error && ["OverconstrainedError", "NotFoundError"].includes(error.name))
      throw new Error("The selected microphone is unavailable. Choose another in settings › pilot.");
    throw error;
  }
}

/** Request access only from the settings button. Enumerate while the probe
 * is live so device names are exposed, then release every track even on error. */
export async function listPilotMicrophones(
  requestAccess = false,
  devices: Pick<MediaDevices, "getUserMedia" | "enumerateDevices"> | undefined = navigator.mediaDevices,
): Promise<MediaDeviceInfo[]> {
  if (!devices) throw new Error("Microphone access is unavailable in this window.");
  let probe: MediaStream | undefined;
  try {
    if (requestAccess) probe = await openPilotMicrophone("", devices);
    return (await devices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default");
  } finally {
    probe?.getTracks().forEach(track => track.stop());
  }
}
