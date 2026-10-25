use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFolder {
    pub folder_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub revision: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub file_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub revision: u64,
    pub size: u64,
    pub content_hash: String,
    pub mime_type: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub epoch: String,
    pub cursor: u64,
    #[serde(default)]
    pub folders: Vec<RemoteFolder>,
    #[serde(default)]
    pub files: Vec<RemoteFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSyncState {
    pub epoch: String,
    pub seq: u64,
    #[serde(default)]
    pub pruned_through: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Change {
    Folder {
        action: String,
        cursor: u64,
        folder: RemoteFolder,
    },
    File {
        action: String,
        cursor: u64,
        file: RemoteFile,
    },
}

impl Change {
    pub fn cursor(&self) -> u64 {
        match self {
            Change::Folder { cursor, .. } | Change::File { cursor, .. } => *cursor,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub epoch: String,
    pub cursor: u64,
    pub server_cursor: u64,
    pub has_more: bool,
    #[serde(default)]
    pub changes: Vec<Change>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub cursor: u64,
    pub downloaded: usize,
    pub uploaded: usize,
    pub local_deleted: usize,
    pub remote_deleted: usize,
    pub conflicts: usize,
    pub skipped: usize,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileState {
    pub path: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub revision: u64,
    pub hash: String,
    pub size: u64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFolderState {
    pub path: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub revision: u64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PendingOp {
    Upload {
        operation_id: String,
        file_id: Option<String>,
        base_revision: Option<u64>,
        relative_path: String,
    },
    FolderCreate {
        operation_id: String,
        relative_path: String,
    },
    FolderUpdate {
        folder_id: String,
        base_revision: u64,
        relative_path: String,
    },
    FolderDelete {
        folder_id: String,
        base_revision: u64,
        relative_path: String,
    },
    FileUpdate {
        file_id: String,
        base_revision: u64,
        relative_path: String,
    },
    FileDelete {
        file_id: String,
        base_revision: u64,
        relative_path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
    pub version: u32,
    pub device_id: String,
    pub root: String,
    pub epoch: Option<String>,
    pub cursor: u64,
    pub next_operation: u64,
    #[serde(default)]
    pub files: std::collections::BTreeMap<String, LocalFileState>,
    #[serde(default)]
    pub folders: std::collections::BTreeMap<String, LocalFolderState>,
    #[serde(default)]
    pub pending: Vec<PendingOp>,
    pub last_sync_at: Option<String>,
}

impl StoredState {
    pub fn new(device_id: String, root: String) -> Self {
        Self {
            version: 1,
            device_id,
            root,
            epoch: None,
            cursor: 0,
            next_operation: 1,
            files: Default::default(),
            folders: Default::default(),
            pending: Default::default(),
            last_sync_at: None,
        }
    }

    pub fn next_operation_id(&mut self) -> String {
        let value = self.next_operation;
        self.next_operation += 1;
        format!("{}-{}", self.device_id, value)
    }
}
