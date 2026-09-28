import { errText } from "../../../../lib/errText";

/** A settings tab's one-line toast: ok (green-ish) or a failure (red),
 * rendered beside the tab's eyebrow. */
export interface Notice {
  ok: boolean;
  text: string;
}

/** The try/catch every settings-tab async action repeats (IntegrationsView,
 * AgentsView): clear the notice, run `fn`, and on a thrown error set it to a
 * formatted failure. Busy flags differ per call site (`busy` / `capturing` /
 * `revoking`, cleared to `null` or `false`) and success text varies too much
 * to templatize (some sites set no success notice at all) — both stay the
 * caller's, wrapped around this call. This owns only the shared failure
 * path (#265). */
export async function guardNotice(
  setNotice: (n: Notice | null) => void,
  fn: () => Promise<void>
): Promise<void> {
  setNotice(null);
  try {
    await fn();
  } catch (e) {
    setNotice({ ok: false, text: errText(e) });
  }
}
