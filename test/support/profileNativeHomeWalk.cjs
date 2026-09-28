/** Run the installed Tauri shell against this checkout's isolated AppShell.
 * PROFILE_GRAPH_FILE=/tmp/home-walk-graph.json REPEATS=3 node test/support/profileNativeHomeWalk.cjs
 * Requires macOS, AeroSpace and the worktree Vite server on 53490.
 * No installed-app replacement or live vault: a fresh scratch vault has no
 * integrations, while the webview uses fabricated workbench APIs.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
const built = process.env.PROFILE_BUILD_DIR;
const bundle = '/Applications/BigBrain.app/Contents';
const width = Number(process.env.PROFILE_WIDTH || 3790), height = Number(process.env.PROFILE_HEIGHT || 1183);
const working = process.env.PROFILE_WORKING === '1';
const theme = process.env.PROFILE_THEME || 'default';
const effects = (process.env.PROFILE_EFFECTS || 'all').split(',');
assert(['default', 'dusk', 'phosphor'].includes(theme));
assert(effects.every(e => ['none', 'glow', 'shadows', 'trails', 'breathing', 'all'].includes(e)));
const repeats = Number(process.env.REPEATS || 3);
const out = process.env.PROFILE_OUT || '/tmp/native-home-walk.json';
const graph = JSON.parse(fs.readFileSync(process.env.PROFILE_GRAPH_FILE || '/tmp/home-walk-graph.json', 'utf8'));
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const script = fs.readFileSync(path.join(__dirname, 'nativeHomeWalk.js'), 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor((sorted.length - 1) * .95)],
    over12_5ms: sorted.filter(v => v > 12.5).length, over25ms: sorted.filter(v => v > 25).length };
};
(async () => {
  if (built) assert(effects.length === 1 && effects[0] === 'all', 'built production uses the shipped all-effects preset');
  assert(Number.isInteger(repeats) && repeats > 0);
  assert(Number.isInteger(width) && width >= 720 && Number.isInteger(height) && height >= 480);
  const results = [], scratch = fs.mkdtempSync('/tmp/bb-native-walk-');
  const windowProbe = path.join(scratch, 'window-state');
  execFileSync('swiftc', ['-module-cache-path', '/tmp/bb-native-profile-swift-cache', path.join(__dirname, 'profileNativeWindow.swift'), '-o', windowProbe]);
  const nativeState = pid => JSON.parse(execFileSync(windowProbe, [String(pid)], { encoding: 'utf8' }));
  const vault = path.join(scratch, 'vault'); fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'vault.yaml'), 'auth: max\nintegrations: {}\n');
  execFileSync('git', ['init', '-q', vault]);
  execFileSync('git', ['-C', vault, '-c', 'user.name=Profiling fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Empty profiling vault']);
  const shellBundle = fs.readFileSync(path.join(bundle, 'Resources/resources/engine/BUNDLE'), 'utf8').trim();
  for (let repeat = 0; repeat < repeats; repeat++) {
    const probes = (process.env.PROFILE_PROBES || 'webgl').split(',');
    assert(probes.every(probe => ['webgl', 'blank'].includes(probe)));
    const cases = probes.flatMap(probe => (probe === 'webgl' ? effects : ['none']).map(effect => ({ probe, effect })));
    if (repeat % 2) cases.reverse();
    for (const { probe, effect } of cases) {
      let result, failure, ready, start = false, child, nativeBefore;
      const interrupted = () => { failure = { message: 'Native profiling interrupted' }; };
      process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          if (url.pathname === '/__native-profile-event') {
            let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2e6) throw Error('Oversized profile'); }
            const event = JSON.parse(raw);
            if (event.type === 'ready') ready = event.value;
            if (event.type === 'result') result = event.value;
            if (event.type === 'failure') failure = event.value;
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ start })); return;
          }
          if (url.pathname.startsWith('/api/') || req.method !== 'GET') { res.writeHead(403); res.end(); return; }
          if (url.pathname === '/__profile_graph.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(graph)); return; }
          if (url.pathname === '/__native-profile.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(`window.nativeWalkConfig=${JSON.stringify({ nodes: graph.nodes.length, probe, effect, theme })};\n${script}`); return; }
          if (probe === 'blank' && url.pathname === '/sidebar-workbench.html') {
            res.setHeader('Content-Type', 'text/html');
            res.end(`<!doctype html><html><head><script src="/__native-profile.js"></script></head><body><p id="preview-provenance">Blank native cadence control ${commit}</p></body></html>`); return;
          }
          if (built) {
            const file = path.resolve(built, url.pathname === '/sidebar-workbench.html' ? 'graph-production.html' : '.' + url.pathname);
            if (!file.startsWith(path.resolve(built) + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
            const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
            let body = fs.readFileSync(file);
            if (file.endsWith('.html')) body = Buffer.from(body.toString().replace('<head>', `<head><script src="/__native-profile.js"></script>`)
              .replace('</body>', `<aside id="preview-provenance">Built production entry · ${commit}</aside></body>`));
            res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); res.end(body); return;
          }
          // Serve only this loopback preview.
          const response = await fetch(new URL(req.url, base));
          let body = Buffer.from(await response.arrayBuffer());
          if (url.pathname === '/sidebar-workbench.html') body = Buffer.from(body.toString().replace('<head>', '<head><script src="/__native-profile.js"></script>'));
          res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
        } catch (error) { failure = { message: String(error) }; res.writeHead(500); res.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const webPort = await freePort(), apiPort = await freePort();
      const log = fs.openSync(path.join(scratch, `${repeat}-${probe}-${effect}.log`), 'w');
      try {
        child = spawn(path.join(bundle, 'MacOS/bigbrain-desktop'), [], { cwd: root, env: { ...process.env,
          BIGBRAIN_ENGINE: root, BIGBRAIN_DEV: '1', BIGBRAIN_VAULT: vault,
          BIGBRAIN_WEB_PORT: String(webPort), BIGBRAIN_API_PORT: String(apiPort),
          BIGBRAIN_WEB_URL: `http://127.0.0.1:${server.address().port}/sidebar-workbench.html?graphSnapshot=/__profile_graph.json&graphEffects=${effect}&graphTheme=${theme}&graphWorking=${Number(working)}`,
        }, stdio: ['ignore', log, log] });
        child.on('error', error => { failure = { message: String(error) }; });
        let windowId, resizeAfter = 0;
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline && !result && !failure) {
          assert(child.exitCode === null, `Native shell exited; see ${scratch}`);
          if (!windowId) {
            const windows = execFileSync('aerospace', ['list-windows', '--all', '--format', '%{window-id}|%{app-pid}'], { encoding: 'utf8' });
            const own = windows.trim().split('\n').filter(line => Number(line.split('|')[1]) === child.pid);
            if (own.length === 1) {
              windowId = own[0].split('|')[0];
              execFileSync('aerospace', ['layout', '--window-id', windowId, 'floating']);
              execFileSync('aerospace', ['focus', '--window-id', windowId]);
            }
          }
          if (windowId && ready && !start && Date.now() >= resizeAfter) {
            if (ready.width === width && ready.height === height) {
              const state = nativeState(child.pid);
              if (state.active && !state.hidden && state.visibleMainWindows === 1 && !ready.hidden) { nativeBefore = state; start = true; }
              else { execFileSync('aerospace', ['focus', '--window-id', windowId]); resizeAfter = Date.now() + 1000; }
            }
            else {
              execFileSync('osascript', ['-e', `on run argv
                tell application "System Events"
                  tell (first application process whose unix id is (item 1 of argv as integer))
                    tell window 1
                      set oldSize to size
                      set position to {20, 45}
                      set size to {(item 1 of oldSize) + (item 2 of argv as integer), (item 2 of oldSize) + (item 3 of argv as integer)}
                    end tell
                  end tell
                end tell
              end run`, String(child.pid), String(width - ready.width), String(height - ready.height)]);
              ready = undefined;
              // AX resizing returns before WKWebView reports its new viewport.
              // Let fresh ready messages replace any queued pre-resize sample.
              resizeAfter = Date.now() + 1000;
            }
          }
          await pause(100);
        }
        assert(!failure, JSON.stringify(failure)); assert(result, `Native profile timed out; see ${scratch}`);
        assert(result.native && result.provenance.includes(commit), 'native shell must show this checkout');
        assert.equal(result.renderer, probe);
        if (probe === 'webgl') {
          assert.equal(result.effect, effect); assert.equal(result.theme, theme);
          if (working) assert(result.workingAgents > 0, 'working-agent workload must be present');
          if (working && ['breathing', 'all'].includes(effect)) assert(result.breathingDrawCalls > 0, 'working-agent halo must render during measurement');
          const expectedEffects = effect === 'breathing' ? result.workingAgents > 0 : effect !== 'none' && (effect !== 'glow' || theme !== 'default');
          assert.equal(result.effectDrawCalls > 0, expectedEffects, 'requested effects must actually render');
        }
        assert((probe === 'blank' || result.selections > 1) && result.intervals.length > 20, 'walk must change selection and record frames');
        const nativeAfter = nativeState(child.pid);
        assert(nativeAfter.active && !nativeAfter.hidden && nativeAfter.visibleMainWindows === 1, `native window lost foreground: ${JSON.stringify(nativeAfter)}`);
        assert(result.sizes.every(([w, h, dpr, hidden]) => w === width && h === height && dpr === result.sizes[0][2] && !hidden),
          `viewport, scale or visibility changed; discard run: ${JSON.stringify([...new Set(result.sizes.map(s => JSON.stringify(s)))])}`);
        assert(result.canvases.every(c => c.width === Math.round(c.cssWidth * result.sizes[0][2]) && c.height === Math.round(c.cssHeight * result.sizes[0][2])), 'graph must retain full native backing resolution');
        assert.deepEqual(result.errors, []);
        const row = { build: built ? 'production' : 'development', repeat, probe, effect, theme, working, shellBundle, commit, nativeBefore, nativeAfter, graphNodes: graph.nodes.length, graphEdges: graph.edges.length,
          frames: stats(result.intervals), callbackDurations: stats(result.callbacks), dispatchedKeyToFrame: stats(result.keyToFrame), ...result };
        results.push(row); fs.writeFileSync(out, JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ repeat, probe, effect, theme, dpr: result.sizes[0][2], frames: row.frames, callbacks: row.callbackDurations, keyToFrame: row.dispatchedKeyToFrame }));
      } finally {
        process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
        child?.kill('SIGTERM');
        if (child && child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]);
        // Startup failure can occur before the supervisor installs its stdin
        // watcher. Clean up only the supervisor named in this launch's own log.
        const supervisor = Number(fs.readFileSync(path.join(scratch, `${repeat}-${probe}-${effect}.log`), 'utf8').match(/engine supervisor pid (\d+)/)?.[1]);
        if (supervisor) {
          try {
            const command = execFileSync('ps', ['-p', String(supervisor), '-o', 'command='], { encoding: 'utf8' });
            if (command.includes(path.join(root, 'bin/desktop.ts'))) process.kill(-supervisor, 'SIGTERM');
          } catch { /* Already shut down with the shell. */ }
        }
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.closeSync(log);
      }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
