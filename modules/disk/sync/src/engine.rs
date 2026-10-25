use crate::model::{
    Change, LocalFileState, LocalFolderState, PendingOp, RemoteFile, RemoteFolder, Snapshot,
    StoredState, SyncReport,
};
use crate::path_rules::{is_state_relative, PathRules, STATE_DIR};
use crate::remote::{Remote, UploadRequest};
use crate::state::StateStore;
use crate::util::{guess_mime, now_stamp, sha256_file, temp_path};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
struct Scanned {
    relative: String,
    is_dir: bool,
    hash: Option<String>,
}

#[derive(Debug, Default)]
struct Scan {
    entries: BTreeMap<String, Scanned>,
    complete: bool,
    warnings: Vec<String>,
}

pub struct Engine<R: Remote> {
    root: PathBuf,
    rules: PathRules,
    remote: R,
    store: StateStore,
    stamp: String,
}

impl<R: Remote> Engine<R> {
    pub fn new(root: impl Into<PathBuf>, device_id: &str, remote: R) -> Result<Self, String> {
        Self::with_rules(root, device_id, remote, PathRules::current())
    }

    pub fn with_rules(root: impl Into<PathBuf>, device_id: &str, remote: R, rules: PathRules) -> Result<Self, String> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|error| format!("无法创建同步根目录：{error}"))?;
        let store = StateStore::open(&root, device_id)?;
        let engine = Self { root, rules, remote, store, stamp: now_stamp() };
        engine.store.remove_temp_files();
        Ok(engine)
    }

    pub fn status(&self) -> &StoredState { self.store.state() }
    pub fn remote_mut(&mut self) -> &mut R { &mut self.remote }

    pub fn sync(&mut self) -> Result<SyncReport, String> {
        self.stamp = now_stamp();
        let mut report = SyncReport::default();
        self.flush_pending(&mut report);
        let remote_state = match self.remote.state() {
            Ok(value) => value,
            Err(error) => {
                report.errors.push(error.to_string());
                return Ok(report);
            }
        };
        let epoch_changed = self.store.state().epoch.as_deref() != Some(remote_state.epoch.as_str());
        let cursor_expired = self.store.state().cursor < remote_state.pruned_through;
        let first_sync = self.store.state().epoch.is_none();
        if epoch_changed || cursor_expired || first_sync {
            if epoch_changed || first_sync {
                report.warnings.push("同步纪元变化，执行全量对账".into());
            } else {
                report.warnings.push("同步游标已失效，执行全量对账".into());
            }
            if let Err(error) = self.full_reconcile(&remote_state, &mut report) {
                report.errors.push(error);
                self.save();
                return Ok(report);
            }
        } else if let Err(error) = self.apply_incremental(&mut report) {
            report.errors.push(error);
            self.save();
            return Ok(report);
        }

        let scan = match self.scan_local() {
            Ok(scan) => scan,
            Err(error) => {
                report.errors.push(format!("本地扫描失败，本轮不传播删除：{error}"));
                self.save();
                return Ok(report);
            }
        };
        report.warnings.extend(scan.warnings.clone());
        if !scan.complete {
            report.warnings.push("本地扫描不完整，跳过删除传播".into());
        }
        self.push_local_folders(&scan, &mut report);
        self.push_local_files(&scan, &mut report);
        if scan.complete {
            self.propagate_local_deletions(&scan, &mut report);
        }
        report.cursor = self.store.state().cursor;
        self.store.state_mut().last_sync_at = Some(iso_now());
        self.save();
        Ok(report)
    }

    fn save(&mut self) {
        let _ = self.store.save();
    }

    fn remote_rel(&self, folder_path: &str, name: &str) -> Result<String, String> {
        let relative = if folder_path.is_empty() { name.to_string() } else { format!("{folder_path}/{name}") };
        self.rules.validate_relative(&relative)?;
        Ok(relative)
    }

    fn local(&self, relative: &str) -> Result<PathBuf, String> {
        self.rules.join(&self.root, relative)
    }

    fn track_file(&mut self, file: &RemoteFile, relative: &str) {
        self.store.state_mut().files.insert(file.file_id.clone(), LocalFileState {
            path: relative.to_string(),
            folder_id: file.folder_id.clone(),
            name: file.name.clone(),
            revision: file.revision,
            hash: file.content_hash.clone(),
            size: file.size,
            deleted: file.status != "active",
        });
    }

    fn track_folder(&mut self, folder: &RemoteFolder, relative: &str) {
        self.store.state_mut().folders.insert(folder.folder_id.clone(), LocalFolderState {
            path: relative.to_string(),
            parent_id: folder.parent_id.clone(),
            name: folder.name.clone(),
            revision: folder.revision,
            deleted: folder.status != "active",
        });
    }

    fn folder_paths(&self, folders: &[RemoteFolder]) -> BTreeMap<String, String> {
        let mut paths: BTreeMap<String, String> = BTreeMap::new();
        let by_id: BTreeMap<&str, &RemoteFolder> = folders.iter().map(|folder| (folder.folder_id.as_str(), folder)).collect();
        for folder in folders {
            if folder.status != "active" { continue; }
            let mut chain = Vec::new();
            let mut current = Some(folder);
            let mut guard = 0;
            while let Some(item) = current {
                guard += 1;
                if guard > 256 { break; }
                chain.push(item);
                current = item.parent_id.as_deref().and_then(|id| by_id.get(id).copied());
            }
            let mut segments = Vec::new();
            let mut valid = true;
            for item in chain.iter().rev() {
                if item.status != "active" || self.rules.validate_component(&item.name).is_err() {
                    valid = false;
                    break;
                }
                segments.push(item.name.clone());
            }
            if valid { paths.insert(folder.folder_id.clone(), segments.join("/")); }
        }
        paths
    }

    fn full_reconcile(&mut self, remote_state: &crate::model::RemoteSyncState, report: &mut SyncReport) -> Result<(), String> {
        let snapshot = match self.remote.tree() {
            Ok(value) => value,
            Err(error) => return Err(error.to_string()),
        };
        self.apply_snapshot(&snapshot, report)?;
        self.store.state_mut().epoch = Some(remote_state.epoch.clone());
        self.store.state_mut().cursor = snapshot.cursor.max(remote_state.seq);
        Ok(())
    }

    fn apply_snapshot(&mut self, snapshot: &Snapshot, report: &mut SyncReport) -> Result<(), String> {
        let folder_paths = self.folder_paths(&snapshot.folders);
        let mut folders = snapshot.folders.clone();
        folders.sort_by_key(|folder| folder_paths.get(&folder.folder_id).map(|path| path.matches('/').count()).unwrap_or(0));
        for folder in &folders {
            if folder.status != "active" { continue; }
            let Some(path) = folder_paths.get(&folder.folder_id) else {
                report.warnings.push(format!("远端文件夹 {} 的路径无法解析，已跳过", folder.name));
                continue;
            };
            if let Err(error) = self.ensure_directory(path) {
                report.warnings.push(error);
                continue;
            }
            self.track_folder(folder, path);
        }
        for file in &snapshot.files {
            if file.status != "active" { continue; }
            let folder_path = file.folder_id.as_ref().and_then(|id| folder_paths.get(id).cloned()).unwrap_or_default();
            if let Err(error) = self.merge_remote_file(file, &folder_path, report) {
                report.errors.push(error);
            }
        }
        // 远端已不存在的本地跟踪项：只在本地未修改时删除。
        let remote_ids: BTreeSet<&str> = snapshot.files.iter().map(|file| file.file_id.as_str()).collect();
        let missing: Vec<(String, LocalFileState)> = self
            .store
            .state()
            .files
            .iter()
            .filter(|(id, state)| !state.deleted && !remote_ids.contains(id.as_str()))
            .map(|(id, state)| (id.clone(), state.clone()))
            .collect();
        for (id, state) in missing {
            let local = match self.local(&state.path) {
                Ok(value) => value,
                Err(error) => { report.warnings.push(error); continue; }
            };
            if !local.exists() {
                self.mark_file_deleted(&id);
                continue;
            }
            let hash = match sha256_file(&local) {
                Ok(value) => value,
                Err(error) => { report.warnings.push(error); continue; }
            };
            if hash == state.hash {
                let _ = fs::remove_file(&local);
                self.mark_file_deleted(&id);
                report.local_deleted += 1;
            } else {
                report.warnings.push(format!("远端已删除但本地已修改：{}，保留为冲突副本", state.path));
                if let Err(error) = self.make_conflict_copy(&state.path, report) {
                    report.warnings.push(error);
                }
                self.mark_file_deleted(&id);
                report.conflicts += 1;
            }
        }
        Ok(())
    }

    fn apply_incremental(&mut self, report: &mut SyncReport) -> Result<(), String> {
        let mut cursor = self.store.state().cursor;
        let mut iterations = 0;
        loop {
            iterations += 1;
            if iterations > 1000 { return Err("变更分页超过 1000 轮，已停止".into()); }
            let changes = match self.remote.changes(cursor) {
                Ok(value) => value,
                Err(error) if error.cursor_expired() => {
                    let state = self.remote.state().map_err(|inner| inner.to_string())?;
                    self.full_reconcile(&state, report)?;
                    return Ok(());
                }
                Err(error) => return Err(error.to_string()),
            };
            if self.store.state().epoch.as_deref() != Some(changes.epoch.as_str()) {
                let state = self.remote.state().map_err(|inner| inner.to_string())?;
                self.full_reconcile(&state, report)?;
                return Ok(());
            }
            if changes.changes.is_empty() {
                cursor = changes.cursor.max(cursor);
                break;
            }
            for change in &changes.changes {
                if let Err(error) = self.apply_change(change, report) {
                    report.errors.push(error);
                }
                cursor = change.cursor();
                self.store.state_mut().cursor = cursor;
                self.save();
            }
            if !changes.has_more {
                cursor = changes.cursor.max(cursor);
                break;
            }
        }
        self.store.state_mut().cursor = cursor;
        Ok(())
    }

    fn apply_change(&mut self, change: &Change, report: &mut SyncReport) -> Result<(), String> {
        match change {
            Change::Folder { action, folder, .. } => {
                if action == "delete" || folder.status != "active" {
                    if let Some(state) = self.store.state().folders.get(&folder.folder_id).cloned() {
                        let local = self.local(&state.path)?;
                        if local.is_dir() {
                            match fs::read_dir(&local) {
                                Ok(mut entries) => {
                                    if entries.next().is_none() {
                                        let _ = fs::remove_dir(&local);
                                    } else {
                                        report.warnings.push(format!("远端文件夹已删除，但本地非空，保留：{}", state.path));
                                    }
                                }
                                Err(error) => report.warnings.push(format!("无法检查本地文件夹 {}：{error}", state.path)),
                            }
                        }
                    }
                    if let Some(state) = self.store.state_mut().folders.get_mut(&folder.folder_id) {
                        state.deleted = true;
                    }
                    return Ok(());
                }
                let parent_path = folder
                    .parent_id
                    .as_ref()
                    .and_then(|id| self.store.state().folders.get(id).map(|state| state.path.clone()))
                    .unwrap_or_default();
                let relative = self.remote_rel(&parent_path, &folder.name)?;
                if let Some(state) = self.store.state().folders.get(&folder.folder_id) {
                    let local = self.local(&state.path)?;
                    // 本地删除尚未传播时，旧的 upsert 事件不能把文件夹复活。
                    if !local.is_dir() && folder.revision <= state.revision {
                        return Ok(());
                    }
                }
                self.ensure_directory(&relative)?;
                self.track_folder(folder, &relative);
            }
            Change::File { action, file, .. } => {
                if action == "delete" || file.status != "active" {
                    self.apply_remote_file_delete(file, report)?;
                    return Ok(());
                }
                let folder_path = file
                    .folder_id
                    .as_ref()
                    .and_then(|id| self.store.state().folders.get(id).map(|state| state.path.clone()))
                    .unwrap_or_default();
                self.merge_remote_file(file, &folder_path, report)?;
            }
        }
        Ok(())
    }

    fn apply_remote_file_delete(&mut self, file: &RemoteFile, report: &mut SyncReport) -> Result<(), String> {
        let Some(state) = self.store.state().files.get(&file.file_id).cloned() else {
            return Ok(());
        };
        let local = self.local(&state.path)?;
        if local.exists() {
            let hash = sha256_file(&local)?;
            if hash == state.hash {
                fs::remove_file(&local).map_err(|error| format!("删除本地文件 {} 失败：{error}", state.path))?;
                report.local_deleted += 1;
            } else {
                report.warnings.push(format!("远端删除与本地修改冲突：{}，保留为本地副本", state.path));
                self.make_conflict_copy(&state.path, report)?;
                report.conflicts += 1;
            }
        }
        self.mark_file_deleted(&file.file_id);
        Ok(())
    }

    fn merge_remote_file(&mut self, file: &RemoteFile, folder_path: &str, report: &mut SyncReport) -> Result<(), String> {
        let relative = self.remote_rel(folder_path, &file.name)?;
        let local = self.local(&relative)?;
        let state = self.store.state().files.get(&file.file_id).cloned();
        if let Some(state) = state {
            if state.deleted {
                return self.download_file(file, &relative, report);
            }
            let old_local = self.local(&state.path)?;
            let old_exists = old_local.is_file();
            let local_exists = local.is_file();
            if state.path != relative {
                let old_hash = if old_exists { Some(sha256_file(&old_local)?) } else { None };
                if old_hash.as_deref() == Some(state.hash.as_str()) {
                    if local_exists {
                        let local_hash = sha256_file(&local)?;
                        if local_hash != file.content_hash {
                            report.warnings.push(format!("远端移动与本地新文件冲突：{}", relative));
                            self.make_conflict_copy(&relative, report)?;
                            report.conflicts += 1;
                        }
                    }
                    if let Some(parent) = local.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
                    if let Err(error) = fs::rename(&old_local, &local) {
                        if old_hash.as_deref() != Some(file.content_hash.as_str()) {
                            report.warnings.push(format!("本地移动失败（{error}），改为下载：{}", relative));
                            return self.download_file(file, &relative, report);
                        }
                    }
                    if old_hash.as_deref() == Some(file.content_hash.as_str()) {
                        self.track_file(file, &relative);
                        return Ok(());
                    }
                    return self.download_file(file, &relative, report);
                }
                if local_exists {
                    let local_hash = sha256_file(&local)?;
                    if local_hash == file.content_hash {
                        if old_exists { let _ = fs::remove_file(&old_local); }
                        self.track_file(file, &relative);
                        return Ok(());
                    }
                }
                if old_exists {
                    report.warnings.push(format!("远端移动而本地已修改：{}", state.path));
                    self.make_conflict_copy(&state.path, report)?;
                    report.conflicts += 1;
                }
                return self.download_file(file, &relative, report);
            }

            if !local_exists {
                if file.revision == state.revision && file.content_hash == state.hash {
                    // 本地删除先于远端变更：尝试把删除传播出去。
                    match self.remote.delete_file(&file.file_id, state.revision) {
                        Ok(()) => {
                            self.mark_file_deleted(&file.file_id);
                            report.remote_deleted += 1;
                            return Ok(());
                        }
                        Err(error) if error.conflict() || error.status == 404 => {
                            return self.download_file(file, &relative, report);
                        }
                        Err(error) => return Err(error.to_string()),
                    }
                }
                return self.download_file(file, &relative, report);
            }

            let local_hash = sha256_file(&local)?;
            if local_hash == file.content_hash {
                self.track_file(file, &relative);
                return Ok(());
            }
            if local_hash == state.hash {
                return self.download_file(file, &relative, report);
            }
            if state.hash == file.content_hash {
                return self.upload_file(&relative, Some((file.file_id.clone(), state.revision)), report);
            }
            report.warnings.push(format!("两端同时修改：{}", relative));
            self.make_conflict_copy(&relative, report)?;
            report.conflicts += 1;
            return self.download_file(file, &relative, report);
        }

        if local.is_file() {
            let local_hash = sha256_file(&local)?;
            if local_hash == file.content_hash {
                self.track_file(file, &relative);
                return Ok(());
            }
            report.warnings.push(format!("首次对账发现同名不同内容：{}", relative));
            self.make_conflict_copy(&relative, report)?;
            report.conflicts += 1;
        }
        self.download_file(file, &relative, report)
    }

    fn download_file(&mut self, file: &RemoteFile, relative: &str, report: &mut SyncReport) -> Result<(), String> {
        let local = self.local(relative)?;
        if let Some(parent) = local.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        let temp = temp_path(&local);
        if let Err(error) = self.remote.download_to(file, &temp) {
            let _ = fs::remove_file(&temp);
            return Err(format!("下载失败 {relative}：{error}"));
        }
        let hash = sha256_file(&temp)?;
        let size = fs::metadata(&temp).map(|meta| meta.len()).unwrap_or(0);
        if hash != file.content_hash || size != file.size {
            let _ = fs::remove_file(&temp);
            return Err(format!("下载校验失败：{}（期望 {} / 实际 {}）", relative, file.content_hash, hash));
        }
        if local.exists() {
            let _ = fs::remove_file(&local);
        }
        fs::rename(&temp, &local).map_err(|error| format!("替换本地文件失败：{error}"))?;
        self.track_file(file, relative);
        report.downloaded += 1;
        Ok(())
    }

    fn ensure_directory(&self, relative: &str) -> Result<(), String> {
        if relative.is_empty() { return Ok(()); }
        let path = self.local(relative)?;
        if path.is_dir() { return Ok(()); }
        if path.exists() {
            let conflict = path.with_file_name(format!(
                "{}.pagesai-dir-conflict",
                path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "item".into())
            ));
            fs::rename(&path, &conflict).map_err(|error| format!("路径 {} 被文件占用且无法避让：{error}", relative))?;
        }
        fs::create_dir_all(&path).map_err(|error| format!("创建目录 {} 失败：{error}", relative))
    }

    fn make_conflict_copy(&self, relative: &str, report: &mut SyncReport) -> Result<(), String> {
        let local = self.local(relative)?;
        if !local.exists() { return Ok(()); }
        let name = local.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        let base_conflict = self.rules.conflict_name(&name, &self.store.state().device_id, &self.stamp);
        let parent = local.parent().map(Path::to_path_buf).unwrap_or_else(|| self.root.clone());
        let mut candidate = parent.join(&base_conflict);
        let mut suffix = 2;
        while candidate.exists() {
            candidate = parent.join(format!("{base_conflict}-{suffix}"));
            suffix += 1;
        }
        fs::rename(&local, &candidate).map_err(|error| format!("创建冲突副本失败：{error}"))?;
        report.warnings.push(format!(
            "冲突副本：{}",
            candidate.strip_prefix(&self.root).unwrap_or(&candidate).to_string_lossy()
        ));
        Ok(())
    }

    fn scan_local(&self) -> Result<Scan, String> {
        let metadata = fs::metadata(&self.root).map_err(|error| format!("同步根不可读：{error}"))?;
        if !metadata.is_dir() { return Err("同步根不是目录".into()); }
        let mut scan = Scan { complete: true, ..Default::default() };
        let mut seen: BTreeMap<String, String> = BTreeMap::new();
        self.scan_dir(&self.root, "", &mut scan, &mut seen)?;
        Ok(scan)
    }

    fn scan_dir(&self, dir: &Path, prefix: &str, scan: &mut Scan, seen: &mut BTreeMap<String, String>) -> Result<(), String> {
        let entries = match fs::read_dir(dir) {
            Ok(value) => value,
            Err(error) => {
                scan.complete = false;
                scan.warnings.push(format!("目录不可读，跳过删除：{}（{error}）", dir.display()));
                return Ok(());
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(value) => value,
                Err(error) => {
                    scan.complete = false;
                    scan.warnings.push(format!("目录项不可读：{error}"));
                    continue;
                }
            };
            let relative_fs = if prefix.is_empty() {
                PathBuf::from(entry.file_name())
            } else {
                Path::new(prefix).join(entry.file_name())
            };
            if is_state_relative(&relative_fs) { continue; }
            let relative = relative_fs.to_string_lossy().replace('\\', "/");
            let file_type = match entry.file_type() {
                Ok(value) => value,
                Err(error) => {
                    scan.complete = false;
                    scan.warnings.push(format!("无法读取文件类型 {}：{error}", relative));
                    continue;
                }
            };
            if file_type.is_symlink() {
                scan.warnings.push(format!("跳过符号链接：{relative}"));
                continue;
            }
            let key = self.rules.relative_key(&relative);
            if let Some(previous) = seen.insert(key.clone(), relative.clone()) {
                if previous != relative {
                    scan.complete = false;
                    scan.warnings.push(format!("大小写/Unicode 冲突：{previous} 与 {relative}，本轮跳过删除"));
                    continue;
                }
            }
            if file_type.is_dir() {
                scan.entries.insert(relative.clone(), Scanned { relative: relative.clone(), is_dir: true, hash: None });
                self.scan_dir(&entry.path(), &relative, scan, seen)?;
            } else if file_type.is_file() {
                let hash = match sha256_file(&entry.path()) {
                    Ok(value) => value,
                    Err(error) => {
                        scan.complete = false;
                        scan.warnings.push(format!("无法哈希 {}：{error}", relative));
                        continue;
                    }
                };
                scan.entries.insert(relative.clone(), Scanned { relative, is_dir: false, hash: Some(hash) });
            } else {
                scan.warnings.push(format!("跳过特殊文件：{relative}"));
            }
        }
        Ok(())
    }

    fn push_local_folders(&mut self, scan: &Scan, report: &mut SyncReport) {
        let mut local_dirs: Vec<&Scanned> = scan.entries.values().filter(|entry| entry.is_dir).collect();
        local_dirs.sort_by_key(|entry| entry.relative.matches('/').count());
        for entry in local_dirs {
            if let Some((_, state)) = self.find_folder_by_path(&entry.relative) {
                if !state.deleted { continue; }
            }
            let (parent_relative, name) = split_relative(&entry.relative);
            let parent_id = if parent_relative.is_empty() {
                None
            } else {
                self.find_folder_by_path(parent_relative).map(|(id, _)| id)
            };
            if !parent_relative.is_empty() && parent_id.is_none() {
                report.warnings.push(format!("父文件夹尚未同步，跳过：{}", entry.relative));
                continue;
            }
            let operation_id = self.store.state_mut().next_operation_id();
            let pending = PendingOp::FolderCreate { operation_id: operation_id.clone(), relative_path: entry.relative.clone() };
            self.push_pending(&pending);
            match self.remote.create_folder(name, parent_id.as_deref(), &operation_id) {
                Ok(folder) => {
                    self.track_folder(&folder, &entry.relative);
                    self.clear_pending(&pending);
                    self.save();
                    report.uploaded += 1;
                }
                Err(error) if error.conflict() => {
                    report.warnings.push(format!("创建文件夹冲突：{}（{}）", entry.relative, error.message));
                    self.clear_pending(&pending);
                }
                Err(error) => {
                    report.errors.push(format!("创建文件夹失败 {}：{}", entry.relative, error));
                    return;
                }
            }
        }
    }

    fn push_local_files(&mut self, scan: &Scan, report: &mut SyncReport) {
        let files: Vec<&Scanned> = scan.entries.values().filter(|entry| !entry.is_dir).collect();
        let mut missing: Vec<(String, LocalFileState)> = Vec::new();
        for (id, state) in self.store.state().files.iter() {
            if state.deleted { continue; }
            if !scan.entries.contains_key(&state.path) { missing.push((id.clone(), state.clone())); }
        }
        // 先处理“移动/改名”：旧路径消失且新路径内容哈希相同。
        let mut claimed = BTreeSet::new();
        for (id, state) in &missing {
            let Some(candidate) = files.iter().find(|entry| {
                !claimed.contains(&entry.relative)
                    && entry.hash.as_deref() == Some(state.hash.as_str())
                    && self.store.state().files.values().all(|other| other.path != entry.relative)
            }) else { continue; };
            let folder_path = candidate.relative.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("");
            let parent_id = if folder_path.is_empty() {
                None
            } else {
                self.find_folder_by_path(folder_path).map(|(folder_id, _)| folder_id)
            };
            if !folder_path.is_empty() && parent_id.is_none() { continue; }
            let name = candidate.relative.rsplit('/').next().unwrap_or(&candidate.relative);
            match self.remote.patch_file(id, Some(name), Some(parent_id.as_deref()), state.revision) {
                Ok(file) => {
                    self.track_file(&file, &candidate.relative);
                    claimed.insert(candidate.relative.clone());
                    report.uploaded += 1;
                    self.save();
                }
                Err(error) if error.conflict() => {
                    report.warnings.push(format!("本地移动与远端冲突：{}（{}）", candidate.relative, error.message));
                }
                Err(error) => report.errors.push(format!("同步本地移动失败 {}：{}", candidate.relative, error)),
            }
        }

        for entry in files {
            if claimed.contains(&entry.relative) { continue; }
            let existing = self.store.state().files.values().find(|state| !state.deleted && state.path == entry.relative).cloned();
            if existing.as_ref().map(|state| state.hash.as_str()) == entry.hash.as_deref() { continue; }
            let base = existing.and_then(|state| {
                state_clone_id(&self.store.state().files, &entry.relative).map(|id| (id, state.revision))
            });
            if let Err(error) = self.upload_file(&entry.relative, base, report) {
                report.errors.push(error);
            }
        }
    }

    fn upload_file(&mut self, relative: &str, base: Option<(String, u64)>, report: &mut SyncReport) -> Result<(), String> {
        let local = self.local(relative)?;
        if !local.is_file() { return Ok(()); }
        let size = fs::metadata(&local).map_err(|error| error.to_string())?.len();
        let hash = sha256_file(&local)?;
        let (folder_path, name) = split_relative(relative);
        let folder_id = if folder_path.is_empty() {
            None
        } else {
            self.find_folder_by_path(folder_path).map(|(id, _)| id)
        };
        if !folder_path.is_empty() && folder_id.is_none() {
            report.warnings.push(format!("父文件夹尚未同步，跳过文件：{relative}"));
            return Ok(());
        }
        let operation_id = self.store.state_mut().next_operation_id();
        let pending = PendingOp::Upload {
            operation_id: operation_id.clone(),
            file_id: base.as_ref().map(|(id, _)| id.clone()),
            base_revision: base.as_ref().map(|(_, revision)| *revision),
            relative_path: relative.to_string(),
        };
        self.push_pending(&pending);
        let mime = guess_mime(name).to_string();
        let request = UploadRequest {
            local_path: &local,
            name,
            folder_id: folder_id.as_deref(),
            file_id: base.as_ref().map(|(id, _)| id.as_str()),
            base_revision: base.as_ref().map(|(_, revision)| *revision),
            operation_id: &operation_id,
            mime_type: &mime,
            size,
            sha256: &hash,
        };
        match self.remote.upload(request) {
            Ok(file) => {
                self.track_file(&file, relative);
                self.clear_pending(&pending);
                self.save();
                report.uploaded += 1;
                Ok(())
            }
            Err(error) if error.conflict() => {
                self.clear_pending(&pending);
                report.warnings.push(format!("上传冲突：{relative}（{}），保留为冲突副本", error.message));
                self.make_conflict_copy(relative, report)?;
                report.conflicts += 1;
                Ok(())
            }
            Err(error) => {
                report.errors.push(format!("上传失败 {relative}：{error}"));
                Ok(())
            }
        }
    }

    fn propagate_local_deletions(&mut self, scan: &Scan, report: &mut SyncReport) {
        let missing: Vec<(String, LocalFileState)> = self
            .store
            .state()
            .files
            .iter()
            .filter(|(_, state)| !state.deleted && !scan.entries.contains_key(&state.path))
            .map(|(id, state)| (id.clone(), state.clone()))
            .collect();
        for (id, state) in missing {
            if self.store.state().files.get(&id).map(|value| value.deleted).unwrap_or(true) { continue; }
            match self.remote.delete_file(&id, state.revision) {
                Ok(()) => {
                    self.mark_file_deleted(&id);
                    report.remote_deleted += 1;
                    self.save();
                }
                Err(error) if error.status == 404 || error.conflict() => {
                    // 远端已变化：下一轮按远端处理，不能把本地缺失当作删除依据。
                    report.warnings.push(format!("本地删除未传播（远端已变化）：{}", state.path));
                }
                Err(error) => report.errors.push(format!("远端删除失败 {}：{}", state.path, error)),
            }
        }

        let missing_folders: Vec<(String, LocalFolderState)> = self
            .store
            .state()
            .folders
            .iter()
            .filter(|(_, state)| !state.deleted && !scan.entries.contains_key(&state.path))
            .map(|(id, state)| (id.clone(), state.clone()))
            .collect();
        for (id, state) in missing_folders {
            let has_tracked_child = self.store.state().files.values().any(|file| {
                !file.deleted && (file.path.starts_with(&format!("{}/", state.path)) || file.folder_id.as_deref() == Some(id.as_str()))
            });
            if has_tracked_child {
                report.warnings.push(format!("本地文件夹消失但仍有已跟踪文件，未传播删除：{}", state.path));
                continue;
            }
            match self.remote.delete_folder(&id, state.revision) {
                Ok(()) => {
                    if let Some(folder) = self.store.state_mut().folders.get_mut(&id) { folder.deleted = true; }
                    report.remote_deleted += 1;
                    self.save();
                }
                Err(error) if error.status == 404 || error.conflict() => {
                    report.warnings.push(format!("本地文件夹删除未传播（远端已变化）：{}", state.path));
                }
                Err(error) => report.errors.push(format!("远端文件夹删除失败 {}：{}", state.path, error)),
            }
        }
    }

    fn flush_pending(&mut self, report: &mut SyncReport) {
        let pending = self.store.state().pending.clone();
        for operation in pending {
            let result = match &operation {
                PendingOp::Upload { operation_id, file_id, base_revision, relative_path } => {
                    let local = match self.local(relative_path) { Ok(value) => value, Err(error) => { report.warnings.push(error); self.clear_pending(&operation); continue; } };
                    if !local.is_file() { self.clear_pending(&operation); continue; }
                    let size = fs::metadata(&local).map(|meta| meta.len()).unwrap_or(0);
                    let hash = match sha256_file(&local) { Ok(value) => value, Err(error) => { report.warnings.push(error); continue; } };
                    let (folder_path, name) = split_relative(relative_path);
                    let folder_id = if folder_path.is_empty() { None } else { self.find_folder_by_path(folder_path).map(|(id, _)| id) };
                    let mime = guess_mime(name).to_string();
                    self.remote.upload(UploadRequest {
                        local_path: &local, name, folder_id: folder_id.as_deref(),
                        file_id: file_id.as_deref(), base_revision: *base_revision,
                        operation_id, mime_type: &mime, size, sha256: &hash,
                    }).map(|file| { self.track_file(&file, relative_path); })
                }
                PendingOp::FolderCreate { operation_id, relative_path } => {
                    let (parent_path, name) = split_relative(relative_path);
                    let parent = if parent_path.is_empty() { None } else { self.find_folder_by_path(parent_path).map(|(id, _)| id) };
                    self.remote.create_folder(name, parent.as_deref(), operation_id).map(|folder| { self.track_folder(&folder, relative_path); })
                }
                PendingOp::FolderUpdate { folder_id, base_revision, relative_path } => {
                    let (parent_path, name) = split_relative(relative_path);
                    let parent = if parent_path.is_empty() { Some(None) } else { self.find_folder_by_path(parent_path).map(|(id, _)| Some(id)) };
                    self.remote.update_folder(folder_id, Some(name), parent.as_ref().map(|value| value.as_deref()), *base_revision).map(|folder| { self.track_folder(&folder, relative_path); })
                }
                PendingOp::FolderDelete { folder_id, base_revision, .. } => self.remote.delete_folder(folder_id, *base_revision),
                PendingOp::FileUpdate { file_id, base_revision, relative_path } => {
                    let (parent_path, name) = split_relative(relative_path);
                    let parent = if parent_path.is_empty() { Some(None) } else { self.find_folder_by_path(parent_path).map(|(id, _)| Some(id)) };
                    self.remote.patch_file(file_id, Some(name), parent.as_ref().map(|value| value.as_deref()), *base_revision).map(|file| { self.track_file(&file, relative_path); })
                }
                PendingOp::FileDelete { file_id, base_revision, .. } => self.remote.delete_file(file_id, *base_revision),
            };
            match result {
                Ok(()) => { self.clear_pending(&operation); self.save(); }
                Err(error) if error.status == 404 => { self.clear_pending(&operation); self.save(); }
                Err(error) if error.conflict() => {
                    self.clear_pending(&operation);
                    report.warnings.push(format!("待处理操作已失效，交由本轮对账处理：{error}"));
                    self.save();
                }
                Err(error) => report.warnings.push(format!("重放待处理操作失败：{error}")),
            }
        }
    }

    fn push_pending(&mut self, operation: &PendingOp) {
        if !self.store.state().pending.iter().any(|item| item == operation) {
            self.store.state_mut().pending.push(operation.clone());
        }
        self.save();
    }

    fn clear_pending(&mut self, operation: &PendingOp) {
        self.store.state_mut().pending.retain(|item| item != operation);
        self.save();
    }

    fn find_folder_by_path(&self, path: &str) -> Option<(String, LocalFolderState)> {
        self.store
            .state()
            .folders
            .iter()
            .find(|(_, state)| !state.deleted && state.path == path)
            .map(|(id, state)| (id.clone(), state.clone()))
    }

    fn mark_file_deleted(&mut self, file_id: &str) {
        if let Some(state) = self.store.state_mut().files.get_mut(file_id) {
            state.deleted = true;
        }
    }
}

fn split_relative(relative: &str) -> (&str, &str) {
    match relative.rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => ("", relative),
    }
}

fn state_clone_id(files: &BTreeMap<String, LocalFileState>, path: &str) -> Option<String> {
    files.iter().find(|(_, state)| state.path == path && !state.deleted).map(|(id, _)| id.clone())
}

fn iso_now() -> String {
    // 仅作为状态展示；实际游标来自服务端。
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0);
    format!("{}", millis)
}

// 静默未使用告警：STATE_DIR 用于状态目录约定文档化。
const _: &str = STATE_DIR;
