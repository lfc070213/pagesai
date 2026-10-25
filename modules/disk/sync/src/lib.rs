//! PagesAI Disk 双向同步引擎。
//!
//! 设计边界：
//! - 服务端是权限与修订的唯一权威，客户端只持有设备令牌；
//! - 本地状态以原子替换的 JSON 保存，崩溃后按待处理日志重放；
//! - 冲突一律保留双方内容，不做静默覆盖；
//! - 本地扫描不完整（目录不可读、哈希失败、大小写冲突）时禁止传播删除。

pub mod engine;
pub mod http;
pub mod model;
pub mod path_rules;
pub mod remote;
pub mod state;
pub mod strategy;
pub mod util;

#[cfg(test)]
mod engine_tests;

pub use engine::Engine;
pub use http::{pair_device, revoke_device, HttpRemote, PairResult, RemotePool};
pub use model::{
    Change, ChangeSet, LocalFileState, LocalFolderState, PendingOp, RemoteFile, RemoteFolder,
    RemoteSyncState, Snapshot, StoredState, SyncReport,
};
pub use path_rules::{PathRules, STATE_DIR};
pub use remote::{Remote, RemoteError, UploadRequest};
pub use state::StateStore;
pub use strategy::{Endpoint, EndpointKind, Strategy};

pub const PROTOCOL_VERSION: u32 = 1;
