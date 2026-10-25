//! 通用版与北大版的同步网络策略。
//!
//! 构建期用 Cargo feature 选择实现，运行期只决定“走哪条传输路径”，
//! 不创建第二份数据：两条路径必须指向同一服务实例、同一同步纪元与游标。

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointKind {
    Direct,
    Campus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub url: String,
    pub kind: EndpointKind,
}

impl fmt::Display for EndpointKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EndpointKind::Direct => write!(f, "direct"),
            EndpointKind::Campus => write!(f, "campus"),
        }
    }
}

pub trait Strategy {
    /// 制品名，用于状态展示与构建校验。
    fn name(&self) -> &'static str;
    /// 是否包含校园网络实现；通用制品必须为 false。
    fn includes_campus(&self) -> bool;
    /// 按优先级返回端点。所有端点共用同一凭据与同一服务端数据。
    fn endpoints(&self, direct: &str, campus: Option<&str>) -> Result<Vec<Endpoint>, String>;
}

#[cfg(all(feature = "generic", not(feature = "pku")))]
mod selected {
    use super::*;

    pub struct GenericStrategy;

    impl Strategy for GenericStrategy {
        fn name(&self) -> &'static str { "generic" }
        fn includes_campus(&self) -> bool { false }
        fn endpoints(&self, direct: &str, campus: Option<&str>) -> Result<Vec<Endpoint>, String> {
            if campus.is_some() {
                return Err("通用版不包含校园网络策略，不能配置校园端点".into());
            }
            Ok(vec![Endpoint { url: direct.trim_end_matches('/').to_string(), kind: EndpointKind::Direct }])
        }
    }
}

#[cfg(feature = "pku")]
mod selected {
    use super::*;

    /// 北大版：优先直连，校园链路作为可配置的故障转移路径。
    /// 两条路径必须使用同一部署服务与同一设备令牌。
    pub struct PkuStrategy;

    impl Strategy for PkuStrategy {
        fn name(&self) -> &'static str { "pku" }
        fn includes_campus(&self) -> bool { true }
        fn endpoints(&self, direct: &str, campus: Option<&str>) -> Result<Vec<Endpoint>, String> {
            let mut endpoints = vec![Endpoint {
                url: direct.trim_end_matches('/').to_string(),
                kind: EndpointKind::Direct,
            }];
            if let Some(campus) = campus.map(str::trim).filter(|value| !value.is_empty()) {
                let campus = campus.trim_end_matches('/').to_string();
                if campus == endpoints[0].url {
                    return Ok(endpoints);
                }
                validate_transport(&campus)?;
                endpoints.push(Endpoint { url: campus, kind: EndpointKind::Campus });
            }
            Ok(endpoints)
        }
    }
}

#[cfg(all(feature = "generic", feature = "pku"))]
compile_error!("generic 与 pku 策略不能同时启用；请用 --no-default-features --features pku 构建北大版");

#[cfg(not(any(feature = "generic", feature = "pku")))]
compile_error!("必须选择一种同步策略：generic 或 pku");

#[cfg(all(feature = "generic", not(feature = "pku")))]
pub fn selected() -> impl Strategy { selected::GenericStrategy }

#[cfg(feature = "pku")]
pub fn selected() -> impl Strategy { selected::PkuStrategy }

/// 传输层安全检查：生产端点必须 HTTPS，明文只允许回环。
pub fn validate_transport(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if lower.starts_with("http://") {
        let rest = &lower["http://".len()..];
        let host = rest.split(['/', ':']).next().unwrap_or("");
        if matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1") {
            return Ok(());
        }
        return Err("生产服务地址必须使用 HTTPS；明文 HTTP 仅允许回环地址".into());
    }
    Err("服务地址必须以 https:// 开头".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_strategy_matches_build() {
        let strategy = selected();
        if cfg!(feature = "pku") {
            assert_eq!(strategy.name(), "pku");
            assert!(strategy.includes_campus());
        } else {
            assert_eq!(strategy.name(), "generic");
            assert!(!strategy.includes_campus());
            assert!(strategy.endpoints("https://disk.example.com", Some("https://campus.example.com")).is_err());
        }
    }

    #[test]
    fn endpoint_order_keeps_single_identity() {
        let strategy = selected();
        let endpoints = strategy.endpoints("https://disk.example.com/", None).unwrap();
        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0].url, "https://disk.example.com");
        assert!(validate_transport("http://example.com").is_err());
        assert!(validate_transport("http://127.0.0.1:8080").is_ok());
    }
}
