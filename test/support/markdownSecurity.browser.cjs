/** Real DOMPurify/marked rendering with synthetic hostile content; no vault access.
 * Run Vite and set SIDEBAR_PREVIEW_URL. Uses the production-shell workbench. */
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage();
    await page.goto(`${process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200'}/sidebar-workbench.html`);
    const result = await page.evaluate(async () => {
      const { md, sanitizeHtml } = await import('/src/lib/markdown.ts');
      window.securityProbe = 0;
      const sample = [
        '# Synthetic note', '**Ordinary formatting** and [safe link](https://example.com).',
        '<script>window.securityProbe++</script>',
        '<img src="data:,invalid" onerror="window.securityProbe++">',
        '<svg onload="window.securityProbe++"><a href="javascript:window.securityProbe++">bad</a></svg>',
        '<a href="javascript:window.securityProbe++">bad link</a>',
        '<iframe srcdoc="<script>parent.securityProbe++</script>"></iframe>',
        '<math><mtext><img src=x onerror="window.securityProbe++"></mtext></math>',
      ].join('\n\n');
      const container = document.createElement('div');
      container.innerHTML = sanitizeHtml(md(sample));
      document.body.append(container);
      await new Promise(resolve => setTimeout(resolve, 100));
      const forbiddenAttributes = [...container.querySelectorAll('*')].flatMap(node =>
        [...node.attributes].filter(a => /^on/i.test(a.name) || /^(?:javascript|vbscript):/i.test(a.value)).map(a => a.name));
      const result = { executions: window.securityProbe, forbiddenAttributes,
        scripts: container.querySelectorAll('script,iframe,object,embed').length,
        heading: container.querySelector('h1')?.textContent,
        bold: container.querySelector('strong')?.textContent,
        safe: container.querySelector('a[href="https://example.com"]')?.textContent };
      container.remove();
      return result;
    });
    assert.deepEqual(result, { executions: 0, forbiddenAttributes: [], scripts: 0,
      heading: 'Synthetic note', bold: 'Ordinary formatting', safe: 'safe link' });
    console.log('Hostile Markdown is inert; ordinary note formatting survives.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
