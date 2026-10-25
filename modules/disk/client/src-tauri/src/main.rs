//! PagesAI Disk 桌面壳。
//!
//! 安全边界：
//! - 服务地址由部署者填写，制品不内置私人域名；
//! - 设备令牌只进系统凭据库，设置文件不含秘密；
//! - 同步目录必须是用户明确选择的一个目录，不会是整盘或整个用户主目录；
//! - 同步失败只报告，不删除本地或远端文件。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use pagesai_disk_sync::strategy::{self, Strategy};
use pagesai_disk_sync::{pair_device, revoke_device, Engine, HttpRemote, PathRules, Remote, RemotePool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

const KEYRING_SERVICE: &str = "cn.pagesai.disk";
const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    service_url: String,
    root: String,
    device_id: String,
    device_name: String,
    campus_endpoint: String,
    interval_minutes: u32,
    auto_start: bool,
    sync_on_launch: bool,
}

struct AppState {
    settings: Mutex<Settings>,
    syncing: Arc<AtomicBool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self { settings: Mutex::new(Settings::default()), syncing: Arc::new(AtomicBool::new(false)) }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    service_url: String,
    code: String,
    root: String,
    #[serde(default)]
    device_name: String,
    #[serde(default)]
    campus_endpoint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsInput {
    root: String,
    #[serde(default)]
    campus_endpoint: String,
    #[serde(default)]
    interval_minutes: u32,
    #[serde(default)]
    sync_on_launch: bool,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|error| format!("无法定位配置目录：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    Ok(dir.join(SETTINGS_FILE))
}

fn load_settings(app: &AppHandle) -> Settings {
    let Ok(path) = config_path(app) else { return Settings::default(); };
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = config_path(app)?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    pagesai_disk_sync::util::write_atomic(&path, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn token_entry(device_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, device_id).map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn read_token(device_id: &str) -> Result<String, String> {
    token_entry(device_id)?
        .get_password()
        .map_err(|error| format!("未找到设备令牌或系统凭据不可用：{error}"))
}

fn write_token(device_id: &str, token: &str) -> Result<(), String> {
    token_entry(device_id)?
        .set_password(token)
        .map_err(|error| format!("写入系统凭据失败：{error}"))
}

fn delete_token(device_id: &str) {
    if let Ok(entry) = token_entry(device_id) {
        let _ = entry.delete_credential();
    }
}

fn validate_root(root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(root.trim());
    if root.trim().is_empty() {
        return Err("请选择要同步的本地文件夹".into());
    }
    if !path.is_absolute() {
        return Err("同步目录必须是绝对路径".into());
    }
    fs::create_dir_all(&path).map_err(|error| format!("无法创建同步目录：{error}"))?;
    let canonical = path.canonicalize().map_err(|error| format!("无法解析同步目录：{error}"))?;
    if canonical.parent().is_none() {
        return Err("不能把整个文件系统根目录作为同步目录".into());
    }
    if let Some(home) = home_dir() {
        if let Ok(home) = home.canonicalize() {
            if canonical == home {
                return Err("不能同步整个用户主目录；请选择其中一个子文件夹".into());
            }
        }
    }
    Ok(canonical)
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    { std::env::var_os("USERPROFILE").map(PathBuf::from) }
    #[cfg(not(windows))]
    { std::env::var_os("HOME").map(PathBuf::from) }
}

fn build_remote(settings: &Settings, token: &str) -> Result<RemotePool, String> {
    let policy = strategy::selected();
    let endpoints = policy.endpoints(
        &settings.service_url,
        if settings.campus_endpoint.trim().is_empty() { None } else { Some(&settings.campus_endpoint) },
    )?;
    let mut remotes: Vec<Box<dyn Remote>> = Vec::new();
    for endpoint in endpoints {
        remotes.push(Box::new(HttpRemote::new(&endpoint.url, token.to_string())?));
    }
    RemotePool::new(remotes)
}

fn run_sync(settings: &Settings, token: &str) -> Result<Value, String> {
    let root = validate_root(&settings.root)?;
    if settings.device_id.is_empty() {
        return Err("尚未配对设备".into());
    }
    let remote = build_remote(settings, token)?;
    let rules = PathRules::current();
    let mut engine = Engine::with_rules(&root, &settings.device_id, remote, rules)?;
    let report = engine.sync()?;
    let state = engine.status();
    Ok(json!({
        "report": report,
        "cursor": state.cursor,
        "pending": state.pending.len(),
        "lastSyncAt": state.last_sync_at,
    }))
}

#[tauri::command]
fn get_status(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.settings.lock().map_err(|_| "状态锁不可用")?.clone();
    let has_token = !settings.device_id.is_empty() && read_token(&settings.device_id).is_ok();
    let mut state_value = Value::Null;
    if !settings.root.is_empty() {
        let path = Path::new(&settings.root).join(pagesai_disk_sync::STATE_DIR).join("state.json");
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                state_value = json!({
                    "deviceId": value.get("deviceId"),
                    "cursor": value.get("cursor"),
                    "pending": value.get("pending").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
                    "lastSyncAt": value.get("lastSyncAt"),
                });
            }
        }
    }
    let policy = strategy::selected();
    Ok(json!({
        "settings": {
            "serviceUrl": settings.service_url,
            "root": settings.root,
            "deviceId": settings.device_id,
            "deviceName": settings.device_name,
            "campusEndpoint": settings.campus_endpoint,
            "intervalMinutes": settings.interval_minutes,
            "autoStart": settings.auto_start,
            "syncOnLaunch": settings.sync_on_launch,
        },
        "paired": has_token && !settings.device_id.is_empty(),
        "syncing": state.syncing.load(Ordering::SeqCst),
        "strategy": { "name": policy.name(), "includesCampus": policy.includes_campus() },
        "syncState": state_value,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "paths": { "settings": config_path(&app).ok(), "state": if settings.root.is_empty() { None } else { Some(Path::new(&settings.root).join(pagesai_disk_sync::STATE_DIR).join("state.json")) } },
    }))
}

#[tauri::command]
async fn pair(app: AppHandle, state: State<'_, AppState>, request: PairRequest) -> Result<Value, String> {
    strategy::validate_transport(&request.service_url)?;
    let root = validate_root(&request.root)?;
    {
        let current = state.settings.lock().map_err(|_| "状态锁不可用")?;
        if !current.device_id.is_empty() {
            return Err("当前已有配对设备，请先解除配对再连接其他账号".into());
        }
    }
    let policy = strategy::selected();
    let campus = if request.campus_endpoint.trim().is_empty() { None } else { Some(request.campus_endpoint.trim().to_string()) };
    // 先验证策略，通用制品在这里拒绝校园端点。
    policy.endpoints(&request.service_url, campus.as_deref())?;
    if request.code.trim().is_empty() {
        return Err("请输入配对码".into());
    }
    let service = request.service_url.trim().trim_end_matches('/').to_string();
    let code = request.code.trim().to_string();
    let name = if request.device_name.trim().is_empty() {
        std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "PagesAI Disk 设备".into())
    } else {
        request.device_name.trim().to_string()
    };
    let pairing_name = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        pair_device(&service, &code, &pairing_name, std::env::consts::OS, None)
    })
    .await
    .map_err(|error| format!("配对任务失败：{error}"))??;
    let device_id = result
        .device
        .get("deviceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "配对响应缺少 deviceId".to_string())?
        .to_string();
    write_token(&device_id, &result.token)?;

    let mut settings = Settings {
        service_url: request.service_url.trim().trim_end_matches('/').to_string(),
        root: root.to_string_lossy().to_string(),
        device_id,
        device_name: name,
        campus_endpoint: request.campus_endpoint.trim().to_string(),
        ..Default::default()
    };
    settings.interval_minutes = 15;
    settings.sync_on_launch = true;
    save_settings(&app, &settings)?;
    *state.settings.lock().map_err(|_| "状态锁不可用")? = settings.clone();
    // 配对后立即做一次首轮对账，让用户马上看到真实文件而不是空壳界面。
    let token = read_token(&settings.device_id)?;
    let sync_settings = settings.clone();
    let report = tauri::async_runtime::spawn_blocking(move || run_sync(&sync_settings, &token))
        .await
        .map_err(|error| format!("首次同步任务失败：{error}"))??;
    Ok(json!({ "paired": true, "deviceId": settings.device_id, "firstSync": report }))
}

#[tauri::command]
fn save_preferences(app: AppHandle, state: State<'_, AppState>, input: SettingsInput) -> Result<Value, String> {
    let root = validate_root(&input.root)?;
    let mut settings = state.settings.lock().map_err(|_| "状态锁不可用")?.clone();
    if !settings.device_id.is_empty() && root.to_string_lossy() != settings.root {
        // 更换同步目录不会迁移或删除任何文件；新目录重新从远端对账。
        let old_state = Path::new(&settings.root).join(pagesai_disk_sync::STATE_DIR);
        if old_state.exists() {
            return Err("更换同步目录前请先解除配对，以免两个目录同时写入同一设备状态".into());
        }
    }
    settings.root = root.to_string_lossy().to_string();
    settings.campus_endpoint = input.campus_endpoint.trim().to_string();
    settings.interval_minutes = input.interval_minutes.min(1440);
    settings.sync_on_launch = input.sync_on_launch;
    save_settings(&app, &settings)?;
    *state.settings.lock().map_err(|_| "状态锁不可用")? = settings;
    Ok(json!({ "saved": true }))
}

#[tauri::command]
async fn sync_now(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.settings.lock().map_err(|_| "状态锁不可用")?.clone();
    if settings.device_id.is_empty() {
        return Err("尚未配对设备".into());
    }
    let syncing = state.syncing.clone();
    if syncing.swap(true, Ordering::SeqCst) {
        return Err("同步正在进行".into());
    }
    let token = match read_token(&settings.device_id) {
        Ok(token) => token,
        Err(error) => { syncing.store(false, Ordering::SeqCst); return Err(error); }
    };
    let task = tauri::async_runtime::spawn_blocking(move || run_sync(&settings, &token)).await;
    syncing.store(false, Ordering::SeqCst);
    task.map_err(|error| format!("同步任务失败：{error}"))?
}

#[tauri::command]
async fn unpair(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.settings.lock().map_err(|_| "状态锁不可用")?.clone();
    let mut revoked = false;
    if !settings.device_id.is_empty() {
        if let Ok(token) = read_token(&settings.device_id) {
            let service = settings.service_url.clone();
            let device = settings.device_id.clone();
            revoked = tauri::async_runtime::spawn_blocking(move || revoke_device(&service, &token, &device))
                .await
                .map(|result| result.is_ok())
                .unwrap_or(false);
        }
        delete_token(&settings.device_id);
    }
    let mut next = settings;
    next.device_id.clear();
    // 保留部署者地址和同步目录，方便重新配对；令牌已从系统凭据库删除。
    save_settings(&app, &next)?;
    *state.settings.lock().map_err(|_| "状态锁不可用")? = next;
    Ok(json!({ "unpaired": true, "revokedOnServer": revoked }))
}

#[tauri::command]
fn set_auto_start(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<Value, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| format!("启用开机自启动失败：{error}"))?;
    } else {
        manager.disable().map_err(|error| format!("关闭开机自启动失败：{error}"))?;
    }
    let mut settings = state.settings.lock().map_err(|_| "状态锁不可用")?.clone();
    settings.auto_start = enabled;
    save_settings(&app, &settings)?;
    *state.settings.lock().map_err(|_| "状态锁不可用")? = settings;
    Ok(json!({ "autoStart": enabled }))
}

fn start_background_sync(app: AppHandle) {
    std::thread::spawn(move || {
        // 给界面和首次对账留出时间。
        std::thread::sleep(Duration::from_secs(10));
        loop {
            let state = app.state::<AppState>();
            let settings = match state.settings.lock() {
                Ok(value) => value.clone(),
                Err(_) => { std::thread::sleep(Duration::from_secs(30)); continue; }
            };
            if settings.device_id.is_empty() || settings.interval_minutes == 0 {
                std::thread::sleep(Duration::from_secs(30));
                continue;
            }
            if !state.syncing.swap(true, Ordering::SeqCst) {
                if let Ok(token) = read_token(&settings.device_id) {
                    match run_sync(&settings, &token) {
                        Ok(result) => { let _ = app.emit("sync://report", result); }
                        Err(error) => { let _ = app.emit("sync://error", json!({ "message": error })); }
                    }
                }
                state.syncing.store(false, Ordering::SeqCst);
            }
            let interval = Duration::from_secs(u64::from(settings.interval_minutes.max(1)) * 60);
            std::thread::sleep(interval);
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_status,
            pair,
            save_preferences,
            sync_now,
            unpair,
            set_auto_start,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            {
                let state = handle.state::<AppState>();
                if let Ok(mut current) = state.settings.lock() {
                    *current = settings.clone();
                };
            }
            // 开机自启状态以系统为准，避免设置文件与系统不一致。
            if settings.auto_start {
                let manager = handle.autolaunch();
                let _ = manager.enable();
            }
            start_background_sync(handle.clone());
            if settings.sync_on_launch && !settings.device_id.is_empty() {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    let state = handle.state::<AppState>();
                    if state.syncing.swap(true, Ordering::SeqCst) { return; }
                    if let Ok(token) = read_token(&settings.device_id) {
                        match run_sync(&settings, &token) {
                            Ok(result) => { let _ = handle.emit("sync://report", result); }
                            Err(error) => { let _ = handle.emit("sync://error", json!({ "message": error })); }
                        }
                    }
                    state.syncing.store(false, Ordering::SeqCst);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("PagesAI Disk 客户端启动失败");
}
