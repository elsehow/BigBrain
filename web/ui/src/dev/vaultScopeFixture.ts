/** Fabricated A/B vaults for production-shell isolation regression. */
export function installVaultScopeFixture(): void {
  const base = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (!path.startsWith('/api/')) return base(input, init);
    const identity = localStorage.getItem('fixture-vault') ?? 'A';
    const expected = new Headers(init?.headers).get('x-bigbrain-vault');
    const headers = { 'x-bigbrain-vault': identity };
    if (expected && expected !== identity) return Response.json({ error: 'Vault changed' }, { status: 409, headers });
    if (path.startsWith('/api/note?')) {
      if (path.includes('late')) await new Promise(resolve => setTimeout(resolve, 1000));
      if (localStorage.getItem('fixture-vault-failure') === identity) return Response.json({ error: 'Fabricated offline vault' }, { status: 503, headers });
      return Response.json({ path: 'memory/index.md', title: `Vault ${identity}`, body: `Invented content from vault ${identity}`, kind: 'markdown' }, { headers });
    }
    const response = await base(input, init);
    const merged = new Headers(response.headers); merged.set('x-bigbrain-vault', identity);
    return new Response(response.body, { status: response.status, headers: merged });
  }) as typeof window.fetch;
}
