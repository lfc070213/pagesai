use std::path::{Component, Path, PathBuf};

pub const STATE_DIR: &str = ".pagesai";

#[derive(Debug, Clone, Copy)]
pub struct PathRules {
    pub windows: bool,
    pub case_insensitive: bool,
}

impl PathRules {
    pub fn current() -> Self {
        Self {
            windows: cfg!(windows),
            case_insensitive: cfg!(windows) || cfg!(target_os = "macos"),
        }
    }
    pub fn posix() -> Self { Self { windows: false, case_insensitive: true } }
    pub fn windows() -> Self { Self { windows: true, case_insensitive: true } }

    pub fn validate_component(&self, name: &str) -> Result<(), String> {
        if name.is_empty() || name == "." || name == ".." {
            return Err("名称为空或为相对路径段".into());
        }
        if name.contains('/') || name.contains('\\') || name.contains('\0') {
            return Err("名称包含路径分隔符或 NUL".into());
        }
        if name.chars().any(|ch| ch.is_control()) {
            return Err("名称包含控制字符".into());
        }
        if self.windows {
            const INVALID: &[char] = &['<', '>', ':', '"', '|', '?', '*'];
            if name.chars().any(|ch| INVALID.contains(&ch)) {
                return Err("Windows 名称包含非法字符".into());
            }
            if name.ends_with(' ') || name.ends_with('.') {
                return Err("Windows 名称不能以空格或点结尾".into());
            }
            let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
            let upper = stem.to_ascii_uppercase();
            let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (upper.len() == 4
                    && (upper.starts_with("COM") || upper.starts_with("LPT"))
                    && upper.as_bytes()[3].is_ascii_digit()
                    && upper.as_bytes()[3] != b'0');
            if reserved {
                return Err("Windows 保留设备名".into());
            }
            if name.encode_utf16().count() > 255 {
                return Err("单个路径段超过 255 个 UTF-16 单元".into());
            }
        } else if name.as_bytes().len() > 255 {
            return Err("单个路径段超过 255 字节".into());
        }
        Ok(())
    }

    /// 校验相对路径；拒绝绝对路径、`.`/`..`、空段和反斜杠。
    pub fn validate_relative(&self, relative: &str) -> Result<(), String> {
        if relative.is_empty() {
            return Err("相对路径为空".into());
        }
        if relative.contains('\\') || relative.starts_with('/') {
            return Err("相对路径必须使用 / 分隔且不得为绝对路径".into());
        }
        for segment in relative.split('/') {
            if segment.is_empty() {
                return Err("相对路径包含空段".into());
            }
            self.validate_component(segment)?;
        }
        Ok(())
    }

    pub fn join(&self, root: &Path, relative: &str) -> Result<PathBuf, String> {
        self.validate_relative(relative)?;
        let mut path = root.to_path_buf();
        for segment in relative.split('/') {
            path.push(segment);
        }
        if self.windows && path.to_string_lossy().encode_utf16().count() > 250 {
            let text = path.to_string_lossy();
            let extended = if text.starts_with("\\\\?\\") { text.to_string() } else { format!("\\\\?\\{}", text) };
            return Ok(PathBuf::from(extended));
        }
        Ok(path)
    }

    pub fn relative_key(&self, relative: &str) -> String {
        if self.case_insensitive {
            relative.to_lowercase()
        } else {
            relative.to_string()
        }
    }

    pub fn conflict_name(&self, name: &str, device_id: &str, stamp: &str) -> String {
        let device: String = device_id.chars().filter(|ch| ch.is_ascii_alphanumeric()).take(8).collect();
        let device = if device.is_empty() { "device".to_string() } else { device };
        let (stem, extension) = match name.rfind('.') {
            Some(index) if index > 0 => (&name[..index], &name[index..]),
            _ => (name, ""),
        };
        let mut candidate = format!("{stem} (conflict {device} {stamp}){extension}");
        if self.validate_component(&candidate).is_ok() {
            return candidate;
        }
        // Windows 不允许的字符替换后再试一次。
        let sanitized: String = candidate
            .chars()
            .map(|ch| if matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { ch })
            .collect();
        candidate = sanitized.trim_end_matches([' ', '.']).to_string();
        if candidate.is_empty() { "conflict".to_string() } else { candidate }
    }
}

/// 从任意用户输入构造安全的相对路径段；用于配对名称、冲突名等。
pub fn safe_component(value: &str, fallback: &str) -> String {
    let mut result: String = value
        .chars()
        .map(|ch| if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { ch })
        .collect();
    result = result.trim().trim_end_matches([' ', '.']).to_string();
    if result.is_empty() || result == "." || result == ".." {
        fallback.to_string()
    } else {
        result
    }
}

pub fn is_state_relative(relative: &Path) -> bool {
    matches!(relative.components().next(), Some(Component::Normal(name)) if name == STATE_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_windows_reserved_and_trailing() {
        let rules = PathRules::windows();
        for name in ["CON", "con.txt", "LPT1", "AUX.log", "name.", "name ", "a:b", "what?"] {
            assert!(rules.validate_component(name).is_err(), "{name} 应被拒绝");
        }
        for name in ["conifer.txt", "COM0", "normal name.txt", "中文.txt"] {
            assert!(rules.validate_component(name).is_ok(), "{name} 应被接受");
        }
    }

    #[test]
    fn rejects_traversal_and_absolute() {
        let rules = PathRules::posix();
        for relative in ["../x", "a/../b", "/etc/passwd", "a//b", "a\\b"] {
            assert!(rules.validate_relative(relative).is_err(), "{relative} 应被拒绝");
        }
        assert!(rules.validate_relative("a/b/c.txt").is_ok());
    }

    #[test]
    fn conflict_name_is_portable() {
        let rules = PathRules::windows();
        let name = rules.conflict_name("report.final.pdf", "dev-ABCDEF123", "20261024-120000");
        assert!(name.contains("conflict"));
        assert!(name.ends_with(".pdf"));
        assert!(rules.validate_component(&name).is_ok());
    }

    #[test]
    fn extended_path_prefix_for_long_windows_paths() {
        let rules = PathRules::windows();
        let segment = "a".repeat(120);
        let relative = format!("{segment}/{segment}/{segment}/file.txt");
        assert!(rules.validate_relative(&relative).is_ok());
        let path = rules.join(Path::new("C:\\"), &relative).unwrap();
        assert!(path.to_string_lossy().starts_with("\\\\?\\"));
        assert!(path.to_string_lossy().len() > 260);
    }
}
