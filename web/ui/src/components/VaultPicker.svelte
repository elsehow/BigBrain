<script lang="ts">
  // THE FOLDER — one control, two homes. On first run it is the whole
  // screen's question (FirstRun.svelte); in settings it is the vault card
  // (VaultSettingsView.svelte) — the SAME two rows, by Nick's call
  // (2026-08-27): switching is choosing again. Obsidian's shape: a row per
  // act, a button on the right, and the native folder dialog behind it.
  // "Create" and "Open" are the same act against the engine — a folder,
  // which becomes a vault if it is empty and is adopted if it already is
  // one — so the rows differ in what they say, not in what they do; the
  // folder that turns out to hold something else is reported under them
  // and nothing is touched.
  //
  // The dialog is the shell's (lib/native.ts). Where there is none — a plain
  // browser tab, the workbench, a headless host — the button reveals a
  // typed path instead, so the act is never out of reach.
  import { chooseFolder, hasFolderDialog } from "../lib/native";
  import { shortPath } from "../lib/setup";

  let {
    current = null,
    suggested,
    pick,
    onPick,
  }: {
    /** The vault in use, or null on first run. Picking it again is a no-op. */
    current?: { path: string; created: string | null } | null;
    /** First run: where the app was pointed at with nothing there. */
    suggested?: string;
    /** The shell's verdict on a folder the person named, pinned to that path. */
    pick?: { path: string; problem: string };
    /** Create (or adopt, or switch to) the vault at this path. Awaited:
     * the button reads "…" until the act has answered. */
    onPick?: (path: string) => Promise<void> | void;
  } = $props();

  // `primary`: Obsidian's split — Create is the ink-filled button, Open
  // the quiet one; a person with a vault already reads the row that is theirs.
  interface Row { key: string; head: string; about: string; button: string; title: string; primary: boolean }
  const native = hasFolderDialog();
  const rows: Row[] = [
    { key: "create", head: "Create new vault", about: "A new BigBrain vault in a folder you choose.", button: "CREATE", title: "Choose a folder for your new vault", primary: true },
    { key: "open", head: "Open folder as vault", about: "A folder that already holds a BigBrain vault.", button: "OPEN", title: "Open a folder as your vault", primary: false },
  ];

  // The typed fallback: which row opened it, and what it holds. Starts on
  // the folder the shell suggested, or the vault in use.
  let typing = $state<string | null>(null);
  let path = $state("");
  $effect(() => {
    path = pick?.path ?? shortPath(current?.path ?? suggested ?? "~/vault");
  });
  // The problem line follows the last folder chosen: a verdict from the
  // shell is about that path, and picking another clears it.
  let chosen = $state<string | null>(null);
  const problem = $derived(pick && (chosen === null || chosen === pick.path) ? pick.problem : null);
  let busy = $state<string | null>(null);

  async function act(row: Row): Promise<void> {
    if (busy) return;
    if (!native) {
      typing = typing === row.key ? null : row.key;
      return;
    }
    const folder = await chooseFolder(row.title, current?.path ?? suggested);
    if (folder) await go(folder, row.key);
  }

  async function go(folder: string, key: string): Promise<void> {
    const p = folder.trim();
    if (!p || busy) return;
    if (current && shortPath(current.path) === shortPath(p)) return; // already the vault in use
    chosen = p;
    busy = key;
    try {
      await onPick?.(p);
    } finally {
      busy = null;
    }
  }
</script>

<div class="picker">
  {#each rows as row (row.key)}
    <div class="row">
      <div class="row-main">
        <span class="head">{row.head}</span>
        <span class="about">{row.about}</span>
      </div>
      <button class="act" class:primary={row.primary} onclick={() => act(row)} disabled={busy !== null}>
        {busy === row.key ? "…" : row.button}
      </button>
    </div>
    {#if !native && typing === row.key}
      <!-- no dialog here: the same act, typed -->
      <div class="typed">
        <input type="text" bind:value={path} spellcheck="false" autocapitalize="off" placeholder="~/vault"
          onkeydown={(e) => e.key === "Enter" && go(path, row.key)} disabled={busy !== null} />
        <button class="ghost" onclick={() => go(path, row.key)} disabled={!path.trim() || busy !== null}>GO</button>
      </div>
    {/if}
  {/each}
  {#if problem}
    <p class="problem">{problem}</p>
  {/if}
</div>

<style>
  .picker { display: flex; flex-direction: column; }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-6);
    padding: 16px 0;
    border-top: 1px solid var(--rule);
  }
  .row:first-child { border-top: 0; }
  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .head { font-size: 15px; font-weight: 600; color: var(--text-strong); }
  .about { font-size: 13.5px; line-height: 1.5; color: var(--text-muted); }
  button {
    font: var(--type-chip);
    font-weight: 600;
    letter-spacing: 0.06em;
    white-space: nowrap;
    min-width: 96px;
    padding: 9px 16px;
    border: 1px solid var(--rule);
    border-radius: var(--r-sm);
    background: none;
    color: var(--text);
    cursor: pointer;
  }
  button:disabled { opacity: 0.45; cursor: default; }
  .act { flex: none; }
  .act:not(:disabled):hover, .ghost:not(:disabled):hover { background: var(--well); }
  /* Primary actions use the theme’s monochrome ink and paper. */
  .act.primary { background: var(--text-strong); color: var(--bg); border-color: var(--text-strong); }
  .act.primary:not(:disabled):hover { background: var(--text-strong); filter: brightness(1.1); }
  .typed { display: flex; gap: var(--sp-2); padding: 0 0 16px; }
  input {
    flex: 1;
    min-width: 0;
    font: var(--type-mono);
    padding: 9px 11px;
    border: 1px solid var(--rule);
    border-radius: var(--r-sm);
    background: var(--surface);
    color: var(--text);
  }
  .problem { margin: 4px 0 0; padding-top: 12px; border-top: 1px solid var(--rule);
    font-size: 13px; line-height: 1.5; color: var(--accent-2); }
</style>
