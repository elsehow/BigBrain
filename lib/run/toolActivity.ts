import type { RunTool } from "./machineTools";
/** In-process observation only. Consumers must select safe fields before
 * persisting or publishing activity; arguments and results contain vault data. */
export type ToolActivity = { name: string; phase: "start" | "complete" | "error"; args: Record<string, unknown>; result?: unknown };
export type ToolObserver = (event: ToolActivity) => void;
export function observeTools(tools: RunTool[], observe?: ToolObserver): RunTool[] {
  if (!observe) return tools;
  const emit = (event: ToolActivity) => { try { observe(event); } catch { /* status must never fail a tool */ } };
  return tools.map(tool => ({ ...tool, call: async args => {
    emit({ name: tool.name, phase: "start", args });
    try {
      const result = await tool.call(args);
      emit({ name: tool.name, phase: "complete", args, result });
      return result;
    } catch (error) { emit({ name: tool.name, phase: "error", args }); throw error; }
  } }));
}
