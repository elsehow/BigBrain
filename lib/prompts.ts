/**
 * prompts.ts — render the engine's prompt templates in prompts/.
 *
 * The templates ship WITH THE ENGINE and are versioned with it, and that is
 * the ONLY place they live: a prompt is the engine's text, not a per-vault
 * setting to be migrated, validated and stamped (#524).
 *
 * A vault's own prompts/<role>.md used to win over the engine's. Combined
 * with seeding, that quietly froze every vault at whatever the engine
 * shipped the day it was made — on 2026-08-31 the canary was curating itself
 * with a memory prompt from 2026-08-28, three retired prompts beside it, and
 * four engine fixes it had never seen. Seeding stopped in #524; the
 * precedence and the leftovers went on 2026-08-31, and `bigbrain install`
 * sheds a vault's copies (lib/scaffold.ts shedVaultPrompts).
 *
 * The syntax is deliberately tiny (a mustache subset):
 *
 *   {{key}}              substitute the variable; unknown keys are an error
 *   {{#key}}...{{/key}}  keep the block iff the variable is non-empty
 *   {{^key}}...{{/key}}  keep the block iff the variable IS empty
 *
 * A section tag sitting at the end of a line consumes its newline, so
 * dropped blocks leave no blank scars. No nesting, no escaping, no logic —
 * a prompt is config, not a program.
 */

export type PromptVars = Record<string, string>;

export function render(template: string, vars: PromptVars): string {
  const lookup = (key: string): string => {
    if (!(key in vars)) throw new Error(`unknown template variable {{${key}}}`);
    return vars[key]!;
  };
  return template
    .replace(/\{\{([#^])(\w+)\}\}\n?([\s\S]*?)\{\{\/\2\}\}\n?/g, (_, kind, key, body) =>
      (kind === "#") === lookup(key).length > 0 ? body : ""
    )
    .replace(/\{\{(\w+)\}\}/g, (_, key) => lookup(key));
}
