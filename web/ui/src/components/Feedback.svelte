<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";

  import { tick, untrack } from 'svelte';
  import { appVersion } from '../lib/native';
  import { FEEDBACK_LIMIT, type FeedbackInput, type FeedbackPanel } from '../../../../lib/feedbackSchema';

  let { open = $bindable(false), visible, panel, expanded, wake }: {
    open?: boolean; visible: boolean; panel: FeedbackPanel; expanded: boolean; wake: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let textarea = $state<HTMLTextAreaElement>();
  let trigger: HTMLButtonElement;
  let message = $state('');
  let busy = $state(false);
  let error = $state('');
  let sent = $state(false);
  let context = $state({ panel: 'home' as FeedbackPanel, layout: 'standard' as FeedbackInput['layout'], version: 'unknown' });
  let attempt: FeedbackInput | undefined;

  async function show() {
    // Keep the original context with a failed draft, including across reopen.
    if (!message && !busy) {
      context = { panel, layout: expanded ? 'expanded' : 'standard', version: 'unknown' };
      const version = await appVersion();
      if (version && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,32})?$/.test(version)) context.version = version;
    }
    open = true;
  }
  function close() {
    dialog.close();
    open = false; wake();
    trigger.focus();
  }
  // Focus stays inside: native dialog focus behavior varies between WebKit and
  // Chrome, so wrap Tab explicitly. Esc is the dialog's own cancel; and being
  // modal, it keeps the app's shortcuts (lib/shortcuts.svelte.ts) off.
  function trapTab(event: KeyboardEvent) {
    if (event.isComposing || event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), a[href]')];
    const index = controls.findIndex(control => control === document.activeElement);
    event.preventDefault();
    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
  }
  $effect(() => {
    if (open) untrack(() => { dialog.showModal(); void tick().then(() => { if (open) textarea?.focus(); }); });
    else dialog?.close();
  });
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (busy || sent || !message.trim()) return;
    const next = { message: message.trim(), ...context };
    if (!attempt || JSON.stringify({ ...attempt, id: undefined }) !== JSON.stringify({ ...next, id: undefined })) {
      attempt = { ...next, id: crypto.randomUUID() };
    }
    busy = true; error = '';
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(attempt), signal: AbortSignal.timeout(12_000),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : 'Could not send feedback. Please try again.');
      sent = true; message = ''; attempt = undefined;
    } catch (failure) {
      error = failure instanceof Error && !['TypeError', 'TimeoutError', 'AbortError', 'SyntaxError'].includes(failure.name)
        ? failure.message : 'Could not send feedback. Check your connection and try again. Your draft is still here.';
    } finally { busy = false; }
  }
</script>

<button bind:this={trigger} class="feedback-trigger" class:visible aria-haspopup="dialog" onclick={() => { if (!busy) sent = false; void show(); }} onfocus={wake}>Feedback</button>
<dialog bind:this={dialog} aria-labelledby="feedback-title" oncancel={(event) => { event.preventDefault(); close(); }} onkeydown={trapTab}>
  <form onsubmit={send}>
    <header><h2 id="feedback-title">Feedback</h2><button type="button" aria-label="Close feedback" onclick={close}>×</button></header>
    {#if sent}
      <p role="status">Thanks — your feedback was sent.</p>
      <button type="button" onclick={close}>Done</button>
    {:else}
      <label for="feedback-message">What could we improve?</label>
      <textarea bind:this={textarea} id="feedback-message" bind:value={message} maxlength={FEEDBACK_LIMIT} disabled={busy} rows="5" required aria-describedby="feedback-disclosure"></textarea>
      <p id="feedback-disclosure">Only your message and basic app diagnostics are sent—not your vault contents. <a href="https://bigbrain.cool/privacy" target="_blank" rel="noopener noreferrer">Read more</a>.</p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <footer><span>{message.length.toLocaleString()} / {FEEDBACK_LIMIT.toLocaleString()}</span><button type="submit" disabled={busy || !message.trim()}>{busy ? 'Sending…' : error ? 'Try again' : 'Send feedback'}</button></footer>
    {/if}
  </form>
</dialog>

<style>
  .feedback-trigger { position: fixed; right: 20px; bottom: 18px; z-index: 80; opacity: 0; pointer-events: none; transition: opacity 140ms, background-color 140ms, border-color 140ms, color 140ms; color: var(--text-muted); background: var(--bg); border: 1px solid var(--rule); border-radius: 0; padding: 6px 10px; font: var(--type-meta); cursor: pointer; }
  .feedback-trigger.visible, .feedback-trigger:focus, .feedback-trigger:hover { opacity: 1; pointer-events: auto; }
  dialog { color: var(--text); background: var(--bg); border: 1px solid var(--rule); border-radius: 0; padding: 22px; width: min(420px, calc(100vw - 48px)); max-height: calc(100dvh - 48px); box-sizing: border-box; box-shadow: 0 12px 48px #0003; }
  dialog::backdrop { background: #0003; }
  form { display: grid; gap: 12px; }
  header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2, p { margin: 0; }
  h2 { font: var(--type-title); }
  label { font: var(--type-body); }
  p, footer span { color: var(--text-muted); font: var(--type-meta); line-height: 1.5; }
  textarea { box-sizing: border-box; width: 100%; resize: vertical; min-height: 110px; max-height: 35vh; background: var(--bg); color: var(--text); border: 1px solid var(--rule); border-radius: 0; padding: 10px; font: var(--type-body); }
  button { font: var(--type-meta); color: var(--text); background: var(--bg); border: 1px solid var(--rule); border-radius: 0; padding: 6px 10px; cursor: pointer; }
  button:not(:disabled):is(:hover, :focus-visible) { background: var(--well); border-color: var(--dash); color: var(--text-strong); }
  textarea:not(:disabled):hover { border-color: var(--dash); }
  textarea:focus-visible { border-color: var(--activity); }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid var(--activity); outline-offset: 3px; }
  button, textarea { transition: background-color 140ms, border-color 140ms, color 140ms; }
  a { color: inherit; text-underline-offset: 2px; }
  .error { color: var(--text); }
  @media (prefers-reduced-motion: reduce) { .feedback-trigger, button, textarea { transition: none; } }
</style>
