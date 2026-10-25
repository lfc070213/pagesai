//! 同步引擎的离线端到端测试：用内存远端覆盖首轮对账、增删改名、冲突、
//! 游标过期、断网与崩溃恢复、文件夹移动以及“不可读不等于删除”。

use crate::engine::Engine;
use crate::http::RemotePool;
use crate::model::{Change, ChangeSet, RemoteFile, RemoteFolder, RemoteSyncState, Snapshot};
use crate::path_rules::PathRules;
use crate::remote::{Remote, RemoteError, UploadRequest};
use crate::util::sha256_bytes;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MemoryState {
    epoch: String,
    seq: u64,
    pruned_through: u64,
    folders: BTreeMap<String, RemoteFolder>,
    files: BTreeMap<String, RemoteFile>,
    contents: BTreeMap<String, Vec<u8>>,
    log: Vec<Change>,
    folder_ops: BTreeMap<String, String>,
    next_id: u64,
    fail_state: bool,
    fail_upload: bool,
    page_size: usize,
}

#[derive(Clone)]
struct MemoryRemote {
    inner: Arc<Mutex<MemoryState>>,
}

impl MemoryRemote {
    fn new() -> Self {
        let state = MemoryState { epoch: "epoch-1".into(), page_size: 2, ..Default::default() };
        Self { inner: Arc::new(Mutex::new(state)) }
    }

    fn with<F, T>(&self, task: F) -> T
    where
        F: FnOnce(&mut MemoryState) -> T,
    {
        let mut state = self.inner.lock().unwrap();
        task(&mut state)
    }

    fn next_id(state: &mut MemoryState, prefix: &str) -> String {
        state.next_id += 1;
        format!("{prefix}_{}", state.next_id)
    }

    fn next_seq(state: &mut MemoryState) -> u64 {
        state.seq += 1;
        state.seq
    }

    fn folder_path(state: &MemoryState, folder_id: &str) -> Option<String> {
        let mut segments = Vec::new();
        let mut current = folder_id;
        let mut guard = 0;
        loop {
            guard += 1;
            if guard > 128 { return None; }
            let folder = state.folders.get(current)?;
            if folder.status != "active" { return None; }
            segments.push(folder.name.clone());
            match folder.parent_id.as_deref() {
                Some(parent) => current = parent,
                None => break,
            }
        }
        segments.reverse();
        Some(segments.join("/"))
    }

    fn path_of(state: &MemoryState, file_id: &str) -> Option<String> {
        let file = state.files.get(file_id)?;
        let folder = file.folder_id.as_deref().and_then(|id| Self::folder_path(state, id)).unwrap_or_default();
        Some(if folder.is_empty() { file.name.clone() } else { format!("{folder}/{}", file.name) })
    }

    fn ensure_folder(state: &mut MemoryState, path: &str) -> String {
        let mut parent: Option<String> = None;
        for segment in path.split('/').filter(|item| !item.is_empty()) {
            let existing = state
                .folders
                .values()
                .find(|folder| folder.status == "active" && folder.parent_id == parent && folder.name == segment)
                .map(|folder| folder.folder_id.clone());
            parent = Some(match existing {
                Some(id) => id,
                None => {
                    let id = Self::next_id(state, "fld");
                    let seq = Self::next_seq(state);
                    let folder = RemoteFolder {
                        folder_id: id.clone(),
                        parent_id: parent.clone(),
                        name: segment.to_string(),
                        revision: 1,
                        status: "active".into(),
                    };
                    state.folders.insert(id.clone(), folder.clone());
                    state.log.push(Change::Folder { action: "upsert".into(), cursor: seq, folder });
                    id
                }
            });
        }
        parent.unwrap_or_default()
    }

    fn seed_folder(&self, path: &str) {
        self.with(|state| {
            Self::ensure_folder(state, path);
        });
    }

    fn seed_file(&self, path: &str, content: &[u8]) {
        self.with(|state| {
            let (folder_path, name) = split_path(path);
            let folder_id = if folder_path.is_empty() { None } else { Some(Self::ensure_folder(state, &folder_path)) };
            let id = Self::next_id(state, "fil");
            let seq = Self::next_seq(state);
            let hash = sha256_bytes(content);
            let file = RemoteFile {
                file_id: id.clone(),
                folder_id,
                name: name.to_string(),
                revision: 1,
                size: content.len() as u64,
                content_hash: hash,
                mime_type: Some("text/plain".into()),
                status: "active".into(),
            };
            state.contents.insert(id.clone(), content.to_vec());
            state.files.insert(id.clone(), file.clone());
            state.log.push(Change::File { action: "upsert".into(), cursor: seq, file });
        });
    }

    fn remote_write(&self, path: &str, content: &[u8]) {
        self.with(|state| {
            let file_id = state
                .files
                .values()
                .find(|file| file.status == "active" && Self::path_of(state, &file.file_id).as_deref() == Some(path))
                .map(|file| file.file_id.clone());
            match file_id {
                Some(id) => {
                    let seq = Self::next_seq(state);
                    let hash = sha256_bytes(content);
                    let file = state.files.get_mut(&id).unwrap();
                    file.revision += 1;
                    file.size = content.len() as u64;
                    file.content_hash = hash;
                    let cloned = file.clone();
                    state.contents.insert(id, content.to_vec());
                    state.log.push(Change::File { action: "upsert".into(), cursor: seq, file: cloned });
                }
                None => {
                    let (folder_path, name) = split_path(path);
                    let folder_id = if folder_path.is_empty() { None } else { Some(Self::ensure_folder(state, &folder_path)) };
                    let id = Self::next_id(state, "fil");
                    let seq = Self::next_seq(state);
                    let hash = sha256_bytes(content);
                    let file = RemoteFile {
                        file_id: id.clone(), folder_id, name: name.to_string(), revision: 1,
                        size: content.len() as u64, content_hash: hash,
                        mime_type: Some("text/plain".into()), status: "active".into(),
                    };
                    state.contents.insert(id.clone(), content.to_vec());
                    state.files.insert(id.clone(), file.clone());
                    state.log.push(Change::File { action: "upsert".into(), cursor: seq, file });
                }
            }
        });
    }

    fn active_paths(&self) -> Vec<String> {
        self.with(|state| {
            state
                .files
                .values()
                .filter(|file| file.status == "active")
                .filter_map(|file| Self::path_of(state, &file.file_id))
                .collect()
        })
    }

    fn active_folder_paths(&self) -> Vec<String> {
        self.with(|state| {
            state
                .folders
                .values()
                .filter(|folder| folder.status == "active")
                .filter_map(|folder| Self::folder_path(state, &folder.folder_id))
                .collect()
        })
    }

    fn content_of(&self, path: &str) -> Option<Vec<u8>> {
        self.with(|state| {
            state
                .files
                .values()
                .find(|file| file.status == "active" && Self::path_of(state, &file.file_id).as_deref() == Some(path))
                .and_then(|file| state.contents.get(&file.file_id).cloned())
        })
    }

    fn set_fail_state(&self, value: bool) { self.with(|state| state.fail_state = value); }
    fn set_fail_upload(&self, value: bool) { self.with(|state| state.fail_upload = value); }
    fn set_pruned_through(&self, value: u64) { self.with(|state| state.pruned_through = value); }
    fn seq(&self) -> u64 { self.with(|state| state.seq) }
}

impl Remote for MemoryRemote {
    fn state(&mut self) -> Result<RemoteSyncState, RemoteError> {
        self.with(|state| {
            if state.fail_state {
                return Err(RemoteError::transport("模拟网络中断"));
            }
            Ok(RemoteSyncState { epoch: state.epoch.clone(), seq: state.seq, pruned_through: state.pruned_through })
        })
    }

    fn tree(&mut self) -> Result<Snapshot, RemoteError> {
        self.with(|state| {
            if state.fail_state {
                return Err(RemoteError::transport("模拟网络中断"));
            }
            Ok(Snapshot {
                epoch: state.epoch.clone(),
                cursor: state.seq,
                folders: state.folders.values().filter(|folder| folder.status == "active").cloned().collect(),
                files: state.files.values().filter(|file| file.status == "active").cloned().collect(),
            })
        })
    }

    fn changes(&mut self, cursor: u64) -> Result<ChangeSet, RemoteError> {
        self.with(|state| {
            if cursor < state.pruned_through || cursor > state.seq {
                return Err(RemoteError::new(410, "SYNC_CURSOR_EXPIRED", "游标已失效"));
            }
            let page_size = state.page_size.max(1);
            let mut pending: Vec<Change> = state.log.iter().filter(|change| change.cursor() > cursor).cloned().collect();
            pending.sort_by_key(|change| change.cursor());
            let has_more = pending.len() > page_size;
            pending.truncate(page_size);
            let next = pending.last().map(|change| change.cursor()).unwrap_or(cursor);
            Ok(ChangeSet {
                epoch: state.epoch.clone(),
                cursor: next,
                server_cursor: state.seq,
                has_more,
                changes: pending,
            })
        })
    }

    fn download_to(&mut self, file: &RemoteFile, destination: &Path) -> Result<(), RemoteError> {
        self.with(|state| {
            let bytes = state.contents.get(&file.file_id).cloned()
                .ok_or_else(|| RemoteError::new(404, "FILE_NOT_FOUND", "文件不存在"))?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| RemoteError::transport(error.to_string()))?;
            }
            fs::write(destination, bytes).map_err(|error| RemoteError::transport(error.to_string()))
        })
    }

    fn upload(&mut self, request: UploadRequest<'_>) -> Result<RemoteFile, RemoteError> {
        let bytes = fs::read(request.local_path).map_err(|error| RemoteError::transport(error.to_string()))?;
        if sha256_bytes(&bytes) != request.sha256 || bytes.len() as u64 != request.size {
            return Err(RemoteError::new(400, "CHUNK_HASH_MISMATCH", "本地内容与声明不一致"));
        }
        self.with(|state| {
            if state.fail_upload {
                return Err(RemoteError::transport("模拟上传中断"));
            }
            let folder_id = request.folder_id.map(str::to_string);
            let target = match request.file_id {
                Some(id) => {
                    let existing = state.files.get(id)
                        .ok_or_else(|| RemoteError::new(404, "FILE_NOT_FOUND", "目标文件不存在"))?;
                    if existing.status != "active" {
                        return Err(RemoteError::new(409, "FILE_DELETED", "目标文件已删除"));
                    }
                    if request.base_revision != Some(existing.revision) {
                        return Err(RemoteError::new(409, "REVISION_CONFLICT", "基础修订不匹配"));
                    }
                    Some(id.to_string())
                }
                None => {
                    let id = format!("fil_op_{}", state.next_id + 1);
                    state.next_id += 1;
                    Some(id)
                }
            };
            let file_id = target.unwrap();
            if state.files.values().any(|file| {
                file.status == "active" && file.file_id != file_id
                    && file.folder_id == folder_id && file.name == request.name
            }) {
                return Err(RemoteError::new(409, "NAME_CONFLICT", "同名文件已存在"));
            }
            let seq = Self::next_seq(state);
            let revision = state.files.get(&file_id).map(|file| file.revision + 1).unwrap_or(1);
            let file = RemoteFile {
                file_id: file_id.clone(),
                folder_id,
                name: request.name.to_string(),
                revision,
                size: bytes.len() as u64,
                content_hash: sha256_bytes(&bytes),
                mime_type: Some(request.mime_type.to_string()),
                status: "active".into(),
            };
            state.contents.insert(file_id.clone(), bytes);
            state.files.insert(file_id.clone(), file.clone());
            state.log.push(Change::File { action: "upsert".into(), cursor: seq, file: file.clone() });
            Ok(file)
        })
    }

    fn create_folder(&mut self, name: &str, parent_id: Option<&str>, operation_id: &str) -> Result<RemoteFolder, RemoteError> {
        self.with(|state| {
            if let Some(id) = state.folder_ops.get(operation_id) {
                return state.folders.get(id).cloned()
                    .ok_or_else(|| RemoteError::new(404, "FOLDER_NOT_FOUND", "文件夹不存在"));
            }
            if state.folders.values().any(|folder| {
                folder.status == "active" && folder.parent_id.as_deref() == parent_id && folder.name == name
            }) {
                return Err(RemoteError::new(409, "NAME_CONFLICT", "同名文件夹已存在"));
            }
            let seq = Self::next_seq(state);
            let id = Self::next_id(state, "fld");
            let folder = RemoteFolder {
                folder_id: id.clone(), parent_id: parent_id.map(str::to_string),
                name: name.to_string(), revision: 1, status: "active".into(),
            };
            state.folders.insert(id.clone(), folder.clone());
            state.folder_ops.insert(operation_id.to_string(), id);
            state.log.push(Change::Folder { action: "upsert".into(), cursor: seq, folder: folder.clone() });
            Ok(folder)
        })
    }

    fn update_folder(&mut self, folder_id: &str, name: Option<&str>, parent_id: Option<Option<&str>>, base_revision: u64) -> Result<RemoteFolder, RemoteError> {
        self.with(|state| {
            let current = state.folders.get(folder_id).cloned()
                .ok_or_else(|| RemoteError::new(404, "FOLDER_NOT_FOUND", "文件夹不存在"))?;
            if current.status != "active" {
                return Err(RemoteError::new(409, "FOLDER_DELETED", "文件夹已删除"));
            }
            if current.revision != base_revision {
                return Err(RemoteError::new(409, "REVISION_CONFLICT", "基础修订不匹配"));
            }
            let name = name.unwrap_or(&current.name).to_string();
            let parent = match parent_id { Some(value) => value.map(str::to_string), None => current.parent_id.clone() };
            if parent.as_deref() == Some(folder_id) {
                return Err(RemoteError::new(400, "INVALID_INPUT", "文件夹不能移动到自身"));
            }
            if state.folders.values().any(|folder| {
                folder.status == "active" && folder.folder_id != folder_id
                    && folder.parent_id == parent && folder.name == name
            }) {
                return Err(RemoteError::new(409, "NAME_CONFLICT", "同名文件夹已存在"));
            }
            let seq = Self::next_seq(state);
            let folder = RemoteFolder { folder_id: folder_id.to_string(), parent_id: parent, name, revision: current.revision + 1, status: "active".into() };
            state.folders.insert(folder_id.to_string(), folder.clone());
            state.log.push(Change::Folder { action: "upsert".into(), cursor: seq, folder: folder.clone() });
            Ok(folder)
        })
    }

    fn delete_folder(&mut self, folder_id: &str, base_revision: u64) -> Result<(), RemoteError> {
        self.with(|state| {
            let current = state.folders.get(folder_id).cloned()
                .ok_or_else(|| RemoteError::new(404, "FOLDER_NOT_FOUND", "文件夹不存在"))?;
            if current.status != "active" {
                return Err(RemoteError::new(409, "FOLDER_ALREADY_DELETED", "文件夹已删除"));
            }
            if base_revision != current.revision {
                return Err(RemoteError::new(409, "REVISION_CONFLICT", "基础修订不匹配"));
            }
            let mut descendants = vec![folder_id.to_string()];
            let mut grew = true;
            while grew {
                grew = false;
                for folder in state.folders.values() {
                    if folder.status == "active" {
                        if let Some(parent) = folder.parent_id.as_deref() {
                            if descendants.iter().any(|id| id == parent) && !descendants.iter().any(|id| id == &folder.folder_id) {
                                descendants.push(folder.folder_id.clone());
                                grew = true;
                            }
                        }
                    }
                }
            }
            for id in &descendants {
                let active = state.folders.get(id).map(|folder| folder.status == "active").unwrap_or(false);
                if !active { continue; }
                let seq = Self::next_seq(state);
                let folder = state.folders.get_mut(id).unwrap();
                folder.status = "deleted".into();
                folder.revision += 1;
                let clone = folder.clone();
                state.log.push(Change::Folder { action: "delete".into(), cursor: seq, folder: clone });
            }
            let file_ids: Vec<String> = state.files.values()
                .filter(|file| file.status == "active" && file.folder_id.as_deref().map(|id| descendants.iter().any(|item| item == id)).unwrap_or(false))
                .map(|file| file.file_id.clone())
                .collect();
            for id in file_ids {
                let seq = Self::next_seq(state);
                let file = state.files.get_mut(&id).unwrap();
                file.status = "deleted".into();
                file.revision += 1;
                let clone = file.clone();
                state.log.push(Change::File { action: "delete".into(), cursor: seq, file: clone });
            }
            Ok(())
        })
    }

    fn patch_file(&mut self, file_id: &str, name: Option<&str>, folder_id: Option<Option<&str>>, base_revision: u64) -> Result<RemoteFile, RemoteError> {
        self.with(|state| {
            let current = state.files.get(file_id).cloned()
                .ok_or_else(|| RemoteError::new(404, "FILE_NOT_FOUND", "文件不存在"))?;
            if current.status != "active" {
                return Err(RemoteError::new(409, "FILE_DELETED", "文件已删除"));
            }
            if current.revision != base_revision {
                return Err(RemoteError::new(409, "REVISION_CONFLICT", "基础修订不匹配"));
            }
            let name = name.unwrap_or(&current.name).to_string();
            let folder = match folder_id { Some(value) => value.map(str::to_string), None => current.folder_id.clone() };
            if state.files.values().any(|file| {
                file.status == "active" && file.file_id != file_id
                    && file.folder_id == folder && file.name == name
            }) {
                return Err(RemoteError::new(409, "NAME_CONFLICT", "同名文件已存在"));
            }
            let seq = Self::next_seq(state);
            let updated = RemoteFile { file_id: file_id.to_string(), folder_id: folder, name, revision: current.revision + 1, ..current };
            state.files.insert(file_id.to_string(), updated.clone());
            state.log.push(Change::File { action: "upsert".into(), cursor: seq, file: updated.clone() });
            Ok(updated)
        })
    }

    fn delete_file(&mut self, file_id: &str, base_revision: u64) -> Result<(), RemoteError> {
        self.with(|state| {
            let current = state.files.get(file_id).cloned()
                .ok_or_else(|| RemoteError::new(404, "FILE_NOT_FOUND", "文件不存在"))?;
            if current.status != "active" {
                return Err(RemoteError::new(409, "FILE_DELETED", "文件已删除"));
            }
            if current.revision != base_revision {
                return Err(RemoteError::new(409, "REVISION_CONFLICT", "基础修订不匹配"));
            }
            let seq = Self::next_seq(state);
            let mut updated = current;
            updated.status = "deleted".into();
            updated.revision += 1;
            state.files.insert(file_id.to_string(), updated.clone());
            state.log.push(Change::File { action: "delete".into(), cursor: seq, file: updated });
            Ok(())
        })
    }
}

fn split_path(path: &str) -> (String, &str) {
    match path.rsplit_once('/') {
        Some((parent, name)) => (parent.to_string(), name),
        None => (String::new(), path),
    }
}

fn workspace() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("sync-root");
    (temp, root)
}

fn read(root: &Path, relative: &str) -> String {
    fs::read_to_string(root.join(relative)).unwrap()
}

fn write(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).unwrap(); }
    fs::write(path, content).unwrap();
}

fn local_files(root: &Path) -> Vec<String> {
    let mut result = Vec::new();
    fn walk(base: &Path, current: &Path, result: &mut Vec<String>) {
        for entry in fs::read_dir(current).unwrap().flatten() {
            let path = entry.path();
            if path.file_name().map(|name| name == ".pagesai").unwrap_or(false) { continue; }
            if path.is_dir() {
                walk(base, &path, result);
            } else {
                result.push(path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    walk(root, root, &mut result);
    result.sort();
    result
}

#[test]
fn first_sync_downloads_tree() {
    let (_temp, root) = workspace();
    let remote = MemoryRemote::new();
    remote.seed_folder("docs");
    remote.seed_folder("docs/nested");
    remote.seed_file("docs/a.txt", b"alpha");
    remote.seed_file("docs/nested/b.md", b"beta");

    let mut engine = Engine::new(&root, "dev-1", remote.clone()).unwrap();
    let report = engine.sync().unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.downloaded, 2);
    assert_eq!(read(&root, "docs/a.txt"), "alpha");
    assert_eq!(read(&root, "docs/nested/b.md"), "beta");
    assert_eq!(engine.status().cursor, remote.seq());
    assert!(engine.status().pending.is_empty());
}

#[test]
fn local_add_move_delete_round_trip() {
    let (_temp, root) = workspace();
    let remote = MemoryRemote::new();
    fs::create_dir_all(&root).unwrap();
    write(&root, "a.txt", "one");

    let mut engine = Engine::new(&root, "dev-1", remote.clone()).unwrap();
    engine.sync().unwrap();
    assert_eq!(remote.active_paths(), vec!["a.txt".to_string()]);
    assert_eq!(remote.content_of("a.txt").unwrap(), b"one");

    fs::create_dir_all(root.join("sub")).unwrap();
    fs::rename(root.join("a.txt"), root.join("sub/b.txt")).unwrap();
    engine.sync().unwrap();
    assert_eq!(remote.active_paths(), vec!["sub/b.txt".to_string()]);
    assert!(remote.active_folder_paths().contains(&"sub".to_string()));

    fs::remove_dir_all(root.join("sub")).unwrap();
    engine.sync().unwrap();
    assert!(remote.active_paths().is_empty(), "远端应只剩删除墓碑：{:?}", remote.active_paths());
    assert!(remote.active_folder_paths().is_empty(), "{:?}", remote.active_folder_paths());
}

#[test]
fn both_sides_modified_keeps_conflict_copy() {
    let (_temp, root) = workspace();
    let remote = MemoryRemote::new();
    remote.seed_file("a.txt", b"base");

    let mut engine = Engine::new(&root, "dev-1", remote.clone()).unwrap();
    engine.sync().unwrap();
    assert_eq!(read(&root, "a.txt"), "base");

    write(&root, "a.txt", "local-edit");
    remote.remote_write("a.txt", b"remote-edit");

    let report = engine.sync().unwrap();
    assert!(report.conflicts >= 1, "{:?}", report.warnings);
    assert_eq!(read(&root, "a.txt"), "remote-edit");
    let conflicts: Vec<String> = local_files(&root).into_iter().filter(|name| name.contains("conflict")).collect();
    assert_eq!(conflicts.len(), 1, "{:?}", local_files(&root));
    assert_eq!(read(&root, &conflicts[0]), "local-edit");
}

#[test]
fn cursor_expiry_triggers_full_reconcile() {
    let (_temp, root) = workspace();
    let remote = MemoryRemote::new();
    remote.seed_file("a.txt", b"one");
    let mut engine = Engine::new(&root, "dev-1", remote.clone()).unwrap();
    engine.sync().unwrap();
    assert_eq!(engine.status().cursor, 1);

    remote.set_pruned_through(2);
    remote.seed_file("b.txt", b"two");
    let report = engine.sync().unwrap();
    assert!(report.warnings.iter().any(|item| item.contains("游标")), "{:?}", report.warnings);
    assert_eq!(read(&root, "b.txt"), "two");
    assert_eq!(engine.status().cursor, remote.seq());
}

#[test]
fn network_failure_never_counts_as_deletion() {
    let (_temp, root) = workspace();
    let remote = MemoryRemote::new();
    fs::create_dir_all(&root).unwrap();
    write(&root, "keep.txt", "important");

    let mut engine = Engine::new(&root, "dev-1", remote.clone()).unwrap();
    engine.sync().unwrap();
    assert_eq!(remote.active_paths(), vec!["keep.txt".to_string()]);

    fs::remove_file(root.join("keep.txt")).unwrap();
    remote.set_fail_state(true);
    let report = engine.sync().unwrap();
    assert!(!report.errors.is_empty());
    assert_eq!(remote.active_paths(), vec!["keep.txt".to_string()], "断网时不得传播删除");

    remote.set_fail_state(false);
    engine.sync().unwrap();
    assert!(remote.active_paths().is_empty());
}

#[test]
fn pending_upload_recovers_after_crash() {
    let (_temp, root) = workspace();
    let remote = MemoryRemote::new();
    fs::create_dir_all(&root).unwrap();
    write(&root, "report.txt", "draft");

    {
        let mut engine = Engine::new(&root, "dev-1", remote.clone()).unwrap();
        remote.set_fail_upload(true);
        let report = engine.sync().unwrap();
        assert!(!report.errors.is_empty(), "应记录上传失败");
        assert_eq!(engine.status().pending.len(), 1, "待处理操作必须落盘");
    }

    remote.set_fail_upload(false);
    let mut engine = Engine::new(&root, "dev-1", remote.clone()).unwrap();
    assert_eq!(engine.status().pending.len(), 1);
    let report = engine.sync().unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(remote.content_of("report.txt").unwrap(), b"draft");
    assert!(engine.status().pending.is_empty());
}

#[test]
fn folder_rename_converges_without_duplicates() {
    let (_temp, root) = workspace();
    let remote = MemoryRemote::new();
    fs::create_dir_all(root.join("alpha")).unwrap();
    write(&root, "alpha/x.txt", "x");
    write(&root, "alpha/y.txt", "y");

    let mut engine = Engine::new(&root, "dev-1", remote.clone()).unwrap();
    engine.sync().unwrap();
    let mut before = remote.active_paths();
    before.sort();
    assert_eq!(before, vec!["alpha/x.txt".to_string(), "alpha/y.txt".to_string()]);

    fs::rename(root.join("alpha"), root.join("beta")).unwrap();
    engine.sync().unwrap();
    let mut after = remote.active_paths();
    after.sort();
    assert_eq!(after, vec!["beta/x.txt".to_string(), "beta/y.txt".to_string()]);
    assert!(!remote.active_folder_paths().contains(&"alpha".to_string()));
    assert!(remote.active_folder_paths().contains(&"beta".to_string()));
}

#[test]
fn remote_delete_removes_untouched_local_file() {
    let (_temp, root) = workspace();
    let remote = MemoryRemote::new();
    remote.seed_file("gone.txt", b"bye");
    let mut engine = Engine::new(&root, "dev-1", remote.clone()).unwrap();
    engine.sync().unwrap();
    assert!(root.join("gone.txt").is_file());

    {
        let mut state = remote.inner.lock().unwrap();
        let (id, revision) = {
            let file = state.files.values().find(|file| file.name == "gone.txt").unwrap();
            (file.file_id.clone(), file.revision)
        };
        state.seq += 1;
        let seq = state.seq;
        let file = state.files.get_mut(&id).unwrap();
        file.status = "deleted".into();
        file.revision = revision + 1;
        let clone = file.clone();
        state.log.push(Change::File { action: "delete".into(), cursor: seq, file: clone });
    }

    let report = engine.sync().unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!root.join("gone.txt").exists());
    assert_eq!(report.local_deleted, 1);
}

#[test]
fn endpoint_pool_fails_over_without_second_dataset() {
    let bad = MemoryRemote::new();
    bad.set_fail_state(true);
    let good = MemoryRemote::new();
    good.seed_file("a.txt", b"x");
    let mut pool = RemotePool::new(vec![Box::new(bad), Box::new(good.clone())]).unwrap();
    let state = pool.state().unwrap();
    assert_eq!(state.seq, good.seq());
    assert_eq!(pool.tree().unwrap().files.len(), 1);
}

#[test]
fn windows_rules_reject_unsafe_remote_names() {
    let (_temp, root) = workspace();
    let remote = MemoryRemote::new();
    remote.seed_file("CON.txt", b"bad");
    remote.seed_file("ok.txt", b"good");
    let mut engine = Engine::with_rules(&root, "dev-1", remote.clone(), PathRules::windows()).unwrap();
    let report = engine.sync().unwrap();
    assert!(report.errors.iter().any(|item| item.contains("Windows") || item.contains("保留")), "{:?}", report.errors);
    assert_eq!(read(&root, "ok.txt"), "good");
}
