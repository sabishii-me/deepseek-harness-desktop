//! `remote-call` 步骤的通用执行器。
//!
//! 本模块把「调用某个 Remote 方法并按其返回值判定完成」这套动作抽成与产品无关的
//! 实现：命名空间、方法名、判定字段与取值**全部来自清单配置**。这里不出现任何
//! 具体 provider 的名字、状态字面量或包名。
//!
//! 传输契约来自 DSH 的 Connection RPC（实测）：
//!
//! ```text
//! POST /api/<namespace>/<method>
//! Authorization: Bearer <token>
//! {"type":"client-request","rpcId":"<uuid>","method":"<ns>/<method>","payload":{"args":{}}}
//! ```
//!
//! 响应 `{"type":"server-response","rpcId":"...","result":{"ok":true,"value":...}}`。
//!
//! 三个约束（`gateway/src/index.ts:328` 与实测）：
//! 1. endpoint 必须是 `<ns>/<method>` 两段；
//! 2. `payload` 必须是含单个 `args` 纯对象的对象；
//! 3. 需要会话 token。

use std::time::Duration;

use serde_json::{Value, json};

use crate::config::onboarding::{RemoteCallSpec, RemoteReadyRule};

/// 单次 RPC 的超时：状态轮询要快，发起授权只等请求本身（授权在后台继续）。
const RPC_TIMEOUT: Duration = Duration::from_secs(20);

/// 调用结果里可取出的值。
#[derive(Debug, Clone, PartialEq)]
pub enum RemoteOutcome {
    /// RPC 成功，`value` 是服务返回值。
    Value(Value),
    /// RPC 返回业务错误（`result.ok == false`）。
    Failure(String),
}

/// 拼接 endpoint 并校验「必须是两段」这一 Host 硬约束。
///
/// 提前在本地拒绝，免得把非法 endpoint 发出去换一个难懂的 404。
pub fn endpoint_of(namespace: &str, method: &str) -> Result<String, String> {
    let namespace = namespace.trim();
    let method = method.trim();
    if namespace.is_empty() || method.is_empty() {
        return Err("ONBOARDING_REMOTE_ENDPOINT_EMPTY".to_string());
    }
    // Host 按 `/` 切段并要求恰好两段；命名空间或方法自带 `/` 就无法表达。
    if namespace.contains('/') || method.contains('/') {
        return Err(format!(
            "ONBOARDING_REMOTE_ENDPOINT_INVALID: {namespace}/{method}"
        ));
    }
    Ok(format!("{namespace}/{method}"))
}

/// 按配置的 `path` 取字段并和 `equals` 比较。
///
/// `path` 目前只支持单层字段名；缺失或类型不符都视为「未完成」，不猜测。
pub fn ready(rule: &RemoteReadyRule, value: &Value) -> bool {
    value
        .get(rule.path.trim())
        .and_then(Value::as_str)
        .is_some_and(|actual| actual == rule.equals)
}

/// 构造 DSH Connection RPC 的请求体。
pub fn request_body(endpoint: &str, rpc_id: &str) -> Value {
    json!({
        "type": "client-request",
        "rpcId": rpc_id,
        "method": endpoint,
        "payload": { "args": {} },
    })
}

/// 从 `{"result":{"ok":true,"value":...}}` 解出结果。
///
/// 契约不符（缺 `result`、`ok` 非 true）时给出明确错误，不静默当成空值——
/// 否则界面会把「调用失败」显示成「未登录」，用户无从判断。
pub fn parse_response(body: &Value) -> RemoteOutcome {
    let Some(result) = body.get("result") else {
        return RemoteOutcome::Failure(
            body.get("message")
                .and_then(Value::as_str)
                .unwrap_or("REMOTE_RESPONSE_INVALID: missing result")
                .to_string(),
        );
    };
    match result.get("ok").and_then(Value::as_bool) {
        Some(true) => RemoteOutcome::Value(result.get("value").cloned().unwrap_or(Value::Null)),
        Some(false) => RemoteOutcome::Failure(
            result
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("REMOTE_CALL_FAILED")
                .to_string(),
        ),
        None => RemoteOutcome::Failure("REMOTE_RESPONSE_INVALID: result.ok missing".to_string()),
    }
}

/// 发起一次 Remote 方法调用。
///
/// `token` 是 DSH 会话 token（启动 URL 中带）；`base` 形如 `http://127.0.0.1:3080`。
pub async fn call(
    base: &str,
    token: &str,
    namespace: &str,
    method: &str,
) -> Result<RemoteOutcome, String> {
    let endpoint = endpoint_of(namespace, method)?;
    let url = format!("{}/api/{endpoint}", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(RPC_TIMEOUT)
        .build()
        .map_err(|error| format!("ONBOARDING_REMOTE_CLIENT_FAILED: {error}"))?;
    let response = client
        .post(&url)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .json(&request_body(&endpoint, &rpc_id()))
        .send()
        .await
        .map_err(|error| format!("ONBOARDING_REMOTE_REQUEST_FAILED: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("ONBOARDING_REMOTE_BODY_FAILED: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "ONBOARDING_REMOTE_HTTP_{}: {}",
            status.as_u16(),
            String::from_utf8_lossy(&bytes)
        ));
    }
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("ONBOARDING_REMOTE_JSON_FAILED: {error}"))?;
    Ok(parse_response(&body))
}

/// 读一次状态并按配置判定是否完成。
///
/// 返回 `Ok(true)` 表示该步骤已完成；`Ok(false)` 表示仍需等待/操作；
/// `Err` 是传输或契约错误（调用方据此显示可读错误，而不是当作未完成）。
pub async fn probe(
    base: &str,
    token: &str,
    spec: &RemoteCallSpec,
) -> Result<bool, String> {
    match call(base, token, &spec.namespace, &spec.state).await? {
        RemoteOutcome::Value(value) => Ok(ready(&spec.ready, &value)),
        RemoteOutcome::Failure(message) => Err(message),
    }
}

/// 发起授权动作（若配置了 `sign_in` 方法）。
pub async fn sign_in(
    base: &str,
    token: &str,
    spec: &RemoteCallSpec,
) -> Result<(), String> {
    let Some(method) = spec.sign_in.as_deref() else {
        return Err("ONBOARDING_REMOTE_NO_SIGN_IN".to_string());
    };
    match call(base, token, &spec.namespace, method).await? {
        RemoteOutcome::Value(_) => Ok(()),
        RemoteOutcome::Failure(message) => Err(message),
    }
}

/// 随机 uuid v4 形态的 rpcId（无第三方依赖：按 RFC 4122 从随机字节拼装）。
fn rpc_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let mix = (nanos as u64) ^ ((nanos >> 64) as u64) ^ (std::process::id() as u64);
    // 仅需唯一性与形态合法；rpcId 的语义是「配对单次应答」，不参与鉴权。
    let a = mix & 0xffff_ffff;
    let b = (mix >> 32) & 0xffff;
    let c = ((mix >> 16) & 0x0fff) | 0x4000;
    let d = ((mix >> 8) & 0x3fff) | 0x8000;
    let e = (mix.rotate_left(17)) & 0xffff_ffff_ffff;
    format!("{a:08x}-{b:04x}-{c:04x}-{d:04x}-{e:012x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(path: &str, equals: &str) -> RemoteReadyRule {
        RemoteReadyRule { path: path.to_string(), equals: equals.to_string() }
    }

    #[test]
    fn builds_a_two_segment_endpoint() {
        assert_eq!(endpoint_of("any-ns", "readState").unwrap(), "any-ns/readState");
    }

    #[test]
    fn rejects_endpoints_the_host_would_404() {
        // Host 只接受恰好两段，多余的分隔符必须提前拦下。
        assert!(endpoint_of("ns", "a/b").is_err());
        assert!(endpoint_of("ns/x", "a").is_err());
        assert!(endpoint_of("", "a").is_err());
        assert!(endpoint_of("ns", "  ").is_err());
    }

    #[test]
    fn request_payload_has_a_single_args_object() {
        // 实测：payload 不是 `{args:{}}` 时 Host 直接拒绝。
        let body = request_body("ns/m", "id-1");
        assert_eq!(body["type"], "client-request");
        assert_eq!(body["method"], "ns/m");
        assert_eq!(body["rpcId"], "id-1");
        assert_eq!(body["payload"], json!({ "args": {} }));
        assert!(
            body["payload"].as_object().unwrap().len() == 1,
            "host requires exactly one plain-object args field"
        );
    }

    #[test]
    fn ready_matches_the_configured_field_only() {
        let value = json!({ "phase": "done", "other": "done" });
        assert!(ready(&rule("phase", "done"), &value));
        assert!(!ready(&rule("phase", "waiting"), &value));
        assert!(!ready(&rule("missing", "done"), &value));
    }

    #[test]
    fn ready_never_guesses_on_wrong_types() {
        let value = json!({ "count": 3, "flag": true });
        assert!(!ready(&rule("count", "3"), &value));
        assert!(!ready(&rule("flag", "true"), &value));
    }

    #[test]
    fn parses_a_successful_response() {
        let body = json!({ "type": "server-response", "result": { "ok": true, "value": { "phase": "ready" } } });
        assert_eq!(parse_response(&body), RemoteOutcome::Value(json!({ "phase": "ready" })));
    }

    #[test]
    fn parses_a_business_failure() {
        let body = json!({ "result": { "ok": false, "error": { "message": "nope" } } });
        assert_eq!(parse_response(&body), RemoteOutcome::Failure("nope".to_string()));
    }

    #[test]
    fn a_malformed_response_is_a_failure_not_an_empty_value() {
        // 关键：不能把契约错误当成「未完成」，否则界面会误报「未登录」。
        assert!(matches!(parse_response(&json!({})), RemoteOutcome::Failure(_)));
        assert!(matches!(
            parse_response(&json!({ "result": {} })),
            RemoteOutcome::Failure(_)
        ));
    }

    #[test]
    fn rpc_ids_have_uuid_shape_and_differ() {
        let first = rpc_id();
        let second = rpc_id();
        assert_eq!(first.len(), 36, "uuid shape: {first}");
        assert_eq!(first.matches('-').count(), 4);
        assert_ne!(first, second);
    }
}
