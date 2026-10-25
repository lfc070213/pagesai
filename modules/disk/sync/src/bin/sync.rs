//! PagesAI Disk 同步命令行客户端。
//!
//! 这是 Tauri 桌面壳与自动化测试共用的协议入口：配对、查看状态、执行一次同步、撤销设备。
//! 凭据默认保存在用户配置目录（Unix 权限 0600），绝不写入同步目录或版本库。

use pagesai_disk_sync::strategy::{self, Strategy};
use pagesai_disk_sync::{pair_device, revoke_device, Engine, HttpRemote, PathRules, Remote, RemotePool};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    service_url: String,
    token: String,
    device_id: String,
    #[serde(default)]
    device_name: String,
    #[serde(default)]
    root: Option<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|item| item == "--help" || item == "-h") {
        usage();
        std::process::exit(if args.is_empty() { 2 } else { 0 });
    }
    let command = args[0].clone();
    let flags = match parse_flags(&args[1..]) {
        Ok(value) => value,
        Err(error) => fail(&error),
    };
    let result = match command.as_str() {
        "pair" => command_pair(&flags),
        "sync" => command_sync(&flags),
        "status" => command_status(&flags),
        "unpair" => command_unpair(&flags),
        other => Err(format!("未知命令：{other}")),
    };
    if let Err(error) = result {
        fail(&error);
    }
}

fn usage() {
    println!(
        "PagesAI Disk 同步客户端\n\n\
         用法：\n\
           pagesai-disk-sync pair   --service https://host --code CODE --name 设备名 [--root DIR] [--credentials FILE]\n\
           pagesai-disk-sync sync   [--root DIR] [--credentials FILE] [--token TOKEN] [--service URL]\n\
           pagesai-disk-sync status [--root DIR] [--credentials FILE]\n\
           pagesai-disk-sync unpair [--root DIR] [--credentials FILE]\n\n\
         说明：\n\
           - 服务地址必须是 HTTPS（回环地址除外）；\n\
           - 配对码由网盘网页端的“设备同步”生成，10 分钟内有效；\n\
           - 令牌只显示一次，保存在凭据文件中，可用环境变量 PAGESAI_DISK_TOKEN 覆盖；\n\
           - sync 失败时进程退出码为 1，报告以 JSON 输出到 stdout。"
    );
}

fn parse_flags(args: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut flags = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let item = &args[index];
        if !item.starts_with("--") {
            return Err(format!("无法识别的参数：{item}"));
        }
        let key = item.trim_start_matches("--").to_string();
        let value = args.get(index + 1).ok_or_else(|| format!("参数 {item} 缺少值"))?;
        flags.insert(key, value.clone());
        index += 2;
    }
    Ok(flags)
}

fn command_pair(flags: &BTreeMap<String, String>) -> Result<(), String> {
    let service = required(flags, "service")?;
    strategy::validate_transport(&service)?;
    let code = required(flags, "code")?;
    let name = flags.get("name").cloned().unwrap_or_else(default_device_name);
    let root = flags
        .get("root")
        .map(PathBuf::from)
        .or_else(default_root)
        .ok_or_else(|| "请用 --root 指定同步目录".to_string())?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建同步目录：{error}"))?;
    let policy = strategy::selected();
    let endpoints = policy.endpoints(&service, flags.get("campus-endpoint").map(String::as_str))?;
    let result = pair_device(&service, &code, &name, std::env::consts::OS, None)?;
    let device_id = result
        .device
        .get("deviceId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "配对响应缺少 deviceId".to_string())?
        .to_string();
    let credentials = Credentials {
        service_url: service,
        token: result.token,
        device_id: device_id.clone(),
        device_name: name,
        root: Some(root.to_string_lossy().to_string()),
    };
    let path = credentials_path(flags);
    save_credentials(&path, &credentials)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "paired": true,
            "deviceId": device_id,
            "credentials": path.to_string_lossy(),
            "root": credentials.root,
            "strategy": policy.name(),
            "endpoints": endpoints.iter().map(|endpoint| serde_json::json!({
                "url": endpoint.url,
                "kind": endpoint.kind.to_string(),
            })).collect::<Vec<_>>(),
        }))
        .unwrap_or_default()
    );
    Ok(())
}

fn command_sync(flags: &BTreeMap<String, String>) -> Result<(), String> {
    let mut credentials = load_credentials(flags)?;
    if let Some(token) = flags.get("token").cloned().or_else(|| std::env::var("PAGESAI_DISK_TOKEN").ok()) {
        credentials.token = token;
    }
    if let Some(service) = flags.get("service") {
        credentials.service_url = service.clone();
    }
    let root = resolve_root(flags, &credentials)?;
    let device_id = credentials.device_id.clone();
    let policy = strategy::selected();
    let endpoints = policy.endpoints(
        &credentials.service_url,
        flags.get("campus-endpoint").map(String::as_str),
    )?;
    let mut remotes: Vec<Box<dyn Remote>> = Vec::new();
    for endpoint in &endpoints {
        remotes.push(Box::new(HttpRemote::new(&endpoint.url, credentials.token.clone())?));
    }
    let remote = RemotePool::new(remotes)?;
    let rules = if flags.contains_key("windows-rules") { PathRules::windows() } else { PathRules::current() };
    let mut engine = Engine::with_rules(&root, &device_id, remote, rules)?;
    let report = engine.sync()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "strategy": policy.name(),
            "endpoints": endpoints.iter().map(|endpoint| endpoint.kind.to_string()).collect::<Vec<_>>(),
            "report": report,
        }))
        .map_err(|error| error.to_string())?
    );
    if report.errors.is_empty() {
        Ok(())
    } else {
        Err(format!("同步完成但有 {} 个错误，详见报告", report.errors.len()))
    }
}

fn command_status(flags: &BTreeMap<String, String>) -> Result<(), String> {
    let credentials = load_credentials(flags)?;
    let root = resolve_root(flags, &credentials)?;
    let state_path = root.join(pagesai_disk_sync::STATE_DIR).join("state.json");
    let bytes = fs::read(&state_path).map_err(|error| format!("尚未同步或状态不可读：{error}"))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| format!("状态文件损坏：{error}"))?;
    let summary = serde_json::json!({
        "root": root.to_string_lossy(),
        "deviceId": credentials.device_id,
        "state": value,
    });
    println!("{}", serde_json::to_string_pretty(&summary).map_err(|error| error.to_string())?);
    Ok(())
}

fn command_unpair(flags: &BTreeMap<String, String>) -> Result<(), String> {
    let credentials = load_credentials(flags)?;
    let root = resolve_root(flags, &credentials)?;
    let token = flags
        .get("token")
        .cloned()
        .or_else(|| std::env::var("PAGESAI_DISK_TOKEN").ok())
        .unwrap_or_else(|| credentials.token.clone());
    let mut revoked = false;
    if !token.is_empty() {
        match revoke_device(&credentials.service_url, &token, &credentials.device_id) {
            Ok(()) => revoked = true,
            Err(error) => eprintln!("服务端撤销失败（继续清理本地状态）：{error}"),
        }
    }
    let state_dir = root.join(pagesai_disk_sync::STATE_DIR);
    if state_dir.exists() {
        fs::remove_dir_all(&state_dir).map_err(|error| format!("清理本地同步状态失败：{error}"))?;
    }
    let path = credentials_path(flags);
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("删除凭据失败：{error}"))?;
    }
    println!("{}", serde_json::json!({ "unpaired": true, "revoked": revoked }).to_string());
    Ok(())
}

fn required(flags: &BTreeMap<String, String>, key: &str) -> Result<String, String> {
    flags.get(key).cloned().filter(|value| !value.trim().is_empty()).ok_or_else(|| format!("缺少 --{key}"))
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| format!("{} 设备", std::env::consts::OS))
}

fn default_root() -> Option<PathBuf> {
    let home = home_dir()?;
    Some(home.join("PagesAI Disk"))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn credentials_path(flags: &BTreeMap<String, String>) -> PathBuf {
    if let Some(value) = flags.get("credentials") {
        return PathBuf::from(value);
    }
    if let Some(value) = std::env::var_os("PAGESAI_DISK_CREDENTIALS") {
        return PathBuf::from(value);
    }
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pagesai-disk")
        .join("credentials.json")
}

fn load_credentials(flags: &BTreeMap<String, String>) -> Result<Credentials, String> {
    let path = credentials_path(flags);
    let bytes = fs::read(&path)
        .map_err(|error| format!("读取凭据失败（{}），请先执行 pair：{error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("凭据格式非法：{error}"))
}

fn save_credentials(path: &Path, credentials: &Credentials) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(credentials).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建凭据目录：{error}"))?;
    }
    pagesai_disk_sync::util::write_atomic(path, &bytes)?;
    restrict_permissions(path)?;
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法收紧凭据权限：{error}"))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn resolve_root(flags: &BTreeMap<String, String>, credentials: &Credentials) -> Result<PathBuf, String> {
    if let Some(value) = flags.get("root") {
        return Ok(PathBuf::from(value));
    }
    credentials
        .root
        .as_ref()
        .map(PathBuf::from)
        .or_else(default_root)
        .ok_or_else(|| "请用 --root 指定同步目录".to_string())
}

fn fail(message: &str) -> ! {
    eprintln!("错误：{message}");
    std::process::exit(1);
}
