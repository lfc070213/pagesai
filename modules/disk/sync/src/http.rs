use crate::model::{ChangeSet, RemoteFile, RemoteFolder, RemoteSyncState, Snapshot};
use crate::remote::{Remote, RemoteError, UploadRequest};
use reqwest::blocking::{Client, Response};
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;
use url::Url;

pub struct HttpRemote {
    client: Client,
    base: Url,
    token: String,
}

impl HttpRemote {
    pub fn new(service_url: &str, token: impl Into<String>) -> Result<Self, String> {
        let base = Url::parse(service_url.trim_end_matches('/')).map_err(|error| format!("服务地址非法：{error}"))?;
        if base.scheme() != "https" && !is_loopback(&base) {
            return Err("生产服务地址必须使用 HTTPS；明文 HTTP 仅允许回环地址".into());
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("pagesai-disk-sync/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("HTTP 客户端初始化失败：{error}"))?;
        Ok(Self { client, base, token: token.into() })
    }

    fn url(&self, path: &str) -> Result<Url, RemoteError> {
        self.base.join(path).map_err(|error| RemoteError::transport(format!("拼接地址失败：{error}")))
    }

    fn request(&self, method: Method, path: &str) -> reqwest::blocking::RequestBuilder {
        let builder = self.client.request(method, self.url(path).unwrap_or_else(|_| self.base.clone()));
        if self.token.is_empty() { builder } else { builder.bearer_auth(&self.token) }
    }

    fn decode<T: DeserializeOwned>(response: Response) -> Result<T, RemoteError> {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        if !status.is_success() {
            return Err(parse_error(status, &text));
        }
        serde_json::from_str(&text).map_err(|error| RemoteError::transport(format!("响应不是预期 JSON：{error}")))
    }

    fn empty(&self, response: Response) -> Result<(), RemoteError> {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        if !status.is_success() {
            return Err(parse_error(status, &text));
        }
        Ok(())
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("::1") => true,
        _ => false,
    }
}

fn parse_error(status: StatusCode, text: &str) -> RemoteError {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        let code = value.get("code").and_then(Value::as_str).unwrap_or("HTTP_ERROR").to_string();
        let message = value.get("message").and_then(Value::as_str).unwrap_or(text).to_string();
        return RemoteError::new(status.as_u16(), code, message);
    }
    RemoteError::new(status.as_u16(), "HTTP_ERROR", text.chars().take(400).collect::<String>())
}

impl Remote for HttpRemote {
    fn state(&mut self) -> Result<RemoteSyncState, RemoteError> {
        let response = self.request(Method::GET, "sync/state").send().map_err(|error| RemoteError::transport(error.to_string()))?;
        Self::decode(response)
    }

    fn tree(&mut self) -> Result<Snapshot, RemoteError> {
        let response = self.request(Method::GET, "sync/tree").send().map_err(|error| RemoteError::transport(error.to_string()))?;
        Self::decode(response)
    }

    fn changes(&mut self, cursor: u64) -> Result<ChangeSet, RemoteError> {
        let response = self
            .request(Method::GET, &format!("sync/changes?cursor={cursor}&limit=500"))
            .send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        Self::decode(response)
    }

    fn download_to(&mut self, file: &RemoteFile, destination: &Path) -> Result<(), RemoteError> {
        let mut response = self
            .request(Method::GET, &format!("files/{}/content", urlencoding(&file.file_id)))
            .send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().unwrap_or_default();
            return Err(parse_error(status, &text));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| RemoteError::transport(error.to_string()))?;
        }
        let mut output = File::create(destination).map_err(|error| RemoteError::transport(error.to_string()))?;
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            let read = response.read(&mut buffer).map_err(|error| RemoteError::transport(error.to_string()))?;
            if read == 0 { break; }
            output.write_all(&buffer[..read]).map_err(|error| RemoteError::transport(error.to_string()))?;
        }
        output.sync_all().map_err(|error| RemoteError::transport(error.to_string()))?;
        Ok(())
    }

    fn upload(&mut self, request: UploadRequest<'_>) -> Result<RemoteFile, RemoteError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct InitResponse {
            upload_id: String,
            chunk_size: u64,
            #[allow(dead_code)]
            file_id: String,
        }
        let init_body = json!({
            "name": request.name,
            "size": request.size,
            "sha256": request.sha256,
            "mimeType": request.mime_type,
            "folderId": request.folder_id,
            "fileId": request.file_id,
            "baseRevision": request.base_revision,
            "operationId": request.operation_id
        });
        let response = self.request(Method::POST, "uploads/init").json(&init_body).send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        let init: InitResponse = Self::decode(response)?;
        let mut source = File::open(request.local_path).map_err(|error| RemoteError::transport(error.to_string()))?;
        let chunk_size = init.chunk_size.max(1) as usize;

        // 续传：operationId 固定了 uploadId，重放时先读取服务端已接收的分块。
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct UploadState {
            #[serde(default)]
            status: String,
            #[serde(default)]
            received_chunks: u64,
            #[serde(default)]
            next_offset: u64,
            #[serde(default)]
            result: Option<CompletedFile>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CompletedFile { file_id: String }
        let state_response = self
            .request(Method::GET, &format!("uploads/{}", urlencoding(&init.upload_id)))
            .send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        #[derive(Deserialize)]
        struct StateResponse { upload: UploadState }
        let upload_state: StateResponse = Self::decode(state_response)?;
        let upload_state = upload_state.upload;
        if matches!(upload_state.status.as_str(), "failed" | "cancelled") {
            return Err(RemoteError::new(409, "UPLOAD_FAILED", "上一次上传已失败或被取消，请重新开始"));
        }
        if upload_state.status == "committed" {
            let file_id = upload_state.result.map(|value| value.file_id).unwrap_or(init.file_id);
            let response = self
                .request(Method::GET, &format!("files/{}", urlencoding(&file_id)))
                .send()
                .map_err(|error| RemoteError::transport(error.to_string()))?;
            #[derive(Deserialize)]
            struct FileResponse { file: RemoteFile }
            return Ok(Self::decode::<FileResponse>(response)?.file);
        }
        let mut index = upload_state.received_chunks as usize;
        let mut offset = upload_state.next_offset;
        if offset > request.size {
            return Err(RemoteError::new(409, "UPLOAD_STATE", "服务端上传偏移超过本地文件大小"));
        }
        if offset > 0 {
            use std::io::Seek;
            source.seek(std::io::SeekFrom::Start(offset)).map_err(|error| RemoteError::transport(error.to_string()))?;
        }
        let mut buffer = vec![0u8; chunk_size];
        loop {
            let read = source.read(&mut buffer).map_err(|error| RemoteError::transport(error.to_string()))?;
            if read == 0 { break; }
            offset += read as u64;
            let response = self
                .request(Method::PUT, &format!("uploads/{}/chunks/{index}/data", urlencoding(&init.upload_id)))
                .header("content-type", "application/octet-stream")
                .body(buffer[..read].to_vec())
                .send()
                .map_err(|error| RemoteError::transport(error.to_string()))?;
            self.empty(response)?;
            index += 1;
            if offset > request.size {
                return Err(RemoteError::transport("本地文件在同步过程中增长，已中止"));
            }
        }
        if offset != request.size {
            return Err(RemoteError::transport("本地文件在同步过程中缩短，已中止"));
        }
        let response = self
            .request(Method::POST, &format!("uploads/{}/complete", urlencoding(&init.upload_id)))
            .json(&json!({}))
            .send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        #[derive(Deserialize)]
        struct CompleteResponse { file: RemoteFile }
        let completed: CompleteResponse = Self::decode(response)?;
        Ok(completed.file)
    }

    fn create_folder(&mut self, name: &str, parent_id: Option<&str>, operation_id: &str) -> Result<RemoteFolder, RemoteError> {
        #[derive(Deserialize)]
        struct Response { folder: RemoteFolder }
        let response = self
            .request(Method::POST, "folders")
            .json(&json!({ "name": name, "parentId": parent_id, "operationId": operation_id }))
            .send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        Ok(Self::decode::<Response>(response)?.folder)
    }

    fn update_folder(&mut self, folder_id: &str, name: Option<&str>, parent_id: Option<Option<&str>>, base_revision: u64) -> Result<RemoteFolder, RemoteError> {
        #[derive(Deserialize)]
        struct Response { folder: RemoteFolder }
        let mut body = json!({ "baseRevision": base_revision });
        if let Some(name) = name { body["name"] = Value::String(name.to_string()); }
        if let Some(parent) = parent_id { body["parentId"] = parent.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null); }
        let response = self
            .request(Method::PATCH, &format!("folders/{}", urlencoding(folder_id)))
            .json(&body)
            .send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        Ok(Self::decode::<Response>(response)?.folder)
    }

    fn delete_folder(&mut self, folder_id: &str, base_revision: u64) -> Result<(), RemoteError> {
        let response = self
            .request(Method::DELETE, &format!("folders/{}", urlencoding(folder_id)))
            .json(&json!({ "baseRevision": base_revision }))
            .send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        self.empty(response)
    }

    fn patch_file(&mut self, file_id: &str, name: Option<&str>, folder_id: Option<Option<&str>>, base_revision: u64) -> Result<RemoteFile, RemoteError> {
        #[derive(Deserialize)]
        struct Response { file: RemoteFile }
        let mut body = json!({ "baseRevision": base_revision });
        if let Some(name) = name { body["name"] = Value::String(name.to_string()); }
        if let Some(folder) = folder_id { body["folderId"] = folder.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null); }
        let response = self
            .request(Method::PATCH, &format!("files/{}", urlencoding(file_id)))
            .json(&body)
            .send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        Ok(Self::decode::<Response>(response)?.file)
    }

    fn delete_file(&mut self, file_id: &str, base_revision: u64) -> Result<(), RemoteError> {
        let response = self
            .request(Method::DELETE, &format!("files/{}", urlencoding(file_id)))
            .json(&json!({ "baseRevision": base_revision }))
            .send()
            .map_err(|error| RemoteError::transport(error.to_string()))?;
        self.empty(response)
    }
}

/// 多端点故障转移。所有端点共享同一设备令牌与同一服务端数据；
/// 可重试错误按顺序切换传输路径，写操作依靠 operationId/修订保证幂等。
pub struct RemotePool {
    remotes: Vec<Box<dyn Remote>>,
}

impl RemotePool {
    pub fn new(remotes: Vec<Box<dyn Remote>>) -> Result<Self, String> {
        if remotes.is_empty() {
            return Err("至少需要一个同步端点".into());
        }
        Ok(Self { remotes })
    }

    fn run<T, F>(&mut self, mut task: F) -> Result<T, RemoteError>
    where
        F: FnMut(&mut dyn Remote) -> Result<T, RemoteError>,
    {
        let mut last: Option<RemoteError> = None;
        for _ in 0..self.remotes.len() {
            let mut remote = self.remotes.remove(0);
            let result = task(remote.as_mut());
            match result {
                Ok(value) => {
                    self.remotes.push(remote);
                    return Ok(value);
                }
                Err(error) if error.retryable() => {
                    last = Some(error);
                    self.remotes.push(remote);
                }
                Err(error) => {
                    self.remotes.push(remote);
                    return Err(error);
                }
            }
        }
        Err(last.unwrap_or_else(|| RemoteError::transport("没有可用同步端点")))
    }

    pub fn len(&self) -> usize { self.remotes.len() }
    pub fn is_empty(&self) -> bool { self.remotes.is_empty() }
}

impl Remote for RemotePool {
    fn state(&mut self) -> Result<RemoteSyncState, RemoteError> {
        self.run(|remote| remote.state())
    }
    fn tree(&mut self) -> Result<Snapshot, RemoteError> {
        self.run(|remote| remote.tree())
    }
    fn changes(&mut self, cursor: u64) -> Result<ChangeSet, RemoteError> {
        self.run(|remote| remote.changes(cursor))
    }
    fn download_to(&mut self, file: &RemoteFile, destination: &Path) -> Result<(), RemoteError> {
        self.run(|remote| remote.download_to(file, destination))
    }
    fn upload(&mut self, request: UploadRequest<'_>) -> Result<RemoteFile, RemoteError> {
        self.run(|remote| remote.upload(request.clone()))
    }
    fn create_folder(&mut self, name: &str, parent_id: Option<&str>, operation_id: &str) -> Result<RemoteFolder, RemoteError> {
        self.run(|remote| remote.create_folder(name, parent_id, operation_id))
    }
    fn update_folder(&mut self, folder_id: &str, name: Option<&str>, parent_id: Option<Option<&str>>, base_revision: u64) -> Result<RemoteFolder, RemoteError> {
        self.run(|remote| remote.update_folder(folder_id, name, parent_id, base_revision))
    }
    fn delete_folder(&mut self, folder_id: &str, base_revision: u64) -> Result<(), RemoteError> {
        self.run(|remote| remote.delete_folder(folder_id, base_revision))
    }
    fn patch_file(&mut self, file_id: &str, name: Option<&str>, folder_id: Option<Option<&str>>, base_revision: u64) -> Result<RemoteFile, RemoteError> {
        self.run(|remote| remote.patch_file(file_id, name, folder_id, base_revision))
    }
    fn delete_file(&mut self, file_id: &str, base_revision: u64) -> Result<(), RemoteError> {
        self.run(|remote| remote.delete_file(file_id, base_revision))
    }
}

fn urlencoding(value: &str) -> String {    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResult {
    pub device: Value,
    pub token: String,
}

pub fn pair_device(service_url: &str, code: &str, device_name: &str, platform: &str, public_key: Option<&str>) -> Result<PairResult, String> {
    let url = format!("{}/devices/pair", service_url.trim_end_matches('/'));
    let parsed = Url::parse(&url).map_err(|error| format!("服务地址非法：{error}"))?;
    if parsed.scheme() != "https" && !is_loopback(&parsed) {
        return Err("生产服务地址必须使用 HTTPS；明文 HTTP 仅允许回环地址".into());
    }
    let client = Client::builder().timeout(Duration::from_secs(20)).build().map_err(|error| error.to_string())?;
    let response = client
        .post(parsed)
        .json(&json!({
            "code": code,
            "deviceName": device_name,
            "platform": platform,
            "protocolVersion": 1,
            "publicKey": public_key
        }))
        .send()
        .map_err(|error| format!("配对请求失败：{error}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(parse_error(status, &text).to_string());
    }
    serde_json::from_str(&text).map_err(|error| format!("配对响应格式非法：{error}"))
}

/// 撤销设备令牌；服务端按设备归属校验，令牌本身即凭据。
pub fn revoke_device(service_url: &str, token: &str, device_id: &str) -> Result<(), String> {
    let remote = HttpRemote::new(service_url, token)?;
    let response = remote
        .request(Method::DELETE, &format!("devices/{}", urlencoding(device_id)))
        .send()
        .map_err(|error| format!("撤销设备请求失败：{error}"))?;
    remote.empty(response).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_plaintext_remote_hosts() {
        assert!(HttpRemote::new("http://example.com", "token").is_err());
        assert!(HttpRemote::new("http://127.0.0.1:8080", "token").is_ok());
        assert!(HttpRemote::new("https://disk.example.com", "token").is_ok());
    }

    #[test]
    fn percent_encodes_path_segments() {
        assert_eq!(urlencoding("a b/c"), "a%20b%2Fc");
    }
}
