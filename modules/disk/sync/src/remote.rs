use crate::model::{ChangeSet, RemoteFile, RemoteFolder, RemoteSyncState, Snapshot};
use std::fmt;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct RemoteError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl RemoteError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { status, code: code.into(), message: message.into() }
    }
    pub fn transport(message: impl Into<String>) -> Self {
        Self { status: 0, code: "NETWORK".into(), message: message.into() }
    }
    pub fn retryable(&self) -> bool {
        self.status == 0 || self.status == 429 || self.status >= 500
    }
    pub fn cursor_expired(&self) -> bool {
        matches!(self.code.as_str(), "SYNC_CURSOR_EXPIRED" | "SYNC_EPOCH_MISMATCH" | "SYNC_CURSOR_INVALID")
    }
    pub fn conflict(&self) -> bool {
        matches!(self.code.as_str(), "REVISION_CONFLICT" | "NAME_CONFLICT" | "OPERATION_CONFLICT" | "FILE_DELETED" | "FOLDER_DELETED")
    }
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} (HTTP {})", self.code, self.message, self.status)
    }
}

impl std::error::Error for RemoteError {}

#[derive(Debug, Clone)]
pub struct UploadRequest<'a> {
    pub local_path: &'a Path,
    pub name: &'a str,
    pub folder_id: Option<&'a str>,
    pub file_id: Option<&'a str>,
    pub base_revision: Option<u64>,
    pub operation_id: &'a str,
    pub mime_type: &'a str,
    pub size: u64,
    pub sha256: &'a str,
}

pub trait Remote {
    fn state(&mut self) -> Result<RemoteSyncState, RemoteError>;
    fn tree(&mut self) -> Result<Snapshot, RemoteError>;
    fn changes(&mut self, cursor: u64) -> Result<ChangeSet, RemoteError>;
    fn download_to(&mut self, file: &RemoteFile, destination: &Path) -> Result<(), RemoteError>;
    fn upload(&mut self, request: UploadRequest<'_>) -> Result<RemoteFile, RemoteError>;
    fn create_folder(&mut self, name: &str, parent_id: Option<&str>, operation_id: &str) -> Result<RemoteFolder, RemoteError>;
    fn update_folder(&mut self, folder_id: &str, name: Option<&str>, parent_id: Option<Option<&str>>, base_revision: u64) -> Result<RemoteFolder, RemoteError>;
    fn delete_folder(&mut self, folder_id: &str, base_revision: u64) -> Result<(), RemoteError>;
    fn patch_file(&mut self, file_id: &str, name: Option<&str>, folder_id: Option<Option<&str>>, base_revision: u64) -> Result<RemoteFile, RemoteError>;
    fn delete_file(&mut self, file_id: &str, base_revision: u64) -> Result<(), RemoteError>;
}
