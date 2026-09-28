/** Display labels and recommendation-family names. Runtime discovery and
 * availability come from Pi's connected provider catalog. */
export interface ModelDescriptor {
  id: string;
  label: string;
  provider: "anthropic" | "openai";
}

export const MODEL_REGISTRY: readonly ModelDescriptor[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "openai" },
  { id: "opus", label: "Opus (latest)", provider: "anthropic" },
  { id: "sonnet", label: "Sonnet (latest)", provider: "anthropic" },
  { id: "haiku", label: "Haiku (latest)", provider: "anthropic" },
  { id: "fable", label: "Fable (latest)", provider: "anthropic" },
  { id: "gpt-realtime-2.1", label: "Realtime 2.1", provider: "openai" },
];

export function modelDescriptor(id: string | null | undefined): ModelDescriptor | undefined {
  const value = (id ?? "").trim();
  return MODEL_REGISTRY.find(model => model.id === value);
}
