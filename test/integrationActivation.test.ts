import { expect, test } from "bun:test";
import { initialActivation, transition, type ActivationState, type Action } from "../web/ui/src/dev/integrations/activation";
const apply = (state: ActivationState, ...actions: Action[]) => actions.reduce(transition, state);
const begin: Action = { type: "begin", source: "granola" };
const authorized = () => apply(initialActivation(), begin, { type: "connect" }, { type: "allow" });

test("only the final gate activates, after authorization and a nonblank rule", () => {
  let state = initialActivation();
  for (const action of [begin, { type: "connect" }, { type: "allow" }] as Action[]) {
    state = transition(state, action);
    expect(state.integrations.granola.active).toBe(false);
    if (!state.setup?.authenticated) expect(transition(state, { type: "finish" }).integrations.granola.active).toBe(false);
  }
  state = transition(state, { type: "edit", value: "  " });
  expect(transition(state, { type: "finish" }).integrations.granola.active).toBe(false);
  state = apply(state, { type: "edit", value: "Remember new transcripts." }, { type: "finish" });
  expect(state.integrations.granola).toEqual({ active: true, rule: "Remember new transcripts." });
  expect(state.integrations["that-tracks"].active).toBe(false);
});

test("cancel at every setup stage preserves inactive state and discards edits", () => {
  for (const steps of [[], [{ type: "connect" }], [{ type: "connect" }, { type: "allow" }, { type: "edit", value: "unsaved" }]] as Action[][]) {
    const state = apply(initialActivation(), begin, ...steps, { type: "cancel" }, { type: "finish" });
    expect(state).toEqual(initialActivation());
  }
});

test("failed auth, incomplete auth and Back cannot satisfy the activation gate", () => {
  let failed = apply(initialActivation(false, true), begin, { type: "connect" }, { type: "allow" }, { type: "finish" });
  expect(failed.integrations.granola.active).toBe(false);
  expect(failed.setup?.error).toBeTruthy();
  failed = apply(failed, { type: "connect" }, { type: "allow" }, { type: "finish" });
  expect(failed.integrations.granola.active).toBe(true);
  const back = apply(authorized(), { type: "back" }, { type: "finish" });
  expect(back.setup?.authenticated).toBe(false);
  expect(back.integrations.granola.active).toBe(false);
});

test("deactivation retains saved rule; re-entry requires fresh account setup", () => {
  let state = apply(authorized(), { type: "edit", value: "Remember since September." }, { type: "finish" }, { type: "deactivate", source: "granola" }, begin);
  expect(state.setup?.draft).toBe("Remember since September.");
  expect(state.setup?.authenticated).toBe(false);
  state = transition(state, { type: "finish" });
  expect(state.integrations.granola.active).toBe(false);
});
