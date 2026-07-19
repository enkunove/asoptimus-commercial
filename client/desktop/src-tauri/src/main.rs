// ASOptimus macOS desktop shell (Tauri 2.x).
//
// Lifecycle:
//   1. pick a free localhost port;
//   2. spawn the compiled Bun client as a SIDECAR (bundle.externalBin) with
//      `--port <free> --no-open --data-dir <appLocalData>` and env ASO_SIDECAR=1
//      (so it emits status lines) — cloud env (DEV / ASO_CLOUD_*) is passed through;
//   3. read the sidecar's stdout; on `ASOPTIMUS_LISTENING <port>` build the native
//      webview window pointing at http://127.0.0.1:<port> (the localhost UI — NOT a
//      browser tab); on `ASOPTIMUS_STATUS {json}` update the tray tooltip
//      (Connected/Disconnected + balance);
//   4. tray menu: Open · Top up · Quit; closing the window hides it (stays in tray);
//   5. on quit / app exit — kill the sidecar.
//
// No proprietary logic here — this is a UX shell around the localhost binary.

#![cfg_attr(all(not(debug_assertions), target_os = "macos"), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar so we can kill it on quit.
struct SidecarState(Mutex<Option<CommandChild>>);

const SIDECAR_NAME: &str = "asoptimus-sidecar";
const WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "main";

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(4317)
}

fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

fn build_main_window(app: &tauri::AppHandle, url: &str) {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return;
    }
    if let Ok(parsed) = url.parse() {
        let _ = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(parsed))
            .title("ASOptimus")
            .inner_size(1200.0, 820.0)
            .min_inner_size(900.0, 600.0)
            .build();
    }
}

/// Parse a status line → (tooltip, menu-bar title). Tooltip: full "Connected/Disconnected + balance";
/// title: a compact at-a-glance marker (● connected / ○ disconnected, + balance credits).
fn tray_labels_from_status(json: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let activated = v.get("activated").and_then(|x| x.as_bool()).unwrap_or(false);
    let connected = v.get("connected").and_then(|x| x.as_bool()).unwrap_or(false);
    let balance = v.get("balance").and_then(|x| x.as_f64());
    let (state, title) = if !activated {
        ("not activated".to_string(), "○".to_string())
    } else if connected {
        match balance {
            Some(b) => (format!("connected · {} cr.", trim_num(b)), format!("● {}", trim_num(b))),
            None => ("connected".to_string(), "●".to_string()),
        }
    } else {
        ("disconnected".to_string(), "○".to_string())
    };
    Some((format!("ASOptimus — {}", state), title))
}

fn trim_num(b: f64) -> String {
    if (b.fract()).abs() < f64::EPSILON {
        format!("{}", b as i64)
    } else {
        format!("{:.2}", b)
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let port = free_port();
            let url = format!("http://127.0.0.1:{}", port);

            // Per-user data dir for the sidecar (Apple cache + dev session fallback).
            let data_dir = app
                .path()
                .app_local_data_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            // Spawn the Bun sidecar.
            let mut cmd = app
                .shell()
                .sidecar(SIDECAR_NAME)
                .expect("sidecar binary not bundled")
                .args(["--port", &port.to_string(), "--no-open"])
                .env("ASO_SIDECAR", "1");
            if !data_dir.is_empty() {
                cmd = cmd.args(["--data-dir", &data_dir]);
            }
            // Pass through cloud/dev env if the launcher set it (prod uses built-in defaults).
            for key in ["DEV", "ASO_CLOUD_WSS", "ASO_CLOUD_HTTPS"] {
                if let Ok(val) = std::env::var(key) {
                    cmd = cmd.env(key, val);
                }
            }
            let (mut rx, child) = cmd.spawn().expect("failed to spawn sidecar");
            app.state::<SidecarState>().0.lock().unwrap().replace(child);

            // Tray icon + menu (Open / Top up / Quit).
            let open_i = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let topup_i = MenuItem::with_id(app, "topup", "Top up", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &topup_i, &quit_i])?;

            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("ASOptimus — starting…")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "topup" => {
                        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.eval("location.hash = '#/balance'");
                        }
                    }
                    "quit" => {
                        kill_sidecar(app);
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            let _tray = tray.build(app)?;

            // Read sidecar stdout: build window on readiness marker, relay status to tray.
            // Window/tray mutations must run on the main thread → marshal via run_on_main_thread.
            let built = Arc::new(AtomicBool::new(false));
            let stdout_handle = handle.clone();
            let stdout_built = built.clone();
            let stdout_url = url.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(bytes) = event {
                        let chunk = String::from_utf8_lossy(&bytes);
                        for line in chunk.lines() {
                            let line = line.trim();
                            if line.starts_with("ASOPTIMUS_LISTENING") {
                                if !stdout_built.swap(true, Ordering::SeqCst) {
                                    let h = stdout_handle.clone();
                                    let u = stdout_url.clone();
                                    let _ = stdout_handle.run_on_main_thread(move || build_main_window(&h, &u));
                                }
                            } else if let Some(rest) = line.strip_prefix("ASOPTIMUS_STATUS ") {
                                if let Some((tip, title)) = tray_labels_from_status(rest) {
                                    let h = stdout_handle.clone();
                                    let _ = stdout_handle.run_on_main_thread(move || {
                                        if let Some(t) = h.tray_by_id(TRAY_ID) {
                                            let _ = t.set_tooltip(Some(tip));
                                            let _ = t.set_title(Some(title));
                                        }
                                    });
                                }
                            }
                        }
                    }
                }
            });

            // Fallback: if the readiness marker never arrives, open the window anyway after 10s.
            let fb_handle = handle.clone();
            let fb_built = built.clone();
            let fb_url = url.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(10));
                if !fb_built.swap(true, Ordering::SeqCst) {
                    let h = fb_handle.clone();
                    let u = fb_url.clone();
                    let _ = fb_handle.run_on_main_thread(move || build_main_window(&h, &u));
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app alive in the tray (Quit exits via the tray menu).
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ASOptimus desktop app")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(app);
            }
        });
}
