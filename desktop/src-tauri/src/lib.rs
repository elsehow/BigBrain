//! BigBrain desktop (#573, #574) — a menu-bar app around the engine: start
//! the supervisor, wait for its viewer, open a window on it, stay in the
//! menu bar while the window is closed, stop the engine on quit.
//!
//! No inference happens in here, ever (decision 2026-08-26): the engine's
//! gardener is `claude -p` on the user's own Claude Code, reached through the
//! plugin. This process owns exactly one child — `bun <engine>/bin/desktop.ts`,
//! the supervisor that runs the api, the viewer and the schedule — spawned
//! in its own process group, and stopped on quit with ONE signal to that
//! group (#597): SIGTERM to the supervisor and everything it started, a
//! wait, then SIGKILL to whatever is left. Nothing in the tree has to be
//! able to run code for that to work. (Until 2026-08-28 quit SIGKILLed the
//! supervisor alone: its own shutdown never ran, and its api and viewer
//! lived on for as long as the machine did — a viewer over a vault nothing
//! was tending, which looks exactly like a running app.)
//!
//! The supervisor also treats EOF on its stdin, and its parent pid going
//! away, as "the app is gone" (bin/desktop.ts, lib/parentWatch.ts), so a
//! crash here still takes the engine down; and the supervisor's children
//! watch ITS pid the same way. In the other direction, the supervisor's
//! stdout is a pipe into this log: EOF there is how this process learns
//! the supervisor died on its own — it clears the group and relaunches.
//!
//! Which engine: THE ONE INSIDE THE BUNDLE. What shipped is what runs, the
//! app's version is the engine's version, and updating is installing the
//! new app. `BIGBRAIN_ENGINE` overrides it for the dev loop (desktop/dev.sh)
//! and nothing else does. The app owns the `bigbrain` command too: every
//! launch (re)writes `~/.local/bin/bigbrain` as a shim that runs the bundled
//! engine with the bundled bun — over a missing command, its own earlier
//! shim, or a CLI install's symlink (a person's own script is left alone).
//! One pointer: the command the viewer tells people to run and the engine
//! the app is gardening with are the same code. (Until 2026-08-27 the app
//! deferred to a checkout behind the command instead, and a checkout whose
//! viewer had not been rebuilt shadowed a fresh app with an old UI.)
//!
//! An engine already answering on the app's ports is attached to only when
//! it IS this engine WITH A LIVE SUPERVISOR behind it (`GET /api/engine`
//! names both — a second copy of the app). This engine with no supervisor
//! behind it is an earlier app's leftovers: stopped, silently, and the
//! engine started properly. Anything else — an older app, an engine run
//! from a checkout — gets a dialog that names the processes holding the
//! ports and offers to stop them and relaunch; if they come back, a second
//! dialog says so. Never a window showing a stranger's viewer,
//! and never one showing a vault nothing is tending.
//!
//! The menu bar is presence, not a control panel: the cube says the engine
//! is running, a click opens the window, the menu is Quit. Everything
//! about the vault lives in the viewer.
//!
//! Layout inside the bundle (see desktop/build-resources.sh):
//!   Contents/MacOS/bun                  the sidecar (bun itself)
//!   Contents/Resources/resources/engine the engine tree + production deps

use std::env;
use std::fs;
use std::net::TcpStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
mod ui_diagnostics;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// The engine's ports. Overridable (BIGBRAIN_WEB_PORT / BIGBRAIN_API_PORT, the same
/// variables the supervisor reads) so a build can be tried beside a running
/// CLI install without the two fighting over :4747.
fn port(var: &str, default: u16) -> u16 {
    env::var(var).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(default)
}

struct Engine(Mutex<Option<Child>>);

fn home() -> PathBuf {
    env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

/// Where the vault is: `BIGBRAIN_VAULT` if set, else the pointer the CLI
/// install writes (`~/.config/bigbrain/vault`), else `~/vault`. The supervisor
/// applies the same rule; passing it explicitly keeps the two in agreement.
fn vault_root() -> PathBuf {
    if let Ok(v) = env::var("BIGBRAIN_VAULT") {
        if !v.trim().is_empty() {
            return PathBuf::from(v.trim());
        }
    }
    let home = home();
    if let Ok(s) = fs::read_to_string(home.join(".config/bigbrain").join("vault")) {
        let p = s.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    home.join("vault")
}

// ---- which engine ---------------------------------------------------------

/// Where `~/.local/bin/bigbrain` lives — the shim this app writes (or, before
/// the app first ran, a CLI install's symlink).
fn bigbrain_command(home: &Path) -> PathBuf {
    home.join(".local/bin/bigbrain")
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum EngineSource {
    /// `BIGBRAIN_ENGINE` — the dev loop.
    Env,
    /// The copy inside the bundle.
    Bundle,
}

fn is_engine(tree: &Path) -> bool {
    tree.join("bin/desktop.ts").is_file()
}

/// `BIGBRAIN_ENGINE` → the bundle. Nothing on the machine — not the
/// `bigbrain` command, not a checkout — changes which engine the app runs;
/// that is the point. The bundle is not checked: if it is broken the app is
/// broken.
fn engine_root(bundle: PathBuf) -> (PathBuf, EngineSource) {
    if let Ok(v) = env::var("BIGBRAIN_ENGINE") {
        let p = PathBuf::from(v.trim());
        if is_engine(&p) {
            return (p, EngineSource::Env);
        }
        log::warn!("BIGBRAIN_ENGINE={} is not an engine tree (no bin/desktop.ts) — ignoring it", p.display());
    }
    (bundle, EngineSource::Bundle)
}

/// The first comment line of the shim. lib/bigbrainCommand.ts spells the same
/// string (APP_SHIM_MARKER) to recognise the shim from the engine's side;
/// neither may drift.
const SHIM_MARKER: &str = "# installed by BigBrain.app";

fn shim_text(bun: &Path, engine: &Path) -> String {
    format!(
        "#!/bin/sh\n{SHIM_MARKER} — the `bigbrain` command, running the engine inside the app.\n\
         # Rewritten every time the app launches (in case the app moved), over a\n\
         # CLI install's symlink too: on a machine running the app, the app owns\n\
         # this command and the two run the same code. Your own script here is\n\
         # left alone. The engine, for tools that read it (lib/bigbrainCommand.ts):\n\
         # engine: {}\n\
         exec \"{}\" \"{}\" \"$@\"\n",
        engine.display(),
        bun.display(),
        engine.join("bin/cli.ts").display()
    )
}

#[derive(PartialEq, Debug)]
enum Shim {
    Installed,
    Refreshed,
    Unchanged,
    /// A CLI install's symlink (`<checkout>/bin/cli.ts`) was there: the app
    /// took the command over. Carries what it pointed at, for the log.
    Replaced(PathBuf),
    /// Something that is not ours and not an install's is there (a person's
    /// own script, a symlink elsewhere): never touched.
    LeftAlone,
}

/// Make `bigbrain` run this engine: written over a missing command, our own
/// earlier shim, or a CLI install's symlink; anything else is left alone.
fn install_shim(link: &Path, bun: &Path, engine: &Path) -> std::io::Result<Shim> {
    let wanted = shim_text(bun, engine);
    match fs::symlink_metadata(link) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(dir) = link.parent() {
                fs::create_dir_all(dir)?;
            }
            write_executable(link, &wanted)?;
            Ok(Shim::Installed)
        }
        Err(e) => Err(e),
        Ok(meta) if meta.file_type().is_symlink() => {
            let target = fs::read_link(link)?;
            if !target.ends_with("bin/cli.ts") {
                return Ok(Shim::LeftAlone);
            }
            fs::remove_file(link)?;
            write_executable(link, &wanted)?;
            Ok(Shim::Replaced(target))
        }
        Ok(_) => {
            let current = fs::read_to_string(link).unwrap_or_default();
            if !current.contains(SHIM_MARKER) {
                return Ok(Shim::LeftAlone);
            }
            if current == wanted {
                return Ok(Shim::Unchanged);
            }
            write_executable(link, &wanted)?;
            Ok(Shim::Refreshed)
        }
    }
}

fn write_executable(path: &Path, text: &str) -> std::io::Result<()> {
    fs::write(path, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// bun: the sidecar beside our binary (the bundle, or what tauri-build
/// copies next to a dev binary), else `BIGBRAIN_BUN`, else the usual places.
fn sidecar() -> Option<PathBuf> {
    if let Some(p) = env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("bun"))) {
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(v) = env::var("BIGBRAIN_BUN") {
        let p = PathBuf::from(v.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    let mut candidates: Vec<PathBuf> = env::var("PATH")
        .map(|p| env::split_paths(&p).map(|d| d.join("bun")).collect())
        .unwrap_or_default();
    candidates.push(home().join(".bun/bin/bun"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/bun"));
    candidates.push(PathBuf::from("/usr/local/bin/bun"));
    candidates.into_iter().find(|p| p.is_file())
}

// ---- the app ----------------------------------------------------------------

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)).is_ok()
}

/// Which engine is answering on the viewer port: `GET /api/engine` (the
/// engine's web/server.ts, and the setup door) names its root and the pid
/// of the supervisor behind it (None from an engine older than #597). None
/// when nothing answers, or an engine too old to say — either way, not ours.
fn engine_on_port(port: u16) -> Option<(PathBuf, Option<u32>)> {
    use std::io::{Read, Write};
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(3))).ok()?;
    write!(s, "GET /api/engine HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    if head.split_whitespace().nth(1) != Some("200") {
        return None;
    }
    engine_info(body)
}

/// What `/api/engine`'s body says: which engine tree answered, and the pid
/// of the supervisor behind it when it names one (an engine from before
/// #597 does not). Split out from the socket so the shape it parses can be
/// tested without one — the round-trip test that owned all four cases was
/// flaky, and a listening socket is not what a JSON parse needs to prove.
fn engine_info(body: &str) -> Option<(PathBuf, Option<u32>)> {
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    let engine = PathBuf::from(v.get("engine")?.as_str()?);
    let supervisor = v.get("supervisor").and_then(|s| s.as_u64()).and_then(|n| u32::try_from(n).ok());
    Some((engine, supervisor))
}

/// Is `pid` a live `bin/desktop.ts`? A pid alone is not enough — the one an
/// orphaned viewer reports may have been reused since its supervisor died.
fn supervisor_alive(pid: u32) -> bool {
    process_command(pid).contains("bin/desktop.ts")
}

/// A pid's command line, or "" when it is gone (or ps is unavailable).
fn process_command(pid: u32) -> String {
    Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Two paths name the same tree, symlinks and all (the bundle is reached
/// through /Applications; the engine reports where bun resolved it).
fn same_tree(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum PortAction {
    Start,
    Attach,
    Recover,
    Refuse,
}

/// A lone viewer can serve stale UI just as readily as a complete engine.
/// Only a complete, identified engine with a live supervisor can be reused.
fn port_action(web: bool, api: bool, ours: bool, live: Option<u32>) -> PortAction {
    if !web && !api {
        PortAction::Start
    } else if web && api && ours && live.is_some() {
        PortAction::Attach
    } else if ours && live.is_none() {
        PortAction::Recover
    } else {
        PortAction::Refuse
    }
}

/// Readiness belongs to the supervisor we spawned, not whichever process
/// won the race to listen on the port.
fn viewer_matches(info: Option<&(PathBuf, Option<u32>)>, engine: &Path, supervisor: u32) -> bool {
    info.is_some_and(|(path, pid)| same_tree(path, engine) && *pid == Some(supervisor))
}

/// The processes listening on a local port — pid and command line — by way
/// of lsof (macOS, Linux). Empty when lsof is missing or finds nothing.
fn listeners(port: u16) -> Vec<(u32, String)> {
    let Ok(out) = Command::new("lsof").args(["-nP", "-a", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"]).output() else {
        return Vec::new();
    };
    let mut seen: Vec<(u32, String)> = Vec::new();
    for pid in String::from_utf8_lossy(&out.stdout).split_whitespace().filter_map(|s| s.parse::<u32>().ok()) {
        if seen.iter().any(|(p, _)| *p == pid) {
            continue;
        }
        seen.push((pid, process_command(pid)));
    }
    seen
}

/// A command line short enough for a dialog.
fn short(text: &str, max: usize) -> String {
    let mut s: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        s.push('…');
    }
    s
}

/// SIGTERM, then SIGKILL for whatever is still there after `grace`. One pid
/// at a time, not a group: these are processes lsof named, and we know
/// nothing about whose group they lead. (This shelled out to `kill` until
/// 2026-08-30, six lines from `signal_group`'s libc::kill.)
fn stop_processes(pids: &[u32], grace: Duration) {
    if pids.is_empty() {
        return;
    }
    for &pid in pids {
        signal(pid, libc::SIGTERM);
    }
    if wait_for(grace, || !pids.iter().any(|&p| process_alive(p))) {
        return;
    }
    for &pid in pids {
        signal(pid, libc::SIGKILL);
    }
}

/// One signal to one process; true when it was delivered.
fn signal(pid: u32, sig: libc::c_int) -> bool {
    // SAFETY: kill(2) with a positive pid addresses one process; no memory involved.
    unsafe { libc::kill(pid as libc::pid_t, sig) == 0 }
}

/// Does the process still exist? (The zero signal.)
fn process_alive(pid: u32) -> bool {
    signal(pid, 0)
}

/// Everything listening on either engine port, each pid once.
fn holders(web: u16, api: u16) -> Vec<(u32, String)> {
    let mut held = listeners(web);
    for l in listeners(api) {
        if !held.iter().any(|h| h.0 == l.0) {
            held.push(l);
        }
    }
    held
}

// ---- the supervisor's lifetime (#597) --------------------------------------

/// One signal to a whole process group. The supervisor is the leader of its
/// own (spawned with `process_group(0)`), so `-pgid` reaches it and every
/// child it started — including a child whose supervisor is already dead —
/// with none of them having to cooperate.
fn signal_group(pgid: u32, sig: libc::c_int) {
    // SAFETY: kill(2) with a negative pid addresses the group; no memory involved.
    unsafe { libc::kill(-(pgid as libc::pid_t), sig) };
}

/// Does anything in the group still exist? (The zero signal.)
fn group_alive(pgid: u32) -> bool {
    // SAFETY: as above; signal 0 delivers nothing.
    unsafe { libc::kill(-(pgid as libc::pid_t), 0) == 0 }
}

/// Stop the supervisor and everything it started: SIGTERM to the group —
/// the supervisor's own stop() takes its children down in order; a
/// supervisor that cannot run code is simply dead already and the signal
/// reaches its children directly — then up to `grace` for the group to
/// drain, then SIGKILL to whatever is left. Reaps the supervisor.
///
/// The group is addressed while the supervisor is still ours (unreaped), so
/// its pid cannot have been reused; and a pid is never handed out while it
/// is a living group's id, so the later signals are safe too.
fn stop_engine(child: &mut Child, grace: Duration) {
    let pgid = child.id();
    signal_group(pgid, libc::SIGTERM);
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && !matches!(child.try_wait(), Ok(Some(_))) {
        std::thread::sleep(Duration::from_millis(100));
    }
    while Instant::now() < deadline && group_alive(pgid) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if group_alive(pgid) {
        log::warn!("the engine's process group {pgid} did not drain in {grace:?} — SIGKILL");
        signal_group(pgid, libc::SIGKILL);
    }
    let _ = child.wait();
}

/// Relinquish ownership before stopping: the stdout EOF callback must see
/// an intentional shutdown, not report a second failure or restart the app.
fn stop_owned_engine(engine: &Engine, grace: Duration) {
    let child = engine.0.lock().unwrap().take();
    if let Some(mut child) = child {
        log::info!("stopping the engine supervisor (pid {}) and its process group", child.id());
        stop_engine(&mut child, grace);
        log::info!("engine stopped");
    }
}

/// The supervisor's output, line by line, into this app's log — the one
/// place a person can find why the engine stopped (before this, a supervisor
/// launched from Finder said its last words to nowhere). And on EOF, which
/// only the supervisor's exit produces (its children get the log files, not
/// this pipe), `on_eof`.
fn forward<R: std::io::Read + Send + 'static>(from: Option<R>, tag: &'static str, on_eof: Option<Box<dyn FnOnce() + Send>>) {
    let Some(r) = from else { return };
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(r).lines().map_while(Result::ok) {
            log::info!("{tag}: {line}");
        }
        if let Some(f) = on_eof {
            f();
        }
    });
}

/// The supervisor exited on its own while the app was running (a crash, a
/// `kill -9`, an uncaught error): clear whatever it left in its group —
/// its children are watching its pid and going already — and relaunch the
/// app, which comes back through the port checks and starts a fresh engine.
/// One that died within a minute of starting is not relaunched into a loop:
/// the app says so and quits.
fn supervisor_gone(handle: &AppHandle, started: Instant) {
    let engine = handle.state::<Engine>();
    let Some(mut child) = engine.0.lock().unwrap().take() else {
        return; // quit took it: the Exit handler is stopping it
    };
    let pid = child.id();
    log::error!("the engine supervisor (pid {pid}) exited on its own — clearing what it left");
    stop_engine(&mut child, Duration::from_secs(5));
    if started.elapsed() > Duration::from_secs(60) {
        log::warn!("relaunching");
        handle.restart();
    }
    handle
        .dialog()
        .message("The engine stopped right after starting. Its last lines are in ~/Library/Logs/cool.bigbrain.desktop/BigBrain.log.")
        .title("BigBrain's engine stopped")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    handle.exit(2);
}

/// The three failures a person can hit before the window exists — no bun in
/// the bundle, a supervisor that will not spawn, a supervisor that never
/// answers — end here: a dialog naming the problem, then exit(2).
///
/// They used to be `Err` out of Tauri's setup closure, which PANICS: the app
/// vanished with a crash report and told the person nothing. `refuse_ports`
/// and `supervisor_gone` had the right shape all along; this is that shape,
/// shared.
fn fatal(handle: &AppHandle, msg: String) -> ! {
    log::error!("{msg}");
    // process::exit bypasses RunEvent::Exit. Clean up before the dialog,
    // which can remain open indefinitely after a startup timeout.
    stop_owned_engine(&handle.state::<Engine>(), Duration::from_secs(8));
    handle
        .dialog()
        .message(format!(
            "{msg}\n\nThe details are in ~/Library/Logs/cool.bigbrain.desktop/BigBrain.log."
        ))
        .title("BigBrain could not start")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    std::process::exit(2)
}

/// Start the supervisor: in its own process group (one signal stops all of
/// it), stdin a pipe it reads for EOF, stdout/stderr pipes into this log.
/// `--no-env-file`: cwd is the vault, whose .env holds credentials the engine
/// reads on demand and must not carry in its environment (lib/env.ts).
fn start_supervisor(sidecar: &Path, supervisor: &Path, cwd: &Path, vault: &Path, web_port: u16, api_port: u16) -> std::io::Result<Child> {
    Command::new(sidecar)
        .arg("--no-env-file")
        .arg(supervisor)
        .current_dir(cwd)
        .env("BIGBRAIN_VAULT", vault)
        .env("BIGBRAIN_DESKTOP", "1")
        .env("BIGBRAIN_WEB_PORT", web_port.to_string())
        .env("BIGBRAIN_API_PORT", api_port.to_string())
        // A pipe, not null: the supervisor treats EOF on its stdin as
        // "the app is gone" and takes the engine down (bin/desktop.ts).
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
}

/// Something not ours holds the engine's ports: say who, offer to stop it.
fn refuse_ports(handle: &AppHandle, web_port: u16, api_port: u16, who: String, held: Vec<(u32, String)>) {
    let pids: Vec<u32> = held.iter().map(|h| h.0).collect();
    log::error!("something else is already answering on :{web_port}/:{api_port} ({who}; pids {pids:?}) — not attaching");
    let title = "BigBrain is already running";
    let advice = "A BigBrain in the menu bar can also be quit from its cube. An engine started from a checkout (`bun bin/desktop.ts`) has to be stopped where it was started.";
    if held.is_empty() {
        // Nothing to offer to stop (no lsof, or a listener it cannot see).
        handle
            .dialog()
            .message(format!("Another BigBrain engine is running on this machine: {who}.\n\n{advice} Then open BigBrain again."))
            .title(title)
            .kind(MessageDialogKind::Error)
            .show(|_| std::process::exit(2));
        return;
    }
    let listing = held.iter().map(|(pid, cmd)| format!("{pid}  {}", short(cmd, 96))).collect::<Vec<_>>().join("\n");
    let handle = handle.clone();
    handle
        .clone()
        .dialog()
        .message(format!("Another BigBrain engine is running on this machine: {who}.\n\n{listing}\n\nStop it and open BigBrain? ({advice})"))
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Stop it and open BigBrain".into(), "Quit".into()))
        .show(move |stop| {
            if !stop {
                std::process::exit(2);
            }
            log::info!("stopping {pids:?} at the person's request");
            stop_processes(&pids, Duration::from_secs(5));
            if ports_free_within(web_port, api_port, Duration::from_secs(10)) {
                log::info!(":{web_port}/:{api_port} are free — relaunching");
                handle.restart();
            }
            log::error!(":{web_port}/:{api_port} are still held after stopping {pids:?} — something brought it back");
            handle
                .dialog()
                .message(format!("It came back: something is still answering on :{web_port}/:{api_port}. {advice} Then open BigBrain again."))
                .title(title)
                .kind(MessageDialogKind::Error)
                .show(|_| std::process::exit(2));
        });
}

/// How long the engine gets to answer before the app gives up on it.
const ENGINE_START_WAIT: Duration = Duration::from_secs(30);

/// Poll until `ready` holds, or `wait` runs out. Both port waits are this
/// one loop: the app waits for a port to START answering when it launches
/// the engine, and for two to STOP when it sweeps someone else's.
fn wait_for(wait: Duration, ready: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        if ready() {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn ports_free_within(web: u16, api: u16, wait: Duration) -> bool {
    wait_for(wait, || !port_open(web) && !port_open(api))
}

fn viewer_answers_within(port: u16, engine: &Path, supervisor: u32, wait: Duration) -> bool {
    wait_for(wait, || viewer_matches(engine_on_port(port).as_ref(), engine, supervisor))
}

/// Bring the viewer window forward — it is hidden, never destroyed, when
/// the user closes it.
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// Keep expansion separate from macOS Spaces fullscreen: Escape belongs to the UI.
#[derive(Default)]
struct WindowExpansion(Mutex<bool>);

#[cfg(target_os = "macos")]
fn aerospace_window(window: &tauri::WebviewWindow) -> Option<(String, String, bool)> {
    if window.label() != "main" { return None; }
    let title = window.title().ok()?;
    let pid = std::process::id().to_string();
    for executable in ["aerospace", "/opt/homebrew/bin/aerospace", "/usr/local/bin/aerospace"] {
        let Ok(output) = Command::new(executable).args([
            "list-windows", "--all", "--format",
            "%{app-pid}|%{window-id}|%{window-is-fullscreen}|%{window-title}",
        ]).output() else { continue };
        if !output.status.success() { continue; }
        return String::from_utf8_lossy(&output.stdout).lines().find_map(|line| {
            let fields: Vec<_> = line.splitn(4, '|').collect();
            if fields.len() == 4 && fields[0] == pid && fields[3] == title
                && fields[1].parse::<u32>().is_ok() && matches!(fields[2], "true" | "false") {
                Some((executable.to_string(), fields[1].to_string(), fields[2] == "true"))
            } else { None }
        });
    }
    None
}

#[tauri::command]
fn ui_diagnostic(window: tauri::WebviewWindow, sample: ui_diagnostics::Sample) -> Result<(), String> {
    ui_diagnostics::record(window, sample)
}

#[tauri::command]
async fn window_is_maximized(window: tauri::WebviewWindow) -> Result<bool, String> {
    // AeroSpace may query our accessibility state while answering. Waiting for
    // its process on the native event loop freezes input and painting.
    tauri::async_runtime::spawn_blocking(move || {
        let at = Instant::now();
        let result = window_is_maximized_blocking(window);
        if ui_diagnostics::mode().is_some() {
            log::info!("ui-diagnostic window_state duration_ms={}", at.elapsed().as_millis());
        }
        result
    })
        .await.map_err(|e| e.to_string())?
}

fn window_is_maximized_blocking(window: tauri::WebviewWindow) -> Result<bool, String> {
    let state = window.state::<WindowExpansion>();
    if *state.0.lock().map_err(|e| e.to_string())? { return Ok(true); }
    #[cfg(target_os = "macos")]
    if let Some((_, _, expanded)) = aerospace_window(&window) { return Ok(expanded); }
    Ok(window.is_fullscreen().map_err(|e| e.to_string())?
        || window.is_maximized().map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || window_toggle_maximize_blocking(window))
        .await.map_err(|e| e.to_string())?
}

fn window_toggle_maximize_blocking(window: tauri::WebviewWindow) -> Result<bool, String> {
    let state = window.state::<WindowExpansion>();
    if window.label() != "main" { return Err("Only the main window can expand".into()); }
    let mut expanded = state.0.lock().map_err(|e| e.to_string())?;
    if *expanded {
        window.set_simple_fullscreen(false).map_err(|e| e.to_string())?;
        *expanded = false;
        return Ok(false);
    }
    // Also allow restoring native fullscreen entered via the OS green button.
    if window.is_fullscreen().map_err(|e| e.to_string())? {
        window.set_fullscreen(false).map_err(|e| e.to_string())?;
        return Ok(false);
    }
    #[cfg(target_os = "macos")]
    {
        // Target this app window, never whichever window happens to have focus.
        // Query the manager's state so external shortcuts work too.
        if let Some((executable, id, active)) = aerospace_window(&window) {
            let output = Command::new(executable).args([
                "fullscreen", if active { "off" } else { "on" }, "--window-id", &id,
            ]).output().map_err(|e| e.to_string())?;
            if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
            return Ok(!active);
        }
        if window.is_maximized().map_err(|e| e.to_string())? {
            window.unmaximize().map_err(|e| e.to_string())?;
            return Ok(false);
        }
        window.set_simple_fullscreen(true).map_err(|e| e.to_string())?;
        *expanded = true;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let maximized = window.is_maximized().map_err(|e| e.to_string())?;
        if maximized { window.unmaximize() } else { window.maximize() }.map_err(|e| e.to_string())?;
        Ok(!maximized)
    }
}

#[tauri::command]
fn window_background(window: tauri::WebviewWindow, color: [u8; 3]) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    window
        .set_background_color(Some(tauri::window::Color(color[0], color[1], color[2], 255)))
        .map_err(|e| e.to_string())
}

// ---- updates ----------------------------------------------------------------
// The site is the update channel: `bun run site:build --app` writes
// latest.json beside download/, and uploading dist/ IS the release
// (site/README.md). The updater plugin fetches it, compares versions, and
// on install verifies the minisign signature against the pubkey baked into
// tauri.conf.json — the private key never leaves the Mac that cuts builds
// (desktop/README.md has the release steps). The viewer polls update_check
// and shows a banner; only a click on it downloads anything.

/// What the viewer's banner renders: the version waiting, and the release
/// notes latest.json carries.
#[derive(Clone, serde::Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// The configured updater — endpoints from tauri.conf.json, or
/// BIGBRAIN_UPDATE_URL over them (how a dev loop points a build at a local
/// latest.json without touching the shipped config).
fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut b = app.updater_builder();
    if let Ok(url) = env::var("BIGBRAIN_UPDATE_URL") {
        let url = url.parse::<tauri::Url>().map_err(|e| format!("BIGBRAIN_UPDATE_URL: {e}"))?;
        b = b.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    b.build().map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    match updater(&app)?.check().await {
        Ok(Some(u)) => {
            log::info!("update available: {} (running {})", u.version, u.current_version);
            Ok(Some(UpdateInfo { version: u.version.clone(), notes: u.body.clone() }))
        }
        Ok(None) => {
            log::info!("no update: this is the newest version");
            Ok(None)
        }
        // the viewer stays quiet about failed CHECKS by design — the log is
        // where a silently never-updating install gets diagnosed
        Err(e) => {
            log::warn!("update check failed: {e}");
            Err(e.to_string())
        }
    }
}

/// Download, verify, swap /Applications/BigBrain.app, relaunch. The engine
/// is stopped FIRST, exactly as quit stops it — restart() replaces this
/// process, and a supervisor orphaned across that boundary would hold the
/// ports against the new app.
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = updater(&app)?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No update to install.")?;
    log::info!("installing update {}", update.version);
    update
        .download_and_install(|_, _| {}, || log::info!("update downloaded — installing"))
        .await
        .map_err(|e| e.to_string())?;
    if let Some(mut child) = app.state::<Engine>().0.lock().unwrap().take() {
        log::info!("stopping the engine supervisor (pid {}) before relaunch", child.id());
        stop_engine(&mut child, Duration::from_secs(8));
    }
    log::info!("relaunching into the new version");
    app.restart();
}

/// What the setup closure resolves before anything can start: where the
/// vault and the engine are, which bun runs it, which ports it gets.
struct Boot {
    web_port: u16,
    api_port: u16,
    vault: PathBuf,
    home: PathBuf,
    engine: PathBuf,
    sidecar: PathBuf,
    supervisor: PathBuf,
}

/// Resolve the boot facts and log them. The one failure here is a bundle
/// with no bun in it, which no amount of retrying fixes.
fn plan_boot(app: &AppHandle) -> Result<Boot, String> {
    let web_port = port("BIGBRAIN_WEB_PORT", 4747);
    let api_port = port("BIGBRAIN_API_PORT", 4748);
    let vault = vault_root();
    let home = home();
    let bundle = app
        .path()
        .resource_dir()
        .map_err(|e| format!("the app bundle has no resource directory ({e})"))?
        .join("resources")
        .join("engine");
    let (engine, source) = engine_root(bundle);
    let sidecar = sidecar()
        .ok_or("no bun to run the engine with: not beside the app binary, not BIGBRAIN_BUN, not on PATH")?;
    let supervisor = engine.join("bin").join("desktop.ts");
    log::info!("vault {}", vault.display());
    log::info!("engine {} ({source:?})", engine.display());
    log::info!("sidecar {}", sidecar.display());
    if !supervisor.is_file() {
        return Err(format!("the engine in this app is incomplete: no {}", supervisor.display()));
    }

    // The app owns `bigbrain`: it runs this very engine. (The dev loop runs
    // a checkout and leaves the person's command alone.)
    if source == EngineSource::Bundle {
        let link = bigbrain_command(&home);
        match install_shim(&link, &sidecar, &engine) {
            Ok(Shim::LeftAlone) => log::info!("{} is not ours and not an install's — left alone", link.display()),
            Ok(Shim::Replaced(was)) => {
                log::info!("{} was a CLI install's symlink → {} — now the app's shim", link.display(), was.display())
            }
            Ok(what) => log::info!("{}: {what:?}", link.display()),
            Err(e) => log::warn!("could not install {}: {e}", link.display()),
        }
    }
    Ok(Boot { web_port, api_port, vault, home, engine, sidecar, supervisor })
}

/// How far `start_engine` got: an engine answering on the ports, or a
/// refusal already shown to the person.
enum Started {
    Ready,
    Refused,
}

/// Get an engine answering on the ports: attach to a live copy of ourselves,
/// sweep a dead one, or start our own and wait for it.
fn start_engine(app: &AppHandle, boot: &Boot) -> Result<Started, String> {
    let (web_port, api_port) = (boot.web_port, boot.api_port);

    // Something already answering on the engine's ports (#589, #597).
    // This engine with a live supervisor behind it — a second copy of
    // the app: attach, don't fight. This engine with NO supervisor
    // behind it — an earlier app died without taking its servers
    // down, and a viewer over a vault nothing is tending looks
    // exactly like a running app: ours, so stop it and start
    // properly, no dialog. Anything else — an older app still
    // running, an engine started from a checkout — would put a stranger's
    // viewer in our window and call it this version: say so and stop.
    let web_held = port_open(web_port);
    let api_held = port_open(api_port);
    let on_ports = if web_held { engine_on_port(web_port) } else { None };
    let ours = on_ports.as_ref().is_some_and(|(p, _)| same_tree(p, &boot.engine));
    let live = on_ports.as_ref().and_then(|(_, s)| *s).filter(|&pid| supervisor_alive(pid));
    let action = port_action(web_held, api_held, ours, live);
    if action != PortAction::Start {
        if action == PortAction::Attach {
            log::warn!("this engine is already answering on :{web_port}/:{api_port} (supervisor pid {live:?}) — attaching to it, not starting another");
            return Ok(Started::Ready);
        }
        // Who holds the ports: what a sweep stops, and what the
        // dialog names. One supervisor's children may hold both.
        let held = holders(web_port, api_port);
        let pids: Vec<u32> = held.iter().map(|h| h.0).collect();
        let swept = action == PortAction::Recover && {
            log::warn!("this engine is answering on :{web_port}/:{api_port} with no supervisor behind it (pids {pids:?}) — an earlier app left it; stopping it");
            stop_processes(&pids, Duration::from_secs(5));
            ports_free_within(web_port, api_port, Duration::from_secs(10))
        };
        if !swept {
            let who = match &on_ports {
                Some((p, _)) if ours && live.is_some() => format!("this engine with only part of its services available ({})", p.display()),
                Some((p, _)) if ours => format!("this engine's own servers, which would not stop ({})", p.display()),
                Some((p, _)) => format!("a different engine, {}", p.display()),
                None => "an engine too old to say which".to_string(),
            };
            refuse_ports(app, web_port, api_port, who, held);
            return Ok(Started::Refused);
        }
        log::info!("stopped; :{web_port}/:{api_port} are free");
    }

    // No vault yet (first run): the supervisor opens the setup door
    // instead, and a cwd that does not exist would fail the spawn before
    // it could.
    let cwd = if boot.vault.is_dir() { boot.vault.clone() } else { boot.home.clone() };
    let mut child = start_supervisor(&boot.sidecar, &boot.supervisor, &cwd, &boot.vault, web_port, api_port)
        .map_err(|e| format!("could not start the engine ({}): {e}", boot.sidecar.display()))?;
    let supervisor = child.id();
    log::info!("engine supervisor pid {} (its own process group)", child.id());
    let started = Instant::now();
    let handle = app.clone();
    forward(child.stdout.take(), "engine", Some(Box::new(move || supervisor_gone(&handle, started))));
    forward(child.stderr.take(), "engine!", None);
    *app.state::<Engine>().0.lock().unwrap() = Some(child);

    if viewer_answers_within(web_port, &boot.engine, supervisor, ENGINE_START_WAIT) {
        return Ok(Started::Ready);
    }
    Err(format!(
        "the engine started but its viewer never identified itself on :{web_port} (waited {}s); another process may be using the port",
        ENGINE_START_WAIT.as_secs()
    ))
}

/// The viewer's origin. BIGBRAIN_WEB_URL points the dev loop at vite
/// instead of the engine's own viewer.
fn viewer_base(web_port: u16) -> String {
    env::var("BIGBRAIN_WEB_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{web_port}/"))
}

/// A window's navigation policy: the viewer's own document, and nothing
/// else. The viewer is one page — every route is a hash on it — so the only
/// navigation it means is to itself. Anything else that reaches the webview
/// as a top-level navigation — a link in a clipped page, a mail's, an
/// attachment — is a page of its own, and loaded here it was a trap: no
/// tabs, no back button, no way out but quitting the app (Nick,
/// 2026-09-02: "it opens the link inside the bigbrain app and then i can't
/// leave"). Those go to the default browser through the opener plugin, and
/// the webview stays where it was. The viewer diverts such clicks itself
/// first (web/ui/src/lib/links.ts); this is the floor under it, for the
/// path no click handler saw. `about:` (the empty page a webview may start
/// on) is the webview's own.
///
/// wry (0.55) hands the policy a URL and nothing about which frame asked,
/// so a frame's navigation lands here too. A desktop's `url` view frames a
/// page on another loopback port (an agent's dev server), and refusing it
/// left the frame blank and opened the page in the browser instead: those
/// stay, and `send_home` keeps them out of the window itself. Only http,
/// https and mailto ever reach the opener — it runs whatever the OS maps a
/// URL to, and a file: or app-scheme URL is a program, not a page.
fn stay_on(app: &AppHandle, home: &tauri::Url) -> impl Fn(&tauri::Url) -> bool + Send + 'static {
    let app = app.clone();
    let home = home.clone();
    move |url| {
        if stays(&home, url) {
            return true;
        }
        open_outside(&app, url);
        false
    }
}

fn stays(home: &tauri::Url, url: &tauri::Url) -> bool {
    url.scheme() == "about" || (url.origin() == home.origin() && url.path() == home.path()) || loopback_page(home, url)
}

/// What a `url` view frames: http on another loopback origin, as
/// lib/pilotDesktop.ts loopbackUrl and the viewer's CSP frame-src allow.
fn loopback_page(home: &tauri::Url, url: &tauri::Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && url.origin() != home.origin()
}

fn browser_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn open_outside(app: &AppHandle, url: &tauri::Url) {
    if !browser_url(url) {
        log::warn!("not opening a {}: URL outside the app", url.scheme());
    } else if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        log::warn!("could not open {url} outside the app: {e}");
    }
}

/// Page loads are the window's own (WebKit reports none for a frame), so a
/// loopback page the policy let through for a frame and that landed in the
/// window instead is sent to the browser, and the window back home.
fn send_home(app: &AppHandle, home: &tauri::Url) -> impl Fn(tauri::WebviewWindow, tauri::webview::PageLoadPayload<'_>) + Send + Sync + 'static {
    let app = app.clone();
    let home = home.clone();
    move |window, load| {
        if load.event() == tauri::webview::PageLoadEvent::Started && loopback_page(&home, load.url()) {
            open_outside(&app, load.url());
            let _ = window.navigate(home.clone());
        }
    }
}

/// capabilities/default.json grants the viewer's commands to the engine's
/// two default viewer origins (:4747, and :4757 for the dev loop), not to
/// every loopback port: an agent's dev server in a `url` view gets none. A
/// window on any other origin (BIGBRAIN_WEB_PORT moved it, or the dev loop's
/// vite via BIGBRAIN_WEB_URL) gets the same grant for that origin alone, at
/// launch. None when the file already names it.
fn viewer_capability(origin: &str) -> Option<String> {
    let mut cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).ok()?;
    let urls = cap.pointer_mut("/remote/urls")?.as_array_mut()?;
    if urls.iter().any(|u| u == origin) {
        return None;
    }
    *urls = vec![origin.into()];
    cap["identifier"] = "viewer-origin".into();
    Some(cap.to_string())
}

/// The main viewer window.
fn build_windows(app: &AppHandle, base: &str) -> Result<(), Box<dyn std::error::Error>> {
    // The viewer window. Closing it hides it — the engine keeps
    // gardening; the cube, the Dock icon and Cmd-Tab bring it back.
    let url: tauri::Url = base.parse()?;
    if let Some(cap) = viewer_capability(&url.origin().ascii_serialization()) {
        app.add_capability(cap)?;
    }
    // The window is NAMED BigBrain — Mission Control, Cmd-Tab and the
    // Window menu all read that — but the title bar does not SAY so
    // (Nick, 2026-08-28: "remove 'BigBrain' from this menubar"). A
    // wordmark beside the traffic lights of the only window the app
    // has is a label on the inside of its own door; the app said its
    // name on the way in, and the cube in the menu bar says it while
    // it runs. macOS-only: hidden_title exists on no other platform,
    // where the title is all the bar has.
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
        .on_navigation(stay_on(app, &url))
        .on_page_load(send_home(app, &url))
        .title("BigBrain")
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 480.0)
        // The drag belongs to the web layer. Tauri installs an OS-level
        // drag handler by default, and its callback returns `true` for
        // every event — which in wry means "handled", so draggingEntered,
        // draggingUpdated and performDragOperation never reach WKWebView
        // and the page sees no dragenter, no dragover, no drop. Nothing
        // appeared at all on a drop, folder or file, because DropZone's
        // veil is driven by ondragenter (#660).
        //
        // The other road is to take Tauri's own DragDrop event, which
        // hands over file PATHS instead of a DataTransfer — better for a
        // 200MB PDF, and no marshalling through the webview. It is also a
        // second recursive directory walk, in Rust, and a second way into
        // the same ship path, diverging from the browser viewer that
        // already does all of this. One drop zone, where it is written.
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Transparent);
    }
    if let Some(mode) = ui_diagnostics::mode() {
        builder = builder.initialization_script(format!(
            "window.__BIGBRAIN_UI_DIAGNOSTICS_MODE__ = {};\n{}",
            serde_json::to_string(&mode)?, include_str!("ui-diagnostics.js")
        ));
    }
    let window = builder.build()?;
    ui_diagnostics::start(&window);
    let hidden = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden.hide();
        }
    });

    Ok(())
}

/// The menu bar: the brand cube as a template image
/// (desktop/icon/tray-template.svg, rendered by desktop/icons.sh), so macOS
/// paints its alpha in the menu bar's own ink, light or dark. Left click
/// opens the window; right click is the menu, which is Quit.
fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItemBuilder::with_id("quit", "Quit BigBrain").accelerator("CmdOrCtrl+Q").build(app)?;
    let menu = MenuBuilder::new(app).item(&quit).build()?;
    TrayIconBuilder::with_id("main")
        .icon(tauri::include_image!("icons/tray-template.png"))
        .icon_as_template(true)
        .tooltip("BigBrain")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                app.exit(0);
            }
        })
        .build(app)?;
    Ok(())
}

/// The remembered chord (default ⌥Space). A refusal — another app holds it,
/// an unreadable file — is KEPT, not fatal: the app runs, and settings →
/// shortcuts shows the words.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Engine(Mutex::new(None)))
        .manage(WindowExpansion::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            update_check,
            update_install,
            window_background,
            window_is_maximized,
            window_toggle_maximize,
            ui_diagnostic
        ])
        // The native folder dialog, lent to the viewer: the page is a remote
        // origin (the engine's :4747), which gets nothing by default — the
        // capability in capabilities/default.json names that origin and
        // grants `dialog:allow-open`, and `app.withGlobalTauri` puts the
        // plugin's API on window.__TAURI__ there (web/ui/src/lib/native.ts).
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Links that leave the app (the extension download page) open in the
        // system browser; a `_blank` link inside a webview has no tab to go to.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            // Everything from here to the window is a step that can fail in
            // front of a person who has just double-clicked an icon, so each
            // one either succeeds or says why and exits — never `Err` out of
            // this closure, which panics.
            let handle = app.handle().clone();
            let boot = plan_boot(&handle).unwrap_or_else(|e| fatal(&handle, e));
            match start_engine(&handle, &boot) {
                Err(e) => fatal(&handle, e),
                // Someone else holds the ports and has been told so:
                // refuse_ports owns what happens next (stop them and
                // relaunch, or quit). No window, no tray.
                Ok(Started::Refused) => return Ok(()),
                Ok(Started::Ready) => {}
            }
            let base = viewer_base(boot.web_port);
            build_windows(&handle, &base)
                .unwrap_or_else(|e| fatal(&handle, format!("the BigBrain window would not open: {e}")));
            build_tray(&handle)
                .unwrap_or_else(|e| fatal(&handle, format!("the menu bar cube would not build: {e}")));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows, .. } if !has_visible_windows => show_main(app),
            RunEvent::Exit => {
                stop_owned_engine(&app.state::<Engine>(), Duration::from_secs(8));
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("bb-desktop-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn engine_tree(at: &Path) -> PathBuf {
        fs::create_dir_all(at.join("bin")).unwrap();
        fs::write(at.join("bin/desktop.ts"), "").unwrap();
        fs::write(at.join("bin/cli.ts"), "").unwrap();
        at.to_path_buf()
    }

    #[test]
    fn shim_names_its_engine_for_the_engine_side_to_read() {
        // lib/bigbrainCommand.ts reads the `# engine:` line and looks for the marker.
        let text = shim_text(Path::new("/App.app/bun"), Path::new("/App.app/engine"));
        assert!(text.starts_with("#!/bin/sh\n# installed by BigBrain.app"));
        assert!(text.contains("\n# engine: /App.app/engine\n"));
        assert!(text.ends_with("exec \"/App.app/bun\" \"/App.app/engine/bin/cli.ts\" \"$@\"\n"));
    }

    #[test]
    fn shim_is_installed_refreshed_and_takes_an_install_over_but_never_a_stranger() {
        let dir = scratch("shim");
        let engine = engine_tree(&dir.join("App.app/engine"));
        let bun = dir.join("App.app/bun");
        let link = dir.join("local/bin/bigbrain");

        assert_eq!(install_shim(&link, &bun, &engine).unwrap(), Shim::Installed);
        assert_eq!(install_shim(&link, &bun, &engine).unwrap(), Shim::Unchanged);
        let text = fs::read_to_string(&link).unwrap();
        assert_eq!(text, shim_text(&bun, &engine));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&link).unwrap().permissions().mode() & 0o777, 0o755);
        }

        // The app moved: the shim follows.
        let moved = engine_tree(&dir.join("Moved.app/engine"));
        assert_eq!(install_shim(&link, &dir.join("Moved.app/bun"), &moved).unwrap(), Shim::Refreshed);
        assert_eq!(fs::read_to_string(&link).unwrap(), shim_text(&dir.join("Moved.app/bun"), &moved));

        // A CLI install's symlink: the app takes the command over.
        let checkout = engine_tree(&dir.join("checkout"));
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(checkout.join("bin/cli.ts"), &link).unwrap();
        assert_eq!(install_shim(&link, &bun, &engine).unwrap(), Shim::Replaced(checkout.join("bin/cli.ts")));
        assert!(!fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&link).unwrap(), shim_text(&bun, &engine));

        // A person's own script, or a symlink to something that is not an
        // engine's bin/cli.ts: untouched.
        fs::write(&link, "#!/bin/sh\necho mine\n").unwrap();
        assert_eq!(install_shim(&link, &bun, &engine).unwrap(), Shim::LeftAlone);
        assert_eq!(fs::read_to_string(&link).unwrap(), "#!/bin/sh\necho mine\n");
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink("/usr/bin/true", &link).unwrap();
        assert_eq!(install_shim(&link, &bun, &engine).unwrap(), Shim::LeftAlone);
        assert_eq!(fs::read_link(&link).unwrap(), PathBuf::from("/usr/bin/true"));
    }

    #[test]
    fn engine_root_is_the_bundle_whatever_the_command_says() {
        let dir = scratch("root");
        let bundle = engine_tree(&dir.join("bundle"));
        let home = dir.join("home");
        assert_eq!(engine_root(bundle.clone()), (bundle.clone(), EngineSource::Bundle));
        // A CLI install's symlink to a checkout does not change that.
        let checkout = engine_tree(&dir.join("checkout"));
        let link = bigbrain_command(&home);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(checkout.join("bin/cli.ts"), &link).unwrap();
        assert_eq!(engine_root(bundle.clone()), (bundle, EngineSource::Bundle));
        // (BIGBRAIN_ENGINE is process-global; the env branch is exercised by dev.sh.)
    }

    #[test]
    fn partial_port_conflicts_cannot_bypass_the_startup_check() {
        assert_eq!(port_action(false, false, false, None), PortAction::Start);
        // The reported failure: a checkout viewer holds the web port while
        // the app's API has stopped for an update.
        assert_eq!(port_action(true, false, false, None), PortAction::Refuse);
        assert_eq!(port_action(false, true, false, None), PortAction::Refuse);
        assert_eq!(port_action(true, true, false, Some(42)), PortAction::Refuse);
        assert_eq!(port_action(true, true, true, Some(42)), PortAction::Attach);
        // A live but incomplete engine must not be killed as an orphan.
        assert_eq!(port_action(true, false, true, Some(42)), PortAction::Refuse);
        assert_eq!(port_action(true, false, true, None), PortAction::Recover);
        assert_eq!(port_action(true, true, true, None), PortAction::Recover);
    }

    #[test]
    fn viewer_readiness_requires_the_spawned_supervisors_identity() {
        let engine = Path::new("/Applications/BigBrain.app/engine");
        assert!(!viewer_matches(None, engine, 42));
        assert!(!viewer_matches(Some(&(PathBuf::from("/checkout"), Some(42))), engine, 42));
        assert!(!viewer_matches(Some(&(engine.to_path_buf(), None)), engine, 42));
        assert!(!viewer_matches(Some(&(engine.to_path_buf(), Some(41))), engine, 42));
        assert!(viewer_matches(Some(&(engine.to_path_buf(), Some(42))), engine, 42));
    }

    #[test]
    fn listeners_names_the_holder_of_a_port_and_stop_processes_stops_one() {
        if Command::new("lsof").arg("-v").output().is_err() {
            return; // no lsof here: listeners() is empty by design and the dialog has no button
        }
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let held = listeners(port);
        assert!(held.iter().any(|(pid, _)| *pid == std::process::id()), "{held:?}");
        drop(l);
        assert!(listeners(port).is_empty());

        let mut child = Command::new("sleep").arg("60").spawn().unwrap();
        stop_processes(&[child.id()], Duration::from_secs(1));
        assert!(!child.wait().unwrap().success());
        assert_eq!(short("abcdef", 3), "abc…");
        assert_eq!(short("ab", 3), "ab");
    }

    fn group_size(pgid: u32) -> usize {
        Command::new("pgrep")
            .args(["-g", &pgid.to_string()])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().count())
            .unwrap_or(0)
    }

    #[test]
    fn stop_engine_takes_the_whole_group_even_after_its_leader_was_killed_9() {
        // A "supervisor" with two children, in its own group as start_supervisor
        // spawns the real one.
        let mut leader = Command::new("sh").args(["-c", "sleep 60 & sleep 60 & wait"]).process_group(0).spawn().unwrap();
        let pgid = leader.id();
        std::thread::sleep(Duration::from_millis(400));
        assert!(group_size(pgid) >= 3, "leader + 2 children expected, saw {}", group_size(pgid));

        // The supervisor cannot run code any more (#597's shape): its children
        // are reparented to launchd, still holding whatever they held.
        // SAFETY: kill(2) on a pid we own.
        unsafe { libc::kill(pgid as libc::pid_t, libc::SIGKILL) };
        std::thread::sleep(Duration::from_millis(200));
        assert!(group_alive(pgid), "the orphans keep the group alive");
        assert!(group_size(pgid) >= 2);

        stop_engine(&mut leader, Duration::from_secs(3));
        assert!(!group_alive(pgid), "nothing left in the group");
        assert_eq!(group_size(pgid), 0);
        assert!(leader.try_wait().is_ok(), "reaped");
    }

    #[test]
    fn stop_engine_gives_a_live_supervisor_the_signal_and_reaps_it() {
        let mut leader = Command::new("sh").args(["-c", "sleep 60 & wait"]).process_group(0).spawn().unwrap();
        let pgid = leader.id();
        std::thread::sleep(Duration::from_millis(300));
        assert!(group_alive(pgid));
        let t = Instant::now();
        stop_engine(&mut leader, Duration::from_secs(3));
        assert!(!group_alive(pgid));
        assert!(t.elapsed() < Duration::from_secs(3), "SIGTERM was enough; no wait for the deadline");
    }

    #[test]
    fn startup_failure_releases_ownership_and_stops_the_engine_group() {
        let child = Command::new("sh").args(["-c", "sleep 60 & wait"]).process_group(0).spawn().unwrap();
        let pgid = child.id();
        let engine = Engine(Mutex::new(Some(child)));
        std::thread::sleep(Duration::from_millis(300));
        assert!(group_size(pgid) >= 2);
        stop_owned_engine(&engine, Duration::from_secs(3));
        assert!(engine.0.lock().unwrap().is_none(), "EOF and exit handlers must have nothing left to stop");
        assert!(!group_alive(pgid), "startup failure must leave no supervisor or children");
        stop_owned_engine(&engine, Duration::from_secs(3));
    }

    /// A fake viewer port answering `GET /api/engine` with `body`.
    /// A one-shot server that answers `GET /api/engine` with `body`.
    ///
    /// It reads the WHOLE request before answering. It used to take one
    /// 512-byte read and reply: when the request arrived in two segments the
    /// second went unread, so closing the socket sent RST instead of FIN and
    /// the client's read of a perfectly good response failed — the test read
    /// that as "nothing on this port" and failed about half the time.
    fn canned(body: &'static str) -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for s in l.incoming().take(1) {
                let mut s = s.unwrap();
                let mut req = Vec::new();
                let mut buf = [0u8; 512];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => req.extend_from_slice(&buf[..n]),
                    }
                }
                let _ = write!(s, "HTTP/1.0 200 OK\r\ncontent-type: application/json\r\n\r\n{body}");
            }
        });
        port
    }

    #[test]
    fn engine_on_port_names_the_root_and_the_supervisor_and_supervisor_alive_wants_a_live_desktop_ts() {
        // The shape, parsed straight — no socket in the way.
        assert_eq!(
            engine_info(r#"{"engine":"/App/engine","bundle":null,"supervisor":4242}"#),
            Some((PathBuf::from("/App/engine"), Some(4242)))
        );
        // An engine from before #597 says nothing about a supervisor — and an
        // orphan of one reports a pid nothing answers to.
        assert_eq!(engine_info(r#"{"engine":"/Old/engine","bundle":"engine abc"}"#), Some((PathBuf::from("/Old/engine"), None)));
        assert_eq!(engine_info(r#"{"engine":"/x","supervisor":null}"#), Some((PathBuf::from("/x"), None)));
        assert_eq!(engine_info(r#"{"nothing":true}"#), None);
        assert_eq!(engine_info("not json at all"), None);

        // And the round trip over a real socket, once.
        assert_eq!(
            engine_on_port(canned(r#"{"engine":"/App/engine","supervisor":4242}"#)),
            Some((PathBuf::from("/App/engine"), Some(4242)))
        );

        // Only a process whose command line is a bin/desktop.ts counts: a
        // reused pid does not become a supervisor by being alive.
        assert!(!supervisor_alive(std::process::id()));
        let mut fake = Command::new("sleep").arg0("bun /App/engine/bin/desktop.ts").arg("30").spawn().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(supervisor_alive(fake.id()));
        let _ = fake.kill();
        let _ = fake.wait();
        assert!(!supervisor_alive(fake.id()));
    }

    #[test]
    fn navigation_keeps_the_viewer_lets_loopback_frames_load_and_opens_only_web_urls() {
        let u = |s: &str| s.parse::<tauri::Url>().unwrap();
        let home = u("http://127.0.0.1:4747/");
        for s in ["http://127.0.0.1:4747/", "http://127.0.0.1:4747/#/note/x", "http://127.0.0.1:4747/?q=1", "about:blank", "about:srcdoc"] {
            assert!(stays(&home, &u(s)), "{s}");
        }
        // A `url` view's frame (an agent's dev server). The policy also sees
        // frames, and these used to be cancelled and opened in the browser.
        for s in ["http://127.0.0.1:5173/", "http://localhost:3000/app?x=1", "http://localhost:4747/"] {
            assert!(stays(&home, &u(s)) && loopback_page(&home, &u(s)), "{s}");
        }
        assert!(stays(&u("http://127.0.0.1:5173/"), &u("http://127.0.0.1:4757/")), "the dev loop's engine, framed under vite");
        assert!(!loopback_page(&home, &home), "the window's own home is never sent home");
        for s in ["http://127.0.0.1:4747/api/file?x=1", "https://example.com/a", "https://127.0.0.1:5173/", "http://127.0.0.2:5173/", "http://192.168.1.2:8080/", "mailto:a@example.com"] {
            assert!(!stays(&home, &u(s)) && browser_url(&u(s)), "{s}");
        }
        for s in ["file:///Applications/Calculator.app", "x-some-app://run?cmd=1", "ftp://example.com/f", "smb://host/share", "tel:+15555550100", "data:text/html,hi", "blob:http://127.0.0.1:4747/abc"] {
            assert!(!stays(&home, &u(s)) && !browser_url(&u(s)), "{s}");
        }
    }

    #[test]
    fn the_viewer_capability_follows_the_window_origin_and_no_other() {
        use tauri::utils::acl::capability::CapabilityFile;
        assert_eq!(viewer_capability("http://127.0.0.1:4747"), None);
        assert_eq!(viewer_capability("http://127.0.0.1:4757"), None);
        let file: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let cap: serde_json::Value = serde_json::from_str(&viewer_capability("http://127.0.0.1:5173").unwrap()).unwrap();
        assert_eq!(cap["remote"]["urls"], serde_json::json!(["http://127.0.0.1:5173"]));
        assert_eq!(cap["permissions"], file["permissions"]);
        assert_eq!(cap["windows"], file["windows"]);
        assert_ne!(cap["identifier"], file["identifier"]);
        // add_capability panics on a capability that does not parse.
        let parsed: CapabilityFile = viewer_capability("http://127.0.0.1:5173").unwrap().parse().unwrap();
        assert!(matches!(parsed, CapabilityFile::Capability(_)));
        assert!(!file["remote"]["urls"].as_array().unwrap().iter().any(|u| u.as_str().unwrap().contains('*')));
    }

    #[test]
    fn same_tree_sees_through_symlinks() {
        let dir = scratch("same");
        let real = engine_tree(&dir.join("real"));
        std::os::unix::fs::symlink(&real, dir.join("alias")).unwrap();
        assert!(same_tree(&dir.join("alias"), &real));
        assert!(!same_tree(&dir.join("other"), &real));
    }
}
