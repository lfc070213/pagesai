use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub fn now_stamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0);
    format_utc_stamp(millis)
}

pub fn format_utc_stamp(millis: i64) -> String {
    // 只用于冲突文件名，不追求完整历法库；按天/秒换算 UTC。
    let seconds = millis.div_euclid(1000);
    let days = seconds.div_euclid(86400);
    let rem = seconds.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}{month:02}{day:02}-{:02}{:02}{:02}", rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    // Howard Hinnant 的 civil_from_days 算法。
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录 {} 失败：{error}", parent.display()))?;
    }
    let temp = temp_path(path);
    {
        let mut file = File::create(&temp).map_err(|error| format!("创建临时文件失败：{error}"))?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&temp, path).map_err(|error| format!("替换 {} 失败：{error}", path.display()))
}

pub fn temp_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".{name}.pagesai-part-{}", std::process::id()))
}

pub fn guess_mime(name: &str) -> &'static str {
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "txt" | "md" | "csv" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_known_vector() {
        assert_eq!(sha256_bytes(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn utc_stamp_is_stable() {
        // 2026-10-24T00:00:00Z
        assert_eq!(format_utc_stamp(1_792_800_000_000), "20261024-000000");
    }

    #[test]
    fn guess_mime_basics() {
        assert_eq!(guess_mime("a.PDF"), "application/pdf");
        assert_eq!(guess_mime("a.unknown"), "application/octet-stream");
    }
}
