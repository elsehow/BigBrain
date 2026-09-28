<script lang="ts">
  import type { Snippet } from "svelte";
  import { stepped } from "../lib/listNav";
  import "../design/pilotReferenceChips.css";
  import { onMount, tick, untrack } from "svelte";
  import { mentionGlyph, parseMentions, serializeMentions, type MentionItem, type MentionPart } from "../../../../lib/pilotMentions";

  import type { MentionSuggestion } from "../lib/pilotMentionSuggestions";
  import { createSearchRunner } from "../lib/omnibox";
  const { onmenu = () => {}, controls, inputHint, initial = [], onimagepaste, value, autofocus = true, connected = [], connectedLabel = "Connected", recents, currentId, onchange, onsend, search, recentLoading = false, recentError = false, placeholder = "Message… type @ to mention" }: {
    controls?: Snippet; inputHint?: string;
    onmenu?: (open: boolean) => void;
    connected?: MentionSuggestion[]; connectedLabel?: string;
    onimagepaste?: (e: ClipboardEvent) => boolean;
    initial?: MentionPart[]; value?: string; autofocus?: boolean; recentLoading?: boolean; recentError?: boolean; placeholder?: string;
    search?: (query: string, signal: AbortSignal) => Promise<MentionSuggestion[]>; recents: MentionItem[]; currentId: string;
    onchange: (parts: MentionPart[]) => void; onsend: () => void;
  } = $props();
  const uid = $props.id();
  let editor: HTMLDivElement;
  let open = $state(false);
  let query = $state("");
  let selected = $state(0);
  let trigger: Range | undefined;
  const items = new Map<string, MentionItem>();
  $effect(() => { onmenu(open); });
  const connectedRows = $derived(!open ? [] : connected.filter(r => r.id !== currentId));
  const recentRows = $derived(recents.filter(r => r.id !== currentId && !connectedRows.some(c => c.id === r.id) && query.toLocaleLowerCase().trim().split(/\s+/).every(word => r.title.toLocaleLowerCase().includes(word))));
  // Context and recents seed the menu; typing always searches the whole vault.
  const searching = $derived(!!search && !!query.trim());
  let found = $state<MentionSuggestion[]>([]);
  let pending = $state(false);
  let failed = $state(false);
  const rows = $derived(searching ? found : [...connectedRows, ...recentRows] as MentionSuggestion[]);
  const runSearch = createSearchRunner<MentionSuggestion>({
    debounceMs: 100,
    search: async (q, signal) => ({ hits: await search!(q, signal) }),
    pending: () => { pending = true; failed = false; found = []; },
    cleared: () => { pending = false; failed = false; found = []; },
    settle: ({ hits, failed: error }) => { pending = false; failed = !!error; found = hits.filter(r => r.id !== currentId); selected = 0; },
  });
  $effect(() => { runSearch(open && searching ? query.trim() : ""); });
  $effect(() => { if (selected >= rows.length) selected = 0; });
  let published = "";
  let mounted = $state(false);
  // Local typing owns the DOM/caret. Only external draft changes replace it
  // (send clears, failed sends restore, or switching to another session).
  $effect(() => {
    const next = value;
    if (!mounted || next === undefined) return;
    untrack(() => { if (next !== published) { paint(parseMentions(next)); published = next; } });
  });

  function chip(item: MentionItem): HTMLSpanElement {
    items.set(item.id, item);
    const el = document.createElement("span");
    el.className = "mention-chip"; el.contentEditable = "false";
    el.dataset.mention = item.id; el.setAttribute("aria-label", `${item.tag.toLowerCase()}: ${item.title}`);
    el.textContent = item.title;
    return el;
  }
  function parts(): MentionPart[] {
    const result: MentionPart[] = [];
    function text(value: string): void {
      const last = result.at(-1);
      if (last && "text" in last) last.text += value;
      else if (value) result.push({ text: value });
    }
    function walk(node: Node): void {
      if (node.nodeType === Node.TEXT_NODE) { text(node.textContent ?? ""); return; }
      if (!(node instanceof HTMLElement)) return;
      const item = items.get(node.dataset.mention ?? "");
      if (item) { result.push({ mention: item }); return; }
      if (node.tagName === "BR") { text("\n"); return; }
      if (["DIV", "P"].includes(node.tagName) && result.length) text("\n");
      node.childNodes.forEach(walk);
    }
    editor.childNodes.forEach(walk);
    return result;
  }
  function publish(): void { const next = parts(); published = serializeMentions(next); onchange(next); }
  function changed(): void {
    publish(); refresh();
    // Scripted line breaks do not reliably scroll the caret into view in WebKit.
    // Wait for the composer to grow and the transcript to yield its space first.
    void tick().then(() => requestAnimationFrame(() => {
      const selection = window.getSelection();
      if (document.activeElement !== editor || !selection?.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.startContainer)) return;
      const caret = range.getBoundingClientRect();
      const bounds = editor.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(editor).paddingBottom) || 0;
      if (caret.height) {
        if (caret.bottom > bounds.bottom - padding) editor.scrollTop += caret.bottom - bounds.bottom + padding;
        else if (caret.top < bounds.top + padding) editor.scrollTop -= bounds.top + padding - caret.top;
      } else {
        // A trailing empty text node has no range rectangle, but is the new line.
        const remaining = range.cloneRange();
        remaining.selectNodeContents(editor); remaining.setStart(range.startContainer, range.startOffset);
        if (!remaining.toString().trim()) editor.scrollTop = editor.scrollHeight;
      }
    }));
  }
  function paint(next: MentionPart[]): void {
    const focused = document.activeElement === editor;
    editor.replaceChildren(...next.map(p => "text" in p ? document.createTextNode(p.text) : chip(p.mention)));
    dismiss(); if (focused) focus(true);
  }
  function dismiss(): void { open = false; trigger = undefined; }
  /** The @ at the caret, if the caret sits in plain text right after one. */
  function caretMention(): { node: Node; range: Range; query: string } | undefined {
    const selection = window.getSelection();
    if (!selection?.isCollapsed || !selection.rangeCount || document.activeElement !== editor) return;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    // Match only text at the caret: emails and text inside an existing chip aren't triggers.
    if (node.nodeType !== Node.TEXT_NODE || !editor.contains(node) || node.parentElement?.closest("[data-mention]")) return;
    const match = (node.textContent?.slice(0, range.startOffset) ?? "").match(/(?:^|\s)@([^@\n]*)$/);
    return match ? { node, range, query: match[1]! } : undefined;
  }
  /** The @ the user escaped from. selectionchange fires on its own schedule
   * — after fill, focus, keyup — and would reopen the menu the moment it
   * ran, undoing the Escape (a CI flake, 2026-09-25). It stays closed until
   * the text after that @ changes or the caret leaves it. */
  let escaped: { node: Node; query: string } | undefined;
  function escape(): void { escaped = caretMention(); dismiss(); }
  function refresh(): void {
    const at = caretMention();
    if (!at) { escaped = undefined; dismiss(); return; }
    if (escaped && escaped.node === at.node && escaped.query === at.query) return;
    escaped = undefined;
    if (!open || query !== at.query) selected = 0;
    query = at.query;
    trigger = at.range.cloneRange(); trigger.setStart(at.node, at.range.startOffset - at.query.length - 1);
    open = true;
  }
  export function focus(moveToEnd = false): void {
    if (!editor || (!moveToEnd && document.activeElement === editor)) return;
    editor.focus();
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    if (editor.lastChild?.nodeType === Node.TEXT_NODE) range.setStart(editor.lastChild, editor.lastChild.textContent?.length ?? 0);
    range.collapse(true);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); refresh();
  }
  export function blur(): void { editor?.blur(); }
  export function dismissMenu(): boolean { const wasOpen = open; escape(); return wasOpen; }
  export function clear(): void { editor.replaceChildren(); dismiss(); publish(); }
  function choose(item: MentionItem): void {
    if (!trigger) return;
    editor.focus();
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(trigger);
    // Native editing preserves undo/redo. HTML is built exclusively with DOM text nodes.
    document.execCommand("insertHTML", false, chip(item).outerHTML + "&nbsp;");
    dismiss(); publish();
  }
  function keydown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (open && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (["Home", "End", "ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === "Escape") escape();
        else if (["Home", "End", "ArrowDown", "ArrowUp"].includes(e.key)) {
          selected = e.key === "Home" ? 0 : e.key === "End" ? Math.max(0, rows.length - 1) : rows.length ? stepped(selected, e.key === "ArrowDown" ? 1 : -1, rows.length) : 0;
          void tick().then(() => document.getElementById(`${uid}-${selected}`)?.scrollIntoView({ block: "nearest" }));
        } else if (rows[selected]) choose(rows[selected]);
        return;
      }
    }
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) { dismiss(); document.execCommand("insertLineBreak"); changed(); }
      else { dismiss(); onsend(); }
    }
  }
  onMount(() => {
    const next = value === undefined ? initial : parseMentions(value);
    paint(next); published = serializeMentions(next); mounted = true;
    if (autofocus) focus();
    document.addEventListener("selectionchange", refresh);
    return () => { runSearch(""); document.removeEventListener("selectionchange", refresh); };
  });
</script>

<div class="mention-composer">
  {@render controls?.()}
  {#if open}
    <div class="mention-menu">
      <div class="menu-label">{searching ? "Search results" : connectedRows.length ? connectedLabel : "Recent"}</div>
      <div class="options" role="listbox" id={`${uid}-list`} aria-label={searching ? "Mention a search result" : "Mention a suggested item"} aria-busy={searching ? pending : recentLoading}>
        {#each rows as item, i (item.id)}
          {#if !searching && connectedRows.length && i === connectedRows.length}<div class="menu-label" role="presentation">Recent</div>{/if}
          <!-- svelte-ignore a11y_click_events_have_key_events (the editor owns keyboard navigation) -->
          <div role="option" tabindex="-1" id={`${uid}-${i}`} aria-selected={selected === i} class:chosen={selected === i}
            onpointerdown={e => e.preventDefault()} onpointermove={() => selected = i} onclick={() => choose(item)}>
            <span class="glyph" aria-hidden="true">{mentionGlyph(item)}</span>
            <span class="title">{item.title}{#if item.hint}<small>{item.hint}</small>{/if}</span><span class="tag">{item.tag}</span><span class="date">{item.date}</span>
          </div>
        {:else}<div class="empty" role="status">{searching ? pending ? "Searching…" : failed ? "Search failed. Edit your query to try again." : "No matching items" : recentLoading ? "Loading recent items…" : recentError ? "Couldn’t load recents. Type to search." : "No matching recent items"}</div>{/each}
      </div>
      <div class="menu-hints">↑↓ Choose <span>↵ Mention</span><span>Esc Dismiss</span></div>
    </div>
  {/if}
  <!-- Opt out of WebKit's inline predictions without disabling spellcheck or the @ picker. -->
  <div bind:this={editor} class="editor" contenteditable="true" writingsuggestions="false" role="textbox" tabindex="0" aria-label="Message Pilot"
    aria-multiline="true" aria-autocomplete="list" aria-haspopup="listbox"
    aria-controls={open ? `${uid}-list` : undefined} aria-activedescendant={open && rows.length ? `${uid}-${selected}` : undefined}
    aria-keyshortcuts={inputHint} data-input-hint={inputHint} data-placeholder={placeholder} oninput={changed} onkeydown={keydown} onblur={dismiss}
    onpaste={e => { if (onimagepaste?.(e)) return; e.preventDefault(); document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? ""); changed(); }}></div>
</div>

<style>
  .mention-composer { position: relative; }
  .mention-composer::before { content: ""; position: absolute; top: 0; left: 20px; right: 20px; border-top: 1px solid var(--rule); pointer-events: none; }
  .editor { padding: 14px 20px; min-height: 52px; max-height: 150px; overflow-y: auto; box-sizing: border-box; outline: none;
    font: var(--fw-regular) var(--fs-chip)/1.7 var(--font-app); color: var(--text-strong); white-space: pre-wrap; overflow-wrap: anywhere; caret-color: transparent; }
  .editor[data-input-hint]:empty:not(:focus)::after { content:"  " attr(data-input-hint); color:var(--text-muted); font:var(--type-meta); pointer-events:none; }
  .editor:focus { caret-color: var(--activity); }
  .editor:empty::before { content: attr(data-placeholder); color: var(--text-faint); pointer-events: none; }
  .mention-menu { position: absolute; z-index: 8; bottom: calc(100% + 8px); left: 12px; width: min(660px, calc(100% - 24px));
    border: 1px solid var(--rule); border-radius: 12px; background: var(--bg); color: var(--text-strong); box-shadow: var(--shadow-card); padding: 8px; }
  .menu-label, .menu-hints { color: var(--text-muted); font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: 1px; padding: 7px 10px 10px; }
  .options { max-height: min(280px, 33vh); overflow-y: auto; scrollbar-width: thin; }
  [role="option"] { display: grid; grid-template-columns: 18px minmax(0, 1fr) 64px 110px; gap: 10px; align-items: center; padding: 11px 12px; border-radius: 7px; cursor: pointer; font: var(--type-chip); }
  .chosen { background: var(--fg); color: var(--bg); }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title small { display: block; overflow: hidden; text-overflow: ellipsis; font-size: 11px; opacity: .65; margin-top: 3px; }
  .glyph { text-align: center; font-size: 12px; }
  .tag, .date { font: 10px var(--font-mono); opacity: .65; white-space: nowrap; }
  .date { text-align: right; }
  .menu-hints { display: flex; gap: 18px; padding-bottom: 3px; border-top: 1px solid var(--rule); margin-top: 6px; padding-top: 10px; }
  .empty { padding: 18px 12px; font: var(--type-chip); color: var(--text-muted); }
  @media (max-width: 600px) { [role="option"] { grid-template-columns: 16px minmax(0, 1fr) 52px; gap: 7px; } .date { display: none; } }
</style>
