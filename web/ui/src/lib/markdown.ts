import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true, async: false });

// Raw marked → HTML. marked passes inline/block HTML straight through (it
// dropped its `sanitize` option at v5), so this output is UNSAFE to hand to
// {@html} on its own: a note body carrying `<img onerror>` / `<script>` would
// render live. Every caller MUST route it through sanitizeHtml() before the
// DOM. Kept as its own step because NoteTab.renderAssertion rewrites wikilinks +
// attachment srcs on this HTML first, then sanitizes the whole once (#552).
export function md(src?: string): string {
  if (!src) return "";
  return marked.parse(src) as string;
}

// The single gate every {@html}-rendered note/assertion body passes through
// (#552). Note bodies are third-party by design — extension clips of hostile
// pages, Granola/agent-chat transcripts, anything landed via /v1/drop — and
// the viewer renders them on the same origin as the vault's own API. An
// unsanitized `<img onerror>` there runs with the viewer's authority:
// read the vault, act as the user. DOMPurify strips every
// scriptable construct (event-handler attrs, <script>, javascript: URLs) while
// keeping the markup a note legitimately uses. It runs LAST, over renderNote's
// output, so the wikilink anchors and the same-origin /api/file attachment srcs
// it adds (blob:/vault-relative refs already rewritten by then) survive the
// default allow-list, while a hostile wikilink label is defanged like any other
// node. Runs in the browser against the real DOM — the shipped, faithful path.
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}
