<script lang="ts">
  // Drag a file — or a whole folder — anywhere onto the app → each file
  // ships to the host inbox
  // IMMEDIATELY (no confirm step), and a notification appears with a note
  // field ready WHILE the extraction/upload runs — a note submitted early
  // QUEUES client-side and ships the moment the landing reports the
  // capture's id (issue #50: the id is the landing's to mint, not ours);
  // triage joins the pair by id regardless of landing order.
  // Captures share the notification stack and keyboard focus with agents.
  // Clearing a notice does not cancel its upload.
  //
  // The LANDING is on the picture (Nick, 2026-09-06): the arrival's node
  // appears in the graph, turning, with the camera on it and the text tab
  // open on what the record makes of it as the round files it. So once a
  // file lands the note card stays available until explicitly dismissed or
  // its note is sent. A fast upload must not race the person to the field.
  //
  // PDFs are text-extracted in the browser (lib/pdf.ts) and ship as
  // markdown WITH the original PDF riding as an attachment (extraction is
  // a convenience read; the raw document is the record); .md ships
  // verbatim (it may carry its own frontmatter, so no note linkage); .txt
  // is wrapped. Everything else ships as a BINARY attachment riding a
  // small markdown item (base64 over /api/drop into the CAS). Triage
  // reads images natively. No size caps here (2026-08-06): binaries live
  // in add-only content-addressed storage, not git history.
  //
  // VOICE (issue #34): every import here claims agent voice — a dropped
  // document is someone else's words, delivered, and without the claim the
  // edge credential stamps it as the user's own (lib/dropVoice.ts). The
  // note typed beside a drop claims nothing: the person composed it.
  import StackNotice from "./StackNotice.svelte";
  import { api } from "../lib/api";
  import { recordArrival } from "../lib/arrivals.svelte";
  import { gotoNote } from "../lib/store.svelte";
  import { slug as baseSlug } from "../../../../lib/slug";
  import { fmSerialize, type FmPair } from "../../../../lib/wire";
  import { AGENT_VOICE, claimAgentVoice, claimTitle } from "../lib/dropVoice";
  import { errText } from "../../../../lib/errText";
  import { extractPdf } from "../lib/pdf";

  interface Tray {
    key: number;
    filename: string;
    status: "sending" | "sent" | "failed"; // extraction is background detail — the user waits only for the host to confirm the landing
    error?: string;
    // The reference id the host landed this under, learned from the drop's
    // response (issue #50). Not a client mint: an id we invent carries a
    // timestamp, which lands every re-drop of an identical file as a fresh
    // reference — the same reason the extension mints none. Its arrival is
    // what enables the note field.
    id?: string;
    /** the landed insertion event's vault path (the receipt's ref_path):
     * the note the picture opens on the landing */
    refPath?: string;
    title: string;
    thin: boolean;
    note: string;
    noteStatus: "" | "queued" | "sending" | "sent" | "failed";
    noteError?: string;
    // Drop progress (api.drop's onProgress) — two legs, each 0→total in
    // its own unit: "encode" (slicing the file into base64) then "upload"
    // (XHR wire bytes, browser→server only; the landing after it has no
    // wire to measure). Set only on the binary-attachment ships: a text
    // drop's body is too small to ever paint a bar.
    leg?: "encode" | "upload";
    sent?: number;
    total?: number;
  }

  let items = $state<Tray[]>([]);
  let dragDepth = $state(0);
  let key = 0;

  const today = () => new Date().toISOString().slice(0, 10);
  // Shared lib/slug.ts, with this door's quirk kept: the file extension is
  // stripped before slugging ("Drop.PDF" -> "drop", not "drop-pdf").
  const slug = (s: string) =>
    baseSlug(s.toLowerCase().replace(/\.[a-z0-9]+$/, ""), { maxLen: 60, fallback: "drop" });

  // #294: the yq-quoting + empty-value-skip rule now lives in lib/wire.ts;
  // this door keeps its own skipEmpty behavior (an earlier independent
  // choice from background.js's post(), which sends unpruned).
  const fm = (pairs: FmPair[]): string => fmSerialize(pairs, { skipEmpty: true });

  const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} stalled (${ms / 1000}s)`)), ms))]);

  // the landing's receipt: the reference id the note field waits on
  // (#50), and the path the picture opens
  const landed = (t: Tray, r: { id?: string; ref_path?: string }): void => { t.id = r.id; t.refPath = r.ref_path; };
  const progressOf = (t: Tray) => (leg: "encode" | "upload", sent: number, total: number) => { t.leg = leg; t.sent = sent; t.total = total; };
  const uploading = (t: Tray): boolean => t.status === "sending" && !!t.total && (t.sent ?? 0) < (t.total ?? 0);
  const pct = (t: Tray): number => (t.total ? Math.min(100, Math.floor(((t.sent ?? 0) / t.total) * 100)) : 0);

  async function shipPdf(file: File, t: Tray): Promise<void> {
    const ex = await withTimeout(extractPdf(file), 90_000, "PDF extraction");
    t.title = ex.title || file.name.replace(/\.pdf$/i, "");
    t.thin = ex.thin;
    const head = fm([
      ["source", "web-drop"],
      ["kind", "pdf-import"],
      ...AGENT_VOICE,
      ["title", t.title],
      ["filename", file.name],
      ["pages", ex.pages],
      ["author", ex.author],
      ["date", ex.created || today()],
    ]);
    const warn = ex.thin
      ? "\n> Near-empty text layer — likely a scanned or image-only PDF; this extraction is not the full document.\n"
      : "";
    // The ORIGINAL rides along (2026-08-06): extraction is a convenience
    // read — figures, tables, and images in the source may matter, so the
    // raw PDF lands in the CAS and the reference links it.
    landed(t, await api.drop(`${slug(file.name)}.md`, `${head}${warn}\n${ex.text}\n`, [{ name: file.name, file }], progressOf(t)));
  }

  async function shipText(file: File, t: Tray): Promise<void> {
    const text = await file.text();
    if (/\.md$/i.test(file.name)) {
      // Shipped verbatim — but a note can still ride along now: the id
      // comes back from the landing, not from frontmatter we composed.
      // Verbatim still gets the voice claim: the claim must live in the
      // file's own frontmatter to survive, so it is injected there.
      landed(t, await api.drop(file.name, claimTitle(claimAgentVoice(text), file.name)));
      return;
    }
    const head = fm([
      ["source", "web-drop"],
      ["kind", "text-import"],
      ...AGENT_VOICE,
      ["title", t.title],
      ["filename", file.name],
      ["date", today()],
    ]);
    landed(t, await api.drop(`${slug(file.name)}.md`, `${head}\n${text}\n`));
  }

  // No size cap (2026-08-06): binaries land in the add-only CAS — disk,
  // not git history — so nothing here refuses by size anymore.
  async function shipFile(file: File, t: Tray): Promise<void> {
    const head = fm([
      ["source", "web-drop"],
      ["kind", "file-import"],
      ...AGENT_VOICE,
      ["title", t.title],
      ["filename", file.name],
      ["date", today()],
    ]);
    landed(t, await api.drop(`${slug(file.name)}.md`, `${head}`, [{ name: file.name, file }], progressOf(t)));
  }

  async function ship(file: File): Promise<void> {
    // $state at creation: the closures below mutate t AFTER awaits, and only
    // proxy mutations re-render. Pushing a raw object and mutating it would
    // update the array's copy invisibly — the card would sit on "sending…"
    // forever while the file lands fine.
    const t: Tray = $state({
      key: key++, filename: file.name, status: "sending", title: file.name,
      thin: false, note: "", noteStatus: "", id: undefined,
    });
    items.push(t);
    try {
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) await shipPdf(file, t);
      else if (/\.(md|txt)$/i.test(file.name) || file.type.startsWith("text/")) await shipText(file, t);
      else await shipFile(file, t);
      t.status = "sent";
      // Paint from the receipt before waiting on either the graph or a note.
      if (t.refPath) {
        recordArrival(t.refPath, t.title);
        gotoNote(t.refPath);
      }
      if (t.noteStatus === "queued") await postNote(t); // the note waited for the landing
      // Sent, nothing pending on the human, note already dispatched → done.
      if (t.noteStatus === "sent") setTimeout(() => dismiss(t), 900);
      // Keep the optional note available even when the upload finishes
      // before the person starts typing.
    } catch (e) {
      t.status = "failed";
      t.error = errText(e);
      console.error("bigbrain drop failed:", t.filename, e);
      if (t.noteStatus === "queued") {
        t.noteStatus = "failed";
        t.noteError = "not sent — the file didn't land";
      }
    }
  }

  // The note never ships before its document has landed — its ref is the
  // id the LANDING returns, so there is nothing to point at until then.
  // Submitted early it QUEUES, and ship() flushes it on the landing.
  //
  // Order matters here: the id now arrives asynchronously (it used to be
  // minted up front), so it must be tested AFTER the lifecycle states, or a
  // note typed while the file is still uploading returns silently and the
  // person watches their words go nowhere.
  function sendNote(t: Tray): void {
    const note = t.note.trim();
    if (!note || t.noteStatus === "sending" || t.noteStatus === "sent" || t.noteStatus === "queued") return;
    if (t.status === "failed") { t.noteStatus = "failed"; t.noteError = "not sent — the file didn't land"; return; }
    if (t.status !== "sent") { t.noteStatus = "queued"; return; }
    void postNote(t);
  }

  // The note is a DIRECTIVE, not a record of the world (issue #50): it is
  // what you want the editor to know about the thing you just dropped —
  // addressed to the editor, not to the vault. So it goes to the queue,
  // where it is a system message: it never becomes a peer row in the feed,
  // never enters the search corpus, and rides `refs` — a pointer that works
  // for any arrival, unlike the `about:`/shared-URL joins it replaces.
  // `queue/done/` is the permanent replay ledger, so the words outlive the
  // run that consumes them.
  async function postNote(t: Tray): Promise<void> {
    const note = t.note.trim();
    if (!t.id) {
      // Landed, but the engine reported no id — an older engine. Say so
      // rather than filing prose that points at nothing. Checked HERE, not
      // in sendNote: ship() flushes a queued
      // note by calling this directly, and both paths need the guard.
      t.noteStatus = "failed";
      t.noteError = "not sent — the host didn't report an id to attach this to";
      return;
    }
    t.noteStatus = "sending";
    t.noteError = undefined;
    try {
      await api.enqueue({ refs: [t.id], guidance: note });
      t.noteStatus = "sent";
      // Linger while the capture is still in flight so its outcome stays visible.
      if (t.status === "sent") setTimeout(() => dismiss(t), 900);
    } catch (e) {
      t.noteStatus = "failed";
      t.noteError = errText(e);
      console.error("bigbrain note failed:", t.filename, e);
    }
  }

  function dismiss(t: Tray): void {
    items = items.filter((i) => i.key !== t.key);
  }

  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

  // Folder drops never ride dataTransfer.files — a dragged directory shows
  // up there as one unreadable pseudo-File. The real contents come from the
  // entry API: webkitGetAsEntry() per item, then a recursive walk. Junk is
  // skipped only INSIDE a walk (dotfiles, Thumbs.db — nobody means to ship
  // .DS_Store with their folder); a file dropped directly always ships,
  // hidden or not — the person chose it.
  const JUNK = /^(\.|Thumbs\.db$|desktop\.ini$)/;

  function walkError(name: string, e: unknown): void {
    const t: Tray = $state({
      key: key++, filename: name, status: "failed", title: name,
      thin: false, note: "", noteStatus: "", id: undefined,
      error: `folder read failed — ${errText(e)}`,
    });
    items.push(t);
    console.error("bigbrain folder walk failed:", name, e);
  }

  async function filesOf(entry: FileSystemEntry): Promise<File[]> {
    if (entry.isFile)
      return [await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))];
    if (!entry.isDirectory) return [];
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const out: File[] = [];
    // readEntries returns BATCHES (Chrome caps each at 100) — drain until empty
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) {
        if (JUNK.test(child.name)) continue;
        out.push(...(await filesOf(child)));
      }
    }
    return out;
  }

  async function shipEntry(entry: FileSystemEntry): Promise<void> {
    try {
      for (const f of await filesOf(entry)) void ship(f);
    } catch (e) {
      walkError(entry.name, e); // a broken walk must not read as an empty folder
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragDepth = 0;
    // Grab every entry SYNCHRONOUSLY — the DataTransferItemList dies the
    // moment this handler yields, so no await may come before the map.
    const entries = Array.from(e.dataTransfer?.items ?? [])
      .map((i) => i.webkitGetAsEntry?.())
      .filter((x): x is FileSystemEntry => !!x);
    if (entries.length) {
      for (const entry of entries) void shipEntry(entry);
      return;
    }
    for (const file of e.dataTransfer?.files ?? []) void ship(file); // entry API absent — flat list fallback
  }

</script>

<svelte:window
  ondragenter={(e) => hasFiles(e) && (e.preventDefault(), (dragDepth += 1))}
  ondragleave={(e) => hasFiles(e) && (e.preventDefault(), (dragDepth = Math.max(0, dragDepth - 1)))}
  ondragover={(e) => hasFiles(e) && e.preventDefault()}
  ondrop={(e) => hasFiles(e) && onDrop(e)}
/>

{#if dragDepth > 0}
  <div class="veil">
    <div class="veil-card">
      <div class="veil-title">Drop to capture</div>
      <div class="veil-sub">Files or whole folders — PDFs are text-extracted here and land in the vault; your gardener files them.</div>
    </div>
  </div>
{/if}

{#snippet statusLabel(t: Tray)}
  <span class="state" class:ok={t.status === "sent"} class:err={t.status === "failed"}>
    {t.status === "sending" ? (uploading(t) ? `${t.leg === "encode" ? "preparing" : "uploading"} ${pct(t)}%` : "sending…") : t.status === "sent" ? "captured ✓" : "failed"}
  </span>
{/snippet}

{#snippet details(t: Tray)}
  {#if uploading(t)}
    <div class="progress"><div class="fill" style:width="{pct(t)}%"></div></div>
  {/if}
  {#if t.error}<div class="err detail">{t.error}</div>{/if}
  {#if t.status === "failed" && t.noteStatus === "failed"}
    <!-- the interactive note block hides on a failed drop — but a note that
         was QUEUED against it must not just vanish; say what became of it -->
    <div class="err detail">note failed{t.noteError ? ` — ${t.noteError}` : ""}</div>
  {/if}
  {#if t.thin && t.status === "sent"}
    <div class="warn detail">near-empty text layer — looks scanned; only the metadata made it</div>
  {/if}
{/snippet}

{#snippet noteRow(t: Tray)}
  {#if t.status !== "failed"}
    {#if t.noteStatus === "sent"}
      <div class="ok detail">note sent ✓</div>
    {:else if t.noteStatus === "queued"}
      <div class="detail muted">note queued — sends when the file lands</div>
    {:else}
      <div class="noterow">
        <input type="text" aria-label={`Note for ${t.filename}`} placeholder="Add a note (optional)…" bind:value={t.note}
          onkeydown={(e) => e.key === "Enter" && sendNote(t)} disabled={t.noteStatus === "sending"} />
        <button onclick={() => sendNote(t)} disabled={!t.note.trim() || t.noteStatus === "sending"}>
          {t.noteStatus === "sending" ? "…" : "Send"}
        </button>
      </div>
      {#if t.noteStatus === "failed"}<div class="err detail">note failed{t.noteError ? ` — ${t.noteError}` : ""} — Enter to retry</div>{/if}
    {/if}
  {/if}
{/snippet}

{#each items as t (t.key)}
  <StackNotice id={`capture:${t.key}`} title={t.filename} kind="capture" hasInput={t.status !== "failed" && !["sent", "queued", "sending"].includes(t.noteStatus)} onclear={() => dismiss(t)}>
    {#snippet status()}{@render statusLabel(t)}{/snippet}
    {@render details(t)}
    {@render noteRow(t)}
  </StackNotice>
{/each}

<style>
  .veil {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 72%, transparent);
    backdrop-filter: blur(2px);
    border: 3px dashed var(--accent);
    pointer-events: none;
  }
  .veil-card {
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: var(--r-card);
    box-shadow: var(--shadow-2);
    padding: 1.2rem 1.6rem;
    text-align: center;
  }
  .veil-title { font-size: 1.1rem; font-weight: 650; }
  .veil-sub { color: var(--muted); font-size: 0.85rem; margin-top: 0.3rem; }

  .state { font: var(--type-meta); color: inherit; white-space: nowrap; }
  .detail.ok { color: var(--text-strong); }
  .err { color: var(--err); }
  .warn { color: var(--warn); }
  .detail { font-size: 0.75rem; margin-top: 0.25rem; }
  .muted { color: var(--muted); }
  .progress {
    height: 3px;
    margin-top: 0.45rem;
    border-radius: 999px;
    background: var(--rule);
    overflow: hidden;
  }
  .progress .fill {
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.15s linear;
  }
  .noterow { display: flex; align-items: center; gap: 16px; }
  .noterow input {
    flex: 1; min-width: 0; font: var(--type-body); padding: 6px 0;
    border: 0; border-bottom: 1px solid var(--rule); border-radius: 0;
    background: transparent; color: var(--text-strong);
  }
  .noterow input::placeholder { color: var(--text-muted); opacity: 1; }
  .noterow button { font: var(--type-meta); padding: 6px 0; border: 0; background: none; color: var(--text-strong); cursor: pointer; }
  .noterow button:hover:enabled { text-decoration: underline; }
  .noterow button:disabled { opacity: .4; cursor: default; }
</style>
