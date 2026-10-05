// Shared diagnostics for synthetic browser regressions. The suite runner keeps
// these files only when a script fails; individual scripts remain runnable.
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { mkdirSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const directory = process.env.CI_BROWSER_ARTIFACTS;
let sequence = 0;

function instrument(browser) {
  const createContext = browser.newContext.bind(browser);
  const saves = new Map();
  browser.newContext = async (...args) => {
    // Functional Linux coverage avoids continuous software-rendered graph
    // animation. Explicit per-test motion settings still take precedence.
    const options = process.env.CI_BROWSER_REDUCED_MOTION === 'reduce'
      ? { reducedMotion: 'reduce', ...args[0] } : args[0];
    const context = await createContext(options);
    // The suite covers the Classic view; Field is the base's default (lib/viewChoice.svelte.ts).
    await context.addInitScript(() => { try { if (!localStorage.getItem('bb:view')) localStorage.setItem('bb:view', 'classic'); } catch {} });
    const id = ++sequence;
    // Continuous DOM recording and screencasting compete with software WebGL.
    // Linux retains action traces, logs and a final image; macOS also records
    // DOM snapshots and the filmstrip for the primary merge gate.
    const detailed = process.platform !== 'linux';
    await context.tracing.start({ screenshots: detailed, snapshots: detailed });
    context.on('page', page => {
      page.on('console', message => appendFileSync(join(directory, 'console.log'), `${message.type()}: ${message.text()}\n`));
      page.on('pageerror', error => appendFileSync(join(directory, 'console.log'), `${error.stack}\n`));
    });
    let saved = false;
    const save = async () => {
      if (saved) return;
      saved = true;
      for (const [index, page] of context.pages().entries()) {
        await page.screenshot({ path: join(directory, `context-${id}-page-${index}.png`), timeout: 3000 }).catch(() => {});
      }
      await context.tracing.stop({ path: join(directory, `context-${id}-trace.zip`) }).catch(error => {
        appendFileSync(join(directory, 'console.log'), `Trace unavailable: ${error.message}\n`);
      });
    };
    saves.set(context, save);
    const close = context.close.bind(context);
    context.close = async (...closeArgs) => { await save(); saves.delete(context); return close(...closeArgs); };
    return context;
  };
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    await Promise.all([...saves.values()].map(save => save()));
    return close(...args);
  };
  return browser;
}

module.exports = directory ? {
  ...playwright,
  chromium: new Proxy(playwright.chromium, {
    get(target, key) {
      if (key === 'launch') return async (...args) => {
        mkdirSync(directory, { recursive: true });
        return instrument(await target.launch(...args));
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }),
} : playwright;
