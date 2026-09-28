//! Explicit local-only freeze investigation. Never enabled by telemetry consent.
use std::time::{Duration, Instant};
use tauri::WebviewWindow;

pub fn mode() -> Option<String> {
    std::env::var("BIGBRAIN_UI_DIAGNOSTICS").ok()
        .filter(|s| s == "on" || s == "graph-off")
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sample {
    event: String,
    #[serde(default)]
    id: u32,
    #[serde(default)]
    values: Vec<f64>,
}

pub fn record(window: WebviewWindow, sample: Sample) -> Result<(), String> {
    if mode().is_none() { return Err("UI diagnostics are disabled".into()); }
    const EVENTS: &[&str] = &["start", "input_pointer", "input_key", "input_click", "input_wheel",
        "input_frame", "input_settled", "heartbeat", "native_probe", "error", "rejection",
        "context_lost", "context_restored", "render_error", "visibility"];
    if !EVENTS.contains(&sample.event.as_str()) || sample.values.len() > 12
        || sample.values.iter().any(|v| !v.is_finite() || v.abs() > 1e15) {
        return Err("Invalid diagnostic sample".into());
    }
    // Fixed event names and numbers only: no typed keys, text, paths or URLs.
    log::info!("ui-diagnostic window={} {}", window.label(), serde_json::to_string(&sample).unwrap());
    Ok(())
}

pub fn start(window: &WebviewWindow) {
    if mode().is_none() { return; }
    log::info!("ui-diagnostic mode={}", mode().unwrap());
    let window = window.clone();
    std::thread::spawn(move || {
        let mut id = 0u32;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            id = id.wrapping_add(1);
            let queued = Instant::now();
            let main = window.clone();
            log::info!("ui-diagnostic native_probe_sent id={id}");
            if window.run_on_main_thread(move || {
                log::info!("ui-diagnostic native_main id={id} queue_ms={}", queued.elapsed().as_millis());
                if let Err(e) = main.eval(&format!("window.__BIGBRAIN_UI_DIAGNOSTICS__?.probe({id})")) {
                    log::warn!("ui-diagnostic native_eval_failed id={id} {e}");
                }
            }).is_err() { break; }
        }
    });
}
