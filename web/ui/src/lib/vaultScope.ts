/** One document belongs to one vault. A switch replaces the document, so old
 * closures, component state, and queued writes cannot become the new vault's work. */
type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const params = typeof location === "undefined" ? new URLSearchParams() : new URL(location.href).searchParams;
export const selectedVaults = [...new Set((params.get("vaults") ?? params.get("workspace") ?? "").split(",").filter(Boolean))];
export const personalIncluded = !selectedVaults.length || selectedVaults.includes('personal');
export const personalOnly = selectedVaults.length === 1 && personalIncluded;
export const selectedWorkspace = selectedVaults.length === 1 && !personalIncluded ? selectedVaults[0]! : null;
export const workspaceURL = (path: string) => selectedWorkspace ? `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(selectedWorkspace)}` : path;
export function switchVaults(ids: string[]): void {
  const url = new URL(location.href);
  url.searchParams.delete("workspace");
  if (ids.length) url.searchParams.set("vaults", [...new Set(ids)].sort().join(',')); else url.searchParams.delete("vaults");
  url.searchParams.set("vaultMenu","1");
  url.hash = "#/home";
  // A new query replaces the document even when the hash route is unchanged.
  location.replace(url.href);
}
export function switchWorkspace(id: string | null): void { switchVaults(id ? [id] : []); }
export function sharedUnavailable(): void {
  if (!selectedWorkspace) return;
  // Drop persisted response caches before restarting the document's auth gate.
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(`bb:vault:shared:${selectedWorkspace}:`)) sessionStorage.removeItem(key);
  } catch { /* Storage may be disabled; the authentication gate still closes. */ }
  window.dispatchEvent(new Event("shared-unavailable"));
}
const HEADER = "x-bigbrain-vault";
export class VaultScope {
  private identity: string | undefined;
  private starting: Promise<void> | undefined;
  private changed = false;
  private beforeSwitch = new Set<() => void>();
  constructor(private transport: BrowserFetch, private replaceDocument: () => void) {}
  onSwitch(fn: () => void): () => void { this.beforeSwitch.add(fn); return () => { this.beforeSwitch.delete(fn); }; }
  key(key: string): string { return `bb:vault:${this.identity ?? "unidentified"}:${key}`; }
  ready(): boolean { return this.identity !== undefined && !this.changed; }
  observe(next: string | null): void {
    if (!next || this.changed) return;
    if (this.identity === undefined) { this.identity = next; return; }
    if (this.identity === next) return;
    this.changed = true;
    for (const fn of this.beforeSwitch) fn();
    this.replaceDocument();
  }
  assertCurrent(): void {
    if (this.changed) throw new Error("The active vault changed. Reload before continuing.");
  }
  initialize(): Promise<void> {
    if (!this.starting) this.starting = (async () => {
      const response = await this.transport("/api/vault", { cache: "no-store" });
      if (!response.ok && response.status !== 404) throw new Error("The vault is unavailable. Try again.");
      // Older engines and fabricated previews have no boundary header. They get
      // a document-only namespace, never another document's persisted content.
      this.observe(response.headers.get(HEADER) ?? `preview-${crypto.randomUUID()}`);
      this.assertCurrent();
    })().catch(error => { this.starting = undefined; throw error; });
    return this.starting;
  }
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/api/")) return this.transport(input, init);
    await this.initialize();
    this.assertCurrent();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (this.identity && !this.identity.startsWith("preview-")) headers.set(HEADER, this.identity);
    const response = await this.transport(input, { ...init, headers });
    this.observe(response.headers.get(HEADER));
    this.assertCurrent();
    const json = response.json.bind(response), text = response.text.bind(response);
    response.json = async () => { const body = await json(); this.assertCurrent(); return body; };
    response.text = async () => { const body = await text(); this.assertCurrent(); return body; };
    return response;
  }
}
const scope = new VaultScope(async (input, init) => {
  const headers = new Headers(init?.headers);
  if(selectedVaults.length)headers.set("x-bigbrain-vault-filter",selectedVaults.join(","));
  if (selectedWorkspace) headers.set("x-bigbrain-workspace", selectedWorkspace);
  const response = await globalThis.fetch(input, { ...init, headers });
  return response;
}, () => {
  // Hide A immediately, including when the new document cannot reach B.
  document.documentElement.style.visibility = "hidden";
  location.reload();
});
export const vaultStorageKey = (key: string) => scope.key((selectedVaults.length?selectedVaults.slice().sort().join(",")+":":"")+key);
export const vaultReady = () => scope.ready();
export const onVaultSwitch = (fn: () => void) => scope.onSwitch(fn);
export const observeVault = (identity: string | null) => scope.observe(identity);
export const assertVaultCurrent = () => scope.assertCurrent();
export const initializeVault = () => scope.initialize();
export const vaultFetch: BrowserFetch = (input, init) => scope.fetch(input, init);
