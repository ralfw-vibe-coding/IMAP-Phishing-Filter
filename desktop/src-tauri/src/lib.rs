use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

const KEYCHAIN_SERVICE: &str = "imap-phishing-filter";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum OnDemandPolicy {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "latest")]
    Latest { n: u32 },
    #[serde(rename = "since_uid")]
    SinceUid { uid: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum ContinuousPolicy {
    #[serde(rename = "poll")]
    Poll { intervalSeconds: u32 },
    #[serde(rename = "idle")]
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AccountMode {
    OnDemand,
    Continuous,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccountRecord {
    id: String,
    label: String,
    server: String,
    user: String,
    folder: String,
    mode: AccountMode,
    onDemand: OnDemandPolicy,
    continuous: ContinuousPolicy,
    lastSeenUid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
struct AccountView {
    #[serde(flatten)]
    record: AccountRecord,
    hasPassword: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ScanLogEvent {
    accountId: String,
    line: String,
    stream: String, // "stdout" | "stderr"
}

#[derive(Debug, Clone, Serialize)]
struct ScanStatusEvent {
    accountId: String,
    status: String, // "scanning" | "idle" | "error"
}

struct WatchEntry {
    stop: Arc<AtomicBool>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

struct WatchManager {
    watchers: Mutex<HashMap<String, WatchEntry>>,
}

fn repo_root() -> PathBuf {
    // In dev, this points to .../desktop/src-tauri
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest_dir.parent().and_then(|p| p.parent()) {
        return root.to_path_buf();
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn accounts_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(dir.join("accounts.json"))
}

fn load_records(path: &Path) -> Result<Vec<AccountRecord>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Failed to read accounts file: {e}"))?;
    let parsed = serde_json::from_str::<Vec<AccountRecord>>(&raw)
        .map_err(|e| format!("Failed to parse accounts file: {e}"))?;
    Ok(parsed)
}

fn update_last_seen_uid(app: &AppHandle, account_id: &str, last_seen_uid: u32) -> Result<(), String> {
    let file = accounts_file(app)?;
    let mut records = load_records(&file)?;
    let mut changed = false;
    for r in records.iter_mut() {
        if r.id == account_id {
            if r.lastSeenUid != Some(last_seen_uid) {
                r.lastSeenUid = Some(last_seen_uid);
                changed = true;
            }
            break;
        }
    }
    if changed {
        write_records(&file, &records)?;
    }
    Ok(())
}

fn write_records(path: &Path, records: &[AccountRecord]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(records).map_err(|e| format!("Failed to encode accounts: {e}"))?;
    fs::write(path, raw).map_err(|e| format!("Failed to write accounts file: {e}"))?;
    Ok(())
}

fn security_keychain_has(account_id: &str) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            account_id,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn security_keychain_get(account_id: &str) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Err("Password storage is not implemented on this OS (macOS only for MVP)".to_string());
    }

    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            account_id,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
        ])
        .output()
        .map_err(|e| format!("Failed to run `security`: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "Missing password in Keychain for account {account_id} (security exit={})",
            output.status
        ));
    }

    let pw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if pw.is_empty() {
        return Err(format!("Password in Keychain is empty for account {account_id}"));
    }
    Ok(pw)
}

fn security_keychain_set(account_id: &str, password: &str) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Password storage is not implemented on this OS (macOS only for MVP)".to_string());
    }

    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            account_id,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            password,
            "-U",
        ])
        .status()
        .map_err(|e| format!("Failed to run `security`: {e}"))?;

    if !status.success() {
        return Err(format!("Failed to store password in Keychain (security exit={status})"));
    }
    Ok(())
}

fn security_keychain_delete(account_id: &str) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }

    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            account_id,
            "-s",
            KEYCHAIN_SERVICE,
        ])
        .status();

    Ok(())
}

#[tauri::command]
fn load_accounts(app: AppHandle) -> Result<Vec<AccountView>, String> {
    let file = accounts_file(&app)?;
    let records = load_records(&file)?;
    Ok(records
        .into_iter()
        .map(|r| AccountView {
            hasPassword: security_keychain_has(&r.id),
            record: r,
        })
        .collect())
}

#[tauri::command]
fn upsert_account(app: AppHandle, account: AccountRecord, password: Option<String>) -> Result<(), String> {
    let file = accounts_file(&app)?;
    let mut records = load_records(&file)?;
    let idx = records.iter().position(|r| r.id == account.id);
    if let Some(i) = idx {
        records[i] = account.clone();
    } else {
        records.push(account.clone());
    }

    // Store password (if provided and non-empty). Empty means "leave unchanged".
    if let Some(pw) = password {
        if !pw.trim().is_empty() {
            security_keychain_set(&account.id, pw.trim())?;
        }
    }

    write_records(&file, &records)?;
    Ok(())
}

#[tauri::command]
fn delete_account(app: AppHandle, accountId: String) -> Result<(), String> {
    let file = accounts_file(&app)?;
    let mut records = load_records(&file)?;
    records.retain(|r| r.id != accountId);
    write_records(&file, &records)?;
    let _ = security_keychain_delete(&accountId);
    Ok(())
}

#[tauri::command]
fn start_on_demand_scan(app: AppHandle, accountId: String) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        let _ = run_scan_process(
            app,
            accountId,
            "latest".to_string(),
            None,
            None,
            Some("idle".to_string()),
        );
    });
    Ok(())
}

#[tauri::command]
fn start_watch(app: AppHandle, state: State<WatchManager>, accountId: String) -> Result<(), String> {
    let mut map = state.watchers.lock().map_err(|_| "watch lock poisoned".to_string())?;
    if map.contains_key(&accountId) {
        return Ok(());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let app2 = app.clone();
    let id2 = accountId.clone();

    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _ = app2.emit(
            "scan_status",
            ScanStatusEvent {
                accountId: id2.clone(),
                status: "watching".to_string(),
            },
        );

        loop {
            if stop2.load(Ordering::Relaxed) {
                break;
            }

            // Run incremental scan (since lastSeenUid). Limit per tick to keep it safe/cost-bounded.
            let _ = run_scan_process(
                app2.clone(),
                id2.clone(),
                "since".to_string(),
                None,
                Some(25),
                Some("watching".to_string()),
            );

            let mut slept = 0u64;
            while slept < 60 && !stop2.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(1));
                slept += 1;
            }
        }

        let _ = app2.emit(
            "scan_status",
            ScanStatusEvent {
                accountId: id2.clone(),
                status: "idle".to_string(),
            },
        );
    });

    map.insert(
        accountId,
        WatchEntry {
            stop,
            handle,
        },
    );
    Ok(())
}

#[tauri::command]
fn stop_watch(app: AppHandle, state: State<WatchManager>, accountId: String) -> Result<(), String> {
    let mut map = state.watchers.lock().map_err(|_| "watch lock poisoned".to_string())?;
    if let Some(entry) = map.remove(&accountId) {
        entry.stop.store(true, Ordering::Relaxed);
        entry.handle.abort();
        let _ = app.emit(
            "scan_status",
            ScanStatusEvent {
                accountId,
                status: "idle".to_string(),
            },
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
struct ScanResult {
    lastSeenUid: u32,
    processed: u32,
    flagged: u32,
}

fn run_scan_process(
    app: AppHandle,
    account_id: String,
    scan_kind: String, // "latest" | "since"
    explicit_latest_n: Option<u32>,
    max_messages: Option<u32>,
    status_after: Option<String>,
) -> Result<(), String> {
    let emit_error = |msg: String| {
        let _ = app.emit(
            "scan_log",
            ScanLogEvent {
                accountId: account_id.clone(),
                line: msg,
                stream: "stderr".to_string(),
            },
        );
        let _ = app.emit(
            "scan_status",
            ScanStatusEvent {
                accountId: account_id.clone(),
                status: "error".to_string(),
            },
        );
    };

    let file = match accounts_file(&app) {
        Ok(f) => f,
        Err(e) => {
            emit_error(e);
            return Ok(());
        }
    };
    let records = match load_records(&file) {
        Ok(r) => r,
        Err(e) => {
            emit_error(e);
            return Ok(());
        }
    };
    let account = match records.iter().find(|r| r.id == account_id).cloned() {
        Some(a) => a,
        None => {
            emit_error("Account not found".to_string());
            return Ok(());
        }
    };

    let password = match security_keychain_get(&account.id) {
        Ok(p) => p,
        Err(e) => {
            emit_error(e);
            return Ok(());
        }
    };

    let latest_n = explicit_latest_n.unwrap_or_else(|| match account.onDemand {
        OnDemandPolicy::Latest { n } => n,
        _ => 10,
    });

    let since_uid = account.lastSeenUid;

    let root = repo_root();
    let scan_js = root.join("dist").join("scan.js");
    if !scan_js.exists() {
        emit_error(format!(
            "Missing scan executable at {}. Run `npm run build` in the repo root first.",
            scan_js.display()
        ));
        return Ok(());
    }

    let _ = app.emit(
        "scan_status",
        ScanStatusEvent {
            accountId: account_id.clone(),
            status: "scanning".to_string(),
        },
    );

    let (tx, rx) = std::sync::mpsc::channel::<ScanResult>();

    let mut cmd = Command::new("node");
    cmd.current_dir(&root)
        .arg(scan_js)
        .env(
            "SCAN_ACCOUNT_JSON",
            serde_json::json!({
                "label": account.label,
                "server": account.server,
                "user": account.user,
                "password": password,
                "folder": account.folder
            })
            .to_string(),
        )
        .env("SCAN_KIND", scan_kind.clone())
        .env("SCAN_LATEST_N", latest_n.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if scan_kind == "since" {
        if let Some(uid) = since_uid {
            cmd.env("SCAN_SINCE_UID", uid.to_string());
        }
        if let Some(m) = max_messages {
            cmd.env("SCAN_MAX_MESSAGES", m.to_string());
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(format!("Failed to spawn node process: {e}"));
            return Ok(());
        }
    };

    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone();
        let acc2 = account_id.clone();
        let tx2 = tx.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Some(rest) = line.strip_prefix("@@SCAN_RESULT@@ ") {
                    if let Ok(parsed) = serde_json::from_str::<ScanResult>(rest.trim()) {
                        let _ = tx2.send(parsed);
                    }
                    continue;
                }
                let _ = app2.emit(
                    "scan_log",
                    ScanLogEvent {
                        accountId: acc2.clone(),
                        line,
                        stream: "stdout".to_string(),
                    },
                );
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app2 = app.clone();
        let acc2 = account_id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                let _ = app2.emit(
                    "scan_log",
                    ScanLogEvent {
                        accountId: acc2.clone(),
                        line,
                        stream: "stderr".to_string(),
                    },
                );
            }
        });
    }

    let status = child.wait();

    if let Ok(s) = status {
        if !s.success() {
            let _ = app.emit(
                "scan_log",
                ScanLogEvent {
                    accountId: account_id.clone(),
                    line: format!("Scan process exited with status {s}"),
                    stream: "stderr".to_string(),
                },
            );
        }
    }

    // Update lastSeenUid if provided
    if let Ok(res) = rx.recv_timeout(Duration::from_millis(500)) {
        let _ = update_last_seen_uid(&app, &account_id, res.lastSeenUid);
    }

    let _ = app.emit(
        "scan_status",
        ScanStatusEvent {
            accountId: account_id.clone(),
            status: status_after.unwrap_or_else(|| "idle".to_string()),
        },
    );

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WatchManager {
            watchers: Mutex::new(HashMap::new()),
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_accounts,
            upsert_account,
            delete_account,
            start_on_demand_scan,
            start_watch,
            stop_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
