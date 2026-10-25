use crate::model::StoredState;
use crate::path_rules::STATE_DIR;
use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct StateStore {
    state_dir: PathBuf,
    state_path: PathBuf,
    backup_path: PathBuf,
    lock_file: File,
    pub state: StoredState,
}

impl StateStore {
    pub fn open(root: &Path, device_id: &str) -> Result<Self, String> {
        let state_dir = root.join(STATE_DIR);
        fs::create_dir_all(&state_dir).map_err(|error| format!("无法创建状态目录：{error}"))?;
        let lock_path = state_dir.join("engine.lock");
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|error| format!("无法打开同步锁：{error}"))?;
        lock_file
            .try_lock_exclusive()
            .map_err(|_| "另一个同步进程正在使用该目录".to_string())?;
        let state_path = state_dir.join("state.json");
        let backup_path = state_dir.join("state.json.bak");
        let mut state = load_state(&state_path)
            .or_else(|| load_state(&backup_path))
            .unwrap_or_else(|| StoredState::new(device_id.to_string(), root.to_string_lossy().to_string()));
        // 切换账号/设备时不得沿用旧主体的游标与文件映射，否则会把旧账号的
        // 文件当成“远端已删除”。本地文件保留，重新做首次对账。
        if state.device_id != device_id {
            state = StoredState::new(device_id.to_string(), root.to_string_lossy().to_string());
        }
        let mut store = Self { state_dir, state_path, backup_path, lock_file, state };
        store.state.device_id = device_id.to_string();
        store.state.root = root.to_string_lossy().to_string();
        store.save()?;
        Ok(store)
    }

    pub fn save(&mut self) -> Result<(), String> {
        let temp = self.state_dir.join(format!("state.json.tmp-{}", std::process::id()));
        let payload = serde_json::to_vec_pretty(&self.state).map_err(|error| error.to_string())?;
        {
            let mut file = File::create(&temp).map_err(|error| format!("无法写入状态临时文件：{error}"))?;
            file.write_all(&payload).map_err(|error| error.to_string())?;
            file.write_all(b"\n").map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| format!("状态写入落盘失败：{error}"))?;
        }
        if self.state_path.exists() {
            let _ = fs::copy(&self.state_path, &self.backup_path);
        }
        if self.state_path.exists() {
            // Windows 的 rename 不覆盖现有文件；先把旧文件移到备份位置。
            let _ = fs::rename(&self.state_path, &self.backup_path);
        }
        fs::rename(&temp, &self.state_path).map_err(|error| {
            let _ = fs::rename(&self.backup_path, &self.state_path);
            format!("状态文件替换失败：{error}")
        })?;
        Ok(())
    }

    pub fn state(&self) -> &StoredState { &self.state }
    pub fn state_mut(&mut self) -> &mut StoredState { &mut self.state }

    pub fn remove_temp_files(&self) {
        if let Ok(entries) = fs::read_dir(&self.state_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("state.json.tmp-") || name.ends_with(".part") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

impl Drop for StateStore {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.lock_file);
    }
}

fn load_state(path: &Path) -> Option<StoredState> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips_and_keeps_backup() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = StateStore::open(temp.path(), "dev-test").unwrap();
        store.state_mut().cursor = 7;
        store.state_mut().files.insert("f".into(), crate::model::LocalFileState {
            path: "a.txt".into(), folder_id: None, name: "a.txt".into(),
            revision: 1, hash: "00".into(), size: 1, deleted: false,
        });
        store.save().unwrap();
        drop(store);
        let reopened = StateStore::open(temp.path(), "dev-test").unwrap();
        assert_eq!(reopened.state().cursor, 7);
        assert!(reopened.state().files.contains_key("f"));
    }

    #[test]
    fn switching_device_resets_cursor_and_mapping() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = StateStore::open(temp.path(), "dev-a").unwrap();
        store.state_mut().cursor = 12;
        store.state_mut().files.insert("f".into(), crate::model::LocalFileState {
            path: "a.txt".into(), folder_id: None, name: "a.txt".into(),
            revision: 4, hash: "aa".into(), size: 2, deleted: false,
        });
        store.save().unwrap();
        drop(store);
        let reopened = StateStore::open(temp.path(), "dev-b").unwrap();
        assert_eq!(reopened.state().device_id, "dev-b");
        assert_eq!(reopened.state().cursor, 0);
        assert!(reopened.state().files.is_empty());
        assert!(reopened.state().epoch.is_none());
    }

    #[test]
    fn corrupt_primary_falls_back_to_backup() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = StateStore::open(temp.path(), "dev-test").unwrap();
        store.state_mut().cursor = 3;
        store.save().unwrap();
        store.state_mut().cursor = 9;
        store.save().unwrap();
        drop(store);
        fs::write(temp.path().join(STATE_DIR).join("state.json"), b"{not json").unwrap();
        let reopened = StateStore::open(temp.path(), "dev-test").unwrap();
        assert_eq!(reopened.state().cursor, 3);
    }
}
