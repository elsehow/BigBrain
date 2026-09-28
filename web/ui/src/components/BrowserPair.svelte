<script lang="ts">
  // THE BROWSER CARD (#486) — the extension's row on the integrations
  // page. Three things, top to bottom: where to get the extension (the
  // Chrome and Firefox store listings), the one act that
  // pairs a browser (a code, shown here, typed into the extension's
  // options page), and the browsers that have paired — which is the token
  // store filtered to `via: pair`, because a page in the app's webview has
  // no other way to see an extension (lib/pair.ts).
  //
  // While a code is showing the card polls: the extension redeems it on
  // another surface entirely, and the moment it does the code is spent and
  // the browser is in the list — the card should say so without a reload.
  import { app } from "../lib/store.svelte";
  import { connections, revoke, type Connection } from "../lib/connect";
  import { openExternal } from "../lib/native";
  import { guardNotice, type Notice } from "../lib/notice";
  import { isBrowser, mintPair, pairState, CHROME_EXTENSION_URL, FIREFOX_EXTENSION_URL, secondsLeft, type PairState } from "../lib/pair";
  import { ago } from "../lib/utils";
  import CredentialRow from "./CredentialRow.svelte";
  import { tooltip } from "../lib/tooltip";

  let pair = $state<PairState | null | undefined>(undefined); // undefined: not asked yet
  let browsers = $state<Connection[]>([]);
  let busy = $state<string | null>(null); // "mint" | a token id mid-revoke
  let notice = $state<Notice | null>(null);
  let now = $state(Date.now());
  let copied = $state<string | null>(null); // the text most recently put on the clipboard

  // The code and the address both have to be TYPED into another window,
  // so each is one click to copy. The async clipboard needs a secure
  // context and a gesture; where it refuses (an http:// viewer over a
  // tunnel), the selection-and-execCommand path still works on a click.
  async function copy(text: string): Promise<void> {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    if (!ok) {
      notice = { ok: false, text: "couldn't reach the clipboard — select it and copy" };
      return;
    }
    copied = text;
    setTimeout(() => { if (copied === text) copied = null; }, 1600);
  }

  async function load(): Promise<void> {
    const [s, c] = await Promise.all([pairState(), connections()]);
    pair = s;
    browsers = (c ?? []).filter(isBrowser).filter((b) => !b.revoked);
  }
  $effect(() => { void app.rev; void load(); });

  // The clock, and the poll: one tick a second while a code is out — the
  // countdown reads it, and every third tick asks again whether the code
  // has been spent. Nothing runs while there is nothing to wait for.
  const pending = $derived(pair?.pending ?? null);
  const left = $derived(pending ? secondsLeft(pending, now) : 0);
  $effect(() => {
    if (!pending) return;
    let n = 0;
    const t = setInterval(() => {
      now = Date.now();
      if (++n % 3 === 0 || secondsLeft(pending, now) === 0) void load();
    }, 1000);
    return () => clearInterval(t);
  });

  const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  async function onMint(): Promise<void> {
    busy = "mint";
    notice = null;
    await guardNotice((n) => (notice = n), async () => {
      pair = await mintPair();
      now = Date.now();
    });
    busy = null;
  }

  async function onRevoke(b: Connection): Promise<void> {
    busy = b.id;
    await guardNotice((n) => (notice = n), async () => {
      await revoke(b.id);
      notice = { ok: true, text: `revoked — ${b.name} stops on its next capture` };
      await load();
    });
    busy = null;
  }
</script>

<div class="card">
  <div class="row">
    <div class="row-main">
      <span class="name">Browser extension</span>
      <span class="about">Send to BigBrain clips the page you're on into your vault in one click — Chrome, Firefox and their kin.</span>
      <span class="status">
        {#if pair === undefined}
          …
        {:else if browsers.length === 0}
          no browser paired yet
        {:else}
          {browsers.length === 1 ? "1 browser" : `${browsers.length} browsers`} paired
        {/if}
      </span>
    </div>
    <div class="store-links">
      <button class="btn-ghost" onclick={() => openExternal(CHROME_EXTENSION_URL)} use:tooltip={CHROME_EXTENSION_URL}>GET CHROME EXTENSION ↗</button>
      <button class="btn-ghost" onclick={() => openExternal(FIREFOX_EXTENSION_URL)} use:tooltip={FIREFOX_EXTENSION_URL}>GET FIREFOX EXTENSION ↗</button>
    </div>
  </div>

  {#if pair === null}
    <p class="how">The engine isn't answering — the pairing code lives there.</p>
  {:else if pending && left > 0}
    <div class="pairing">
      <div class="code-box">
        <button class="code" use:tooltip={"Copy"} onclick={() => copy(pending.code)}>{pending.code}</button>
        <span class="code-meta" class:did={copied === pending.code}>{copied === pending.code ? "copied" : `expires in ${mmss(left)}`}</span>
      </div>
      <p class="how">
        In the extension's options, set BIGBRAIN to
        <button class="inline-code" use:tooltip={"Copy"} onclick={() => copy(pair?.endpoint ?? "")}>{pair?.endpoint}</button>{#if copied === pair?.endpoint}<span class="did">copied</span>{/if}
        and enter this code. Click either to copy. The code works once. Waiting for the extension…
      </p>
      <div class="actions">
        <button class="btn-ghost" disabled={busy !== null} onclick={onMint}>{busy === "mint" ? "…" : "NEW CODE"}</button>
      </div>
    </div>
  {:else}
    <div class="pairing">
      <div class="actions">
        <button class="btn-save" disabled={busy !== null || pair === undefined} onclick={onMint}>
          {busy === "mint" ? "…" : "PAIR A BROWSER"}
        </button>
        <span class="how">Shows a code to enter in the extension's options. Each browser pairs once.</span>
      </div>
    </div>
  {/if}

  {#if notice}
    <p class="toast" class:err={!notice.ok}>{notice.text}</p>
  {/if}

  {#if browsers.length}
    <div class="conns">
      {#each browsers as b (b.id)}
        <CredentialRow name={b.name}
          meta={`paired ${ago(b.created)} · ${b.last_used ? `last capture ${ago(b.last_used)}` : "no captures yet"}`}
          busy={busy !== null} revoking={busy === b.id} onrevoke={() => onRevoke(b)} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .card { display: flex; flex-direction: column; gap: var(--sp-5); }

  /* the integration row, as IntegrationsView draws its vault.yaml rows */
  .row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--sp-6); }
  .store-links { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-3); }
  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .about { font: var(--type-body); color: var(--text-note); max-width: 520px; }
  .status { font: var(--type-meta); color: var(--text-muted); }

  .pairing { display: flex; flex-direction: column; gap: var(--sp-4); max-width: 520px; }
  .code-box { display: flex; align-items: baseline; gap: var(--sp-5); padding: 14px 18px;
    background: var(--well); border-radius: var(--r-chip); }
  .code { font-family: var(--font-mono); font-size: 26px; letter-spacing: 0.14em; color: var(--text-strong);
    background: none; border: none; padding: 0; margin: 0; cursor: pointer; user-select: all; }
  .code:hover { color: var(--text-note); }
  .code-meta { font: var(--type-meta); color: var(--text-muted); white-space: nowrap; }
  .did { color: var(--ok); }
  .how { margin: 0; font: var(--type-meta); line-height: 1.55; color: var(--text-note); }
  .inline-code { font-family: var(--font-mono); font-size: 12px; color: var(--text); background: var(--well);
    border: none; border-radius: var(--r-sm); padding: 1px 6px; margin: 0 2px; cursor: pointer; user-select: all; }
  .inline-code:hover { color: var(--text-strong); }
  .how .did { margin-left: var(--sp-2); font: var(--type-meta); }
  .actions { display: flex; align-items: center; gap: var(--sp-4); flex-wrap: wrap; }

  .toast { margin: 0; font: var(--type-mono); letter-spacing: 0.08em; color: var(--text-note); }
  .toast.err { color: var(--err); }

  /* the rows are CredentialRow; this is the column they stack in */
  .conns { display: flex; flex-direction: column; border-top: 1px solid var(--rule); max-width: 520px; }
</style>
