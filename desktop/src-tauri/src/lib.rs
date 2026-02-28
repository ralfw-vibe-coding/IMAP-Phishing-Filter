use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
    thread,
    thread::JoinHandle,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

const KEYCHAIN_SERVICE: &str = "imap-phishing-filter";

const LOG_BUFFER_MAX: usize = 2000;

fn macos_clamshell_state() -> Option<bool> {
    if !cfg!(target_os = "macos") {
        return None;
    }

    let ioreg = if Path::new("/usr/sbin/ioreg").exists() {
        "/usr/sbin/ioreg"
    } else {
        "ioreg"
    };

    fn parse(text: &str) -> Option<bool> {
        for line in text.lines() {
            let lower = line.to_lowercase();
            if !lower.contains("appleclamshellstate") {
                continue;
            }
            let (_, rhs) = line.split_once('=')?;
            let v = rhs.trim().trim_matches('"').trim_matches('\'').to_lowercase();

            if v.starts_with("yes") || v.starts_with("true") || v.starts_with('1') {
                return Some(true);
            }
            if v.starts_with("no") || v.starts_with("false") || v.starts_with('0') {
                return Some(false);
            }
        }
        None
    }

    // Preferred: query root power domain (often the canonical location for this key).
    if let Ok(output) = Command::new(ioreg)
        .args(["-r", "-n", "IOPMrootDomain", "-d", "4"])
        .output()
    {
        if output.status.success() {
            if let Some(v) = parse(&String::from_utf8_lossy(&output.stdout)) {
                return Some(v);
            }
        }
    }

    // Fallback: query by key (may work on some systems).
    if let Ok(output) = Command::new(ioreg)
        .args(["-r", "-k", "AppleClamshellState", "-d", "4"])
        .output()
    {
        if output.status.success() {
            if let Some(v) = parse(&String::from_utf8_lossy(&output.stdout)) {
                return Some(v);
            }
        }
    }

    None
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScanLogEvent {
    accountId: String,
    line: String,
    stream: String, // "stdout" | "stderr"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredLogLine {
    at: String,
    #[serde(flatten)]
    evt: ScanLogEvent,
}

#[derive(Debug, Clone, Serialize)]
struct ScanStatusEvent {
    accountId: String,
    status: String, // "scanning" | "idle" | "error"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendInfo {
    session_id: String,
    started_at: String,
}

struct WatchEntry {
    stop: Arc<AtomicBool>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

struct WatchManager {
    watchers: Mutex<HashMap<String, WatchEntry>>,
}

struct ScanManager {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

struct LogStore {
    buf: Mutex<VecDeque<StoredLogLine>>,
    session: BackendInfo,
}

fn emit_log(app: &AppHandle, account_id: &str, line: &str, stream: &str) {
    let evt = ScanLogEvent {
        accountId: account_id.to_string(),
        line: line.to_string(),
        stream: stream.to_string(),
    };
    emit_scan_line(app, evt);
}

fn logs_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(dir.join("run.log.jsonl"))
}

fn append_log_to_disk(app: &AppHandle, line: &StoredLogLine) {
    let path = match logs_file(app) {
        Ok(p) => p,
        Err(_) => return,
    };
    let raw = match serde_json::to_string(line) {
        Ok(s) => s,
        Err(_) => return,
    };
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, format!("{raw}\n").as_bytes()));
}

fn emit_scan_line(app: &AppHandle, evt: ScanLogEvent) {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stored = StoredLogLine {
        at: at.to_string(),
        evt: evt.clone(),
    };

    if let Some(store) = app.try_state::<LogStore>() {
        if let Ok(mut guard) = store.buf.lock() {
            guard.push_back(stored.clone());
            while guard.len() > LOG_BUFFER_MAX {
                guard.pop_front();
            }
        }
    }
    append_log_to_disk(app, &stored);

    let _ = app.emit("scan_log", evt);
}

fn emit_status(app: &AppHandle, account_id: &str, status: &str) {
    let _ = app.emit(
        "scan_status",
        ScanStatusEvent {
            accountId: account_id.to_string(),
            status: status.to_string(),
        },
    );
}

#[tauri::command]
fn get_backend_info(app: AppHandle) -> Result<BackendInfo, String> {
    let store = app.state::<LogStore>();
    Ok(store.session.clone())
}

#[tauri::command]
fn load_recent_logs(app: AppHandle, limit: Option<u32>) -> Result<Vec<ScanLogEvent>, String> {
    let limit = limit.unwrap_or(300).min(2000) as usize;

    // Prefer in-memory buffer (survives webview reload).
    if let Some(store) = app.try_state::<LogStore>() {
        if let Ok(guard) = store.buf.lock() {
            let slice_start = guard.len().saturating_sub(limit);
            return Ok(guard
                .iter()
                .skip(slice_start)
                .map(|l| l.evt.clone())
                .collect());
        }
    }

    // Fallback: read from disk (survives backend restarts).
    let path = logs_file(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("Failed to read logs: {e}"))?;
    let lines: Vec<&str> = raw.lines().collect();
    let slice_start = lines.len().saturating_sub(limit);
    let mut out: Vec<ScanLogEvent> = vec![];
    for line in lines.iter().skip(slice_start) {
        if let Ok(parsed) = serde_json::from_str::<StoredLogLine>(line) {
            out.push(parsed.evt);
        }
    }
    Ok(out)
}

fn start_watch_inner(app: AppHandle, state: &WatchManager, account_id: String) -> Result<bool, String> {
    let mut map = state
        .watchers
        .lock()
        .map_err(|_| "watch lock poisoned".to_string())?;
    if map.contains_key(&account_id) {
        return Ok(false);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let app2 = app.clone();
    let id2 = account_id.clone();

    let handle = tauri::async_runtime::spawn_blocking(move || {
        emit_status(&app2, &id2, "watching");

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
                Some(stop2.clone()),
            );

            // Sleep (coarse). If macOS clamshell closes, the global monitor will abort this watcher.
            let mut slept = 0u64;
            while slept < 60 && !stop2.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(1));
                slept += 1;
            }
        }

        emit_status(&app2, &id2, "idle");
    });

    map.insert(
        account_id,
        WatchEntry {
            stop,
            handle,
        },
    );
    Ok(true)
}

fn stop_watch_inner(
    app: &AppHandle,
    state: &WatchManager,
    account_id: &str,
    status: &str,
) -> Result<(), String> {
    let mut map = state
        .watchers
        .lock()
        .map_err(|_| "watch lock poisoned".to_string())?;
    if let Some(entry) = map.remove(account_id) {
        entry.stop.store(true, Ordering::Relaxed);
        entry.handle.abort();
        emit_status(app, account_id, status);
    }
    Ok(())
}

fn stop_all_watches(app: &AppHandle, state: &WatchManager, status: &str) -> Vec<String> {
    let mut stopped: Vec<String> = vec![];
    let mut map = match state.watchers.lock() {
        Ok(m) => m,
        Err(_) => return stopped,
    };

    for (account_id, entry) in map.drain() {
        entry.stop.store(true, Ordering::Relaxed);
        entry.handle.abort();
        emit_status(app, &account_id, status);
        stopped.push(account_id);
    }

    stopped
}

fn cancel_all_scans(app: &AppHandle, scans: &ScanManager) -> usize {
    let mut cancelled = 0usize;
    let map = match scans.cancels.lock() {
        Ok(m) => m,
        Err(_) => return 0,
    };
    for (account_id, token) in map.iter() {
        token.store(true, Ordering::Relaxed);
        emit_log(app, account_id, "Stop requested: cancelling scan…", "stdout");
        cancelled += 1;
    }
    cancelled
}

fn macos_is_clamshell_closed() -> bool {
    // Battery-safe default: if we cannot determine the state, assume closed.
    macos_clamshell_state().unwrap_or(true)
}

fn repo_root() -> PathBuf {
    // In dev, this points to .../desktop/src-tauri
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest_dir.parent().and_then(|p| p.parent()) {
        return root.to_path_buf();
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn resolve_node_binary() -> String {
    // Finder-launched apps often have a minimal PATH; prefer well-known install locations.
    if let Ok(p) = std::env::var("PHISHINGKILLER_NODE_PATH") {
        let p = p.trim().to_string();
        if !p.is_empty() {
            return p;
        }
    }

    let mut candidates: Vec<String> = vec![
        "/opt/homebrew/bin/node".to_string(),
        "/usr/local/bin/node".to_string(),
        "/usr/bin/node".to_string(),
    ];

    if let Ok(home) = std::env::var("HOME") {
        // Volta
        candidates.push(format!("{home}/.volta/bin/node"));
        // asdf
        candidates.push(format!("{home}/.asdf/shims/node"));

        // nvm: pick the latest version directory if present
        let nvm_root = PathBuf::from(format!("{home}/.nvm/versions/node"));
        if let Ok(entries) = fs::read_dir(&nvm_root) {
            let mut bins: Vec<String> = vec![];
            for e in entries.flatten() {
                if let Ok(ft) = e.file_type() {
                    if !ft.is_dir() {
                        continue;
                    }
                }
                let p = e.path().join("bin").join("node");
                if p.exists() {
                    bins.push(p.to_string_lossy().to_string());
                }
            }
            bins.sort();
            if let Some(last) = bins.last().cloned() {
                candidates.push(last);
            }
        }
    }

    for path in candidates {
        if Path::new(&path).exists() {
            return path;
        }
    }

    // Last resort: rely on PATH
    "node".to_string()
}

fn resolve_runtime_root(app: &AppHandle) -> PathBuf {
    // Dev: repo root (contains phishingdetection_prompt.txt + dist/)
    let dev_root = repo_root();
    if dev_root.join("dist").join("scan.js").exists() && dev_root.join("phishingdetection_prompt.txt").exists() {
        return dev_root;
    }

    // Prod: bundled resources dir (contains dist/ + phishingdetection_prompt.txt)
    if let Ok(dir) = app.path().resource_dir() {
        return dir;
    }

    // Fallback
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
    let cancel = {
        let cancels = app.state::<ScanManager>();
        let mut map = cancels
            .cancels
            .lock()
            .map_err(|_| "scan lock poisoned".to_string())?;
        if map.contains_key(&accountId) {
            return Err("Scan is already running for this account".to_string());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        map.insert(accountId.clone(), cancel.clone());
        cancel
    };

    let app2 = app.clone();
    let account_id2 = accountId.clone();
    tauri::async_runtime::spawn(async move {
        let _ = run_scan_process(
            app2.clone(),
            account_id2.clone(),
            "latest".to_string(),
            None,
            None,
            Some("idle".to_string()),
            Some(cancel),
        );

        // Always clear running state
        if let Ok(mut map) = app2.state::<ScanManager>().cancels.lock() {
            map.remove(&account_id2);
        }
    });

    Ok(())
}

#[tauri::command]
fn start_watch(app: AppHandle, state: State<WatchManager>, accountId: String) -> Result<String, String> {
    if cfg!(target_os = "macos") && macos_is_clamshell_closed() {
        emit_status(&app, &accountId, "paused");
        let state = macos_clamshell_state();
        let why = match state {
            Some(true) => "clamshell=closed",
            None => "clamshell=unknown (defaulting closed)",
            Some(false) => "clamshell=open (unexpected)",
        };
        emit_log(
            &app,
            &accountId,
            &format!("Continuous mode requested while clamshell is closed/unknown; not starting watcher (paused). ({why})"),
            "stdout",
        );
        return Ok("paused".to_string());
    }
    let started = start_watch_inner(app.clone(), &state, accountId.clone())?;
    if started {
        Ok("watching".to_string())
    } else {
        // already running
        Ok("watching".to_string())
    }
}

#[tauri::command]
fn stop_watch(app: AppHandle, state: State<WatchManager>, accountId: String) -> Result<String, String> {
    stop_watch_inner(&app, &state, &accountId, "idle")?;
    Ok("idle".to_string())
}

#[tauri::command]
fn cancel_scan(app: AppHandle, accountId: String) -> Result<(), String> {
    let cancels = app.state::<ScanManager>();
    let map = cancels
        .cancels
        .lock()
        .map_err(|_| "scan lock poisoned".to_string())?;
    if let Some(token) = map.get(&accountId) {
        token.store(true, Ordering::Relaxed);
        let _ = app.emit(
            "scan_log",
            ScanLogEvent {
                accountId,
                line: "Stop requested: cancelling scan…".to_string(),
                stream: "stdout".to_string(),
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
    cancel: Option<Arc<AtomicBool>>,
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

    let root = resolve_runtime_root(&app);
    let scan_js = root.join("dist").join("scan.js");
    if !scan_js.exists() {
        let res = app
            .path()
            .resource_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "<unknown>".to_string());
        emit_error(format!(
            "Missing scan executable at {} (resource_dir={}). Run `npm run build` in the repo root first, then `npm run dist:mac`.",
            scan_js.display(),
            res
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

    let scan_result: Arc<Mutex<Option<ScanResult>>> = Arc::new(Mutex::new(None));

    let node_bin = resolve_node_binary();

    let mut cmd = Command::new(node_bin);
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

    let mut join_handles: Vec<JoinHandle<()>> = vec![];

    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone();
        let acc2 = account_id.clone();
        let scan_result2 = scan_result.clone();
        join_handles.push(std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Some(rest) = line.strip_prefix("@@SCAN_RESULT@@ ") {
                    if let Ok(parsed) = serde_json::from_str::<ScanResult>(rest.trim()) {
                        if let Ok(mut guard) = scan_result2.lock() {
                            *guard = Some(parsed);
                        }
                    }
                    continue;
                }
                emit_scan_line(
                    &app2,
                    ScanLogEvent {
                        accountId: acc2.clone(),
                        line,
                        stream: "stdout".to_string(),
                    },
                );
            }
        }));
    }

    if let Some(stderr) = child.stderr.take() {
        let app2 = app.clone();
        let acc2 = account_id.clone();
        join_handles.push(std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                emit_scan_line(
                    &app2,
                    ScanLogEvent {
                        accountId: acc2.clone(),
                        line,
                        stream: "stderr".to_string(),
                    },
                );
            }
        }));
    }

    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Ok(s),
            Ok(None) => {
                if let Some(token) = &cancel {
                    if token.load(Ordering::Relaxed) && !cancelled {
                        cancelled = true;
                        emit_log(
                            &app,
                            &account_id,
                            "Cancelling scan (killing node process)…",
                            "stdout",
                        );
                        let _ = child.kill();
                    }
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(e) => break Err(e),
        }
    };

    // Ensure we consumed all stdout/stderr (and parsed @@SCAN_RESULT@@) before proceeding
    for h in join_handles {
        let _ = h.join();
    }

    if let Ok(s) = status {
        if !s.success() {
            if cancelled {
                emit_log(
                    &app,
                    &account_id,
                    &format!("Scan cancelled (process exited with status {s})"),
                    "stdout",
                );
            } else {
                emit_log(
                    &app,
                    &account_id,
                    &format!("Scan process exited with status {s}"),
                    "stderr",
                );
            }
        }
    }

    // Update lastSeenUid if provided
    if let Ok(guard) = scan_result.lock() {
        if let Some(res) = guard.clone() {
            let _ = update_last_seen_uid(&app, &account_id, res.lastSeenUid);
        } else if !cancelled {
            let _ = app.emit(
                "scan_log",
                ScanLogEvent {
                    accountId: account_id.clone(),
                    line: "Warning: scan did not report @@SCAN_RESULT@@ (lastSeenUid not updated)".to_string(),
                    stream: "stderr".to_string(),
                },
            );
        }
    }

    // Avoid overwriting Pause state when we cancelled a continuous watch scan.
    let should_emit_status = !(cancelled && status_after.as_deref() == Some("watching"));
    if should_emit_status {
        let _ = app.emit(
            "scan_status",
            ScanStatusEvent {
                accountId: account_id.clone(),
                status: status_after.unwrap_or_else(|| "idle".to_string()),
            },
        );
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let session_id = format!("{}-{}", std::process::id(), started_at);

    tauri::Builder::default()
        .manage(WatchManager {
            watchers: Mutex::new(HashMap::new()),
        })
        .manage(ScanManager {
            cancels: Mutex::new(HashMap::new()),
        })
        .manage(LogStore {
            buf: Mutex::new(VecDeque::new()),
            session: BackendInfo {
                session_id: session_id.clone(),
                started_at: started_at.to_string(),
            },
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let store = handle.state::<LogStore>();
            emit_log(&handle, "app", &format!("Backend started (session={})", store.session.session_id), "stdout");

            if cfg!(target_os = "macos") {
                let handle = handle.clone();

                tauri::async_runtime::spawn_blocking(move || {
                    // Default state: assume open (avoid stopping work on transient errors)
                    let mut last_closed = false;
                    let mut warned_unknown = false;

                    // Emit initial state once
                    let initial = macos_clamshell_state();
                    match initial {
                        Some(true) => emit_log(&handle, "app", "macOS clamshell state at startup: closed (continuous checks will be paused).", "stdout"),
                        Some(false) => emit_log(&handle, "app", "macOS clamshell state at startup: open.", "stdout"),
                        None => emit_log(&handle, "app", "macOS clamshell state at startup: unknown (defaulting to closed to avoid battery drain).", "stderr"),
                    }

                    loop {
                        let state = macos_clamshell_state();
                        if state.is_none() && !warned_unknown {
                            warned_unknown = true;
                            emit_log(
                                &handle,
                                "app",
                                "Warning: unable to read macOS clamshell state; defaulting to 'closed' to avoid battery drain.",
                                "stderr",
                            );
                        }
                        let closed = state.unwrap_or(true);

                        if closed && !last_closed {
                            last_closed = true;

                            let watches = handle.state::<WatchManager>();
                            let scans = handle.state::<ScanManager>();
                            let stopped = stop_all_watches(&handle, watches.inner(), "paused");
                            let cancelled = cancel_all_scans(&handle, scans.inner());

                            for id in &stopped {
                                emit_log(
                                    &handle,
                                    id,
                                    "macOS clamshell closed: stopped continuous watcher to save battery.",
                                    "stdout",
                                );
                            }

                            if cancelled > 0 {
                                emit_log(
                                    &handle,
                                    "app",
                                    &format!("macOS clamshell closed: cancelling {cancelled} running scan(s)."),
                                    "stdout",
                                );
                            }
                        } else if !closed && last_closed {
                            last_closed = false;

                            // Restart all continuous watchers based on persisted settings.
                            let file = match accounts_file(&handle) {
                                Ok(f) => f,
                                Err(_) => {
                                    thread::sleep(Duration::from_secs(10));
                                    continue;
                                }
                            };
                            let records = match load_records(&file) {
                                Ok(r) => r,
                                Err(_) => {
                                    thread::sleep(Duration::from_secs(10));
                                    continue;
                                }
                            };

                            let watches = handle.state::<WatchManager>();
                            for r in records {
                                if matches!(r.mode, AccountMode::Continuous) {
                                    let _ = start_watch_inner(handle.clone(), watches.inner(), r.id.clone());
                                    emit_log(
                                        &handle,
                                        &r.id,
                                        "macOS clamshell opened: restarted continuous watcher.",
                                        "stdout",
                                    );
                                }
                            }
                        }

                        // Keep this low-frequency to reduce battery drain while still reacting.
                        let sleep_s = if last_closed { 30 } else { 10 };
                        thread::sleep(Duration::from_secs(sleep_s));
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_backend_info,
            load_recent_logs,
            load_accounts,
            upsert_account,
            delete_account,
            start_on_demand_scan,
            cancel_scan,
            start_watch,
            stop_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
