/** Off macOS a desktop's commands have no sandbox and are refused
 * (packages/agents/src/sandbox.ts). Tests of everything else around them
 * run them bare there; on macOS they run in the real sandbox. */
import type { Launcher } from "../../packages/agents/src";

export const offMacLauncher: Launcher | undefined = process.platform === "darwin" ? undefined
  : { launch: async job => ({ file: "/bin/bash", args: ["-c", job.command], env: job.env }) };
