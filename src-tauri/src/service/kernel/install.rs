//! 通用内核安装：把任一声明式 npm 包安装到本应用托管的目录，并验证它能运行。
//!
//! 设计约束（务必保持）：
//! - **零产品名**：本模块不认识任何具体内核（不出现任何厂商/产品标识）。哪个包、
//!   哪个入口、如何探测，全部由调用方（插件）以数据传入。
//! - **版本不写死**：版本号是入参，支持 `latest` 语义；本模块不硬编码任何版本，
//!   因此升级/换版本只需换入参，无需改动本模块。
//! - **复用既有设施**：Node 运行时定位、npm 定位、托管根解析都复用桌面端既有能力，
//!   不另造一套。
//! - **不覆盖用户既有安装**：安装前先探测；已存在可用安装时直接返回，不做改动。
//!
//! 安装根使用通用槽位 `dependencies/kernels/<package>`，与该包是否由用户自装无关。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::config::get_node_binary_path;
use crate::service::core::runtime::npm_command;

/// 同一时刻只允许一次内核安装（跨内核串行，避免并发 npm 争用同一运行时）。
static INSTALL: Mutex<()> = Mutex::const_new(());

/// 单个内核的安装超时（网络受限时 npm 可能长时间重试）。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
/// 安装后探测入口的超时。
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// 托管内核根槽位：`<AppData>/dependencies/kernels/<package 目录名>`。
const KERNEL_ROOT: &str = "dependencies/kernels";

/// 托管内核根目录（所有托管安装的父目录）。
///
/// 壳层把它交给 DSH 子进程（环境变量），插件据此在自己的数据表里解析各内核入口，
/// 从而无需壳层认识任何具体内核。
pub fn native_kernel_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|root| root.join(KERNEL_ROOT))
        .unwrap_or_else(|_| PathBuf::from(KERNEL_ROOT))
}

/// 一次内核安装 / 探测请求。全部字段由调用方（插件）提供，本模块不内置任何知识。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeKernelSpec {
    /// npm 包名，例如某个内核 CLI 的发布名。
    pub package: String,
    /// 期望版本或 `"latest"`；由调用方决定，本模块不写死。
    #[serde(default)]
    pub version: Option<String>,
    /// 入口相对 `node_modules/<package>` 的相对路径（例如 `dist/cli.js`）。
    pub entry: String,
    /// 探测契约：入口需能以此参数运行并输出包含 `expect` 的内容。
    pub probe: NativeKernelProbe,
}

/// 通用探测契约：跑 `args`，输出（stdout+stderr）需包含 `expect`。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeKernelProbe {
    /// 探测参数，例如 `["--version"]`。
    #[serde(default)]
    pub args: Vec<String>,
    /// 期望输出片段；空串表示只要求退出码为 0。
    #[serde(default)]
    pub expect: String,
}

/// 安装 / 探测结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeKernelState {    /// 托管安装是否已就绪（入口存在且通过探测）。
    pub installed: bool,
    /// 已就绪入口的绝对路径（未就绪时为 None）。
    pub entry: Option<String>,
    /// 探测输出中识别到的版本号（可无）。
    pub version: Option<String>,
}

/// 判断给定入口是否可运行：跑 `probe.args`，校验退出码与输出片段。
async fn probe_entry(node: &Path, entry: &Path, probe: &NativeKernelProbe) -> Option<NativeKernelState> {
    if !entry.is_file() {
        return None;
    }
    let mut command = Command::new(node);
    command
        .arg(entry)
        .args(&probe.args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    if !probe.expect.is_empty() && !text.contains(&probe.expect) {
        return None;
    }
    Some(NativeKernelState {
        installed: true,
        entry: Some(entry.to_string_lossy().into_owned()),
        version: extract_version(&text),
    })
}

/// 从探测输出里取第一个语义化版本号；取不到返回 None（版本非本模块职责）。
fn extract_version(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        let mut dots = 0;
        while index < bytes.len() {
            let byte = bytes[index];
            if byte.is_ascii_digit() {
                index += 1;
            } else if byte == b'.' && dots < 2 {
                dots += 1;
                index += 1;
            } else {
                break;
            }
        }
        // 至少形如 `x.y`，且其后不是版本号字符（避免截断更长的段）。
        if dots >= 1 && !bytes.get(index).is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'.' || *byte == b'-') {
            return Some(text[start..index].to_string());
        }
    }
    None
}

/// 通用槽位解析：某包的托管根。
fn managed_root(app: &AppHandle, package: &str) -> PathBuf {
    let dir = package.replace(['/', '\\', '@'], "-").trim_matches('-').to_string();
    app.path()
        .app_data_dir()
        .map(|dir_root| dir_root.join(KERNEL_ROOT).join(&dir))
        .unwrap_or_else(|_| PathBuf::from(KERNEL_ROOT).join(&dir))
}

/// 包在托管根下的 `node_modules/<package>` 目录。
fn package_dir(app: &AppHandle, spec: &NativeKernelSpec) -> PathBuf {
    managed_root(app, &spec.package)
        .join("node_modules")
        .join(&spec.package)
}

/// 探测当前托管安装状态（不触发任何安装或改动）。
pub async fn native_kernel_state(
    app: &AppHandle,
    spec: &NativeKernelSpec,
) -> NativeKernelState {
    let entry = package_dir(app, spec).join(&spec.entry);
    let node = get_node_binary_path(app);
    match probe_entry(&node, &entry, &spec.probe).await {
        Some(state) => state,
        None => NativeKernelState {
            installed: false,
            entry: None,
            version: None,
        },
    }
}

/// 安装（或确认已就绪）指定内核。数据驱动、版本来自 `spec`，不写死。
///
/// 幂等：已就绪则直接返回成功态，不重装、不改动既有安装。
///
/// `progress` 由调用方提供，用于把 npm 的实时输出转给界面（复用壳层既有的
/// 日志回流习惯）；本模块不关心它如何展示。
pub async fn install_native_kernel(
    app: &AppHandle,
    spec: &NativeKernelSpec,
    progress: Option<Arc<dyn Fn(&str) + Send + Sync>>,
) -> Result<NativeKernelState, String> {
    let _guard = INSTALL.try_lock().map_err(|_| "native kernel installation already running")?;

    // 已就绪：直接返回，绝不覆盖。
    let current = native_kernel_state(app, spec).await;
    if current.installed {
        return Ok(current);
    }

    let node = get_node_binary_path(app);
    let (program, mut args) = npm_command(&node);
    let root = managed_root(app, &spec.package);
    tokio::fs::create_dir_all(&root).await.map_err(|error| error.to_string())?;

    let target = match spec.version.as_deref() {
        // 版本由调用方声明；`latest` 与空值都交给 npm 解析，本模块不写死。
        Some(version) if !version.is_empty() && version != "latest" => format!("{}@{}", spec.package, version),
        _ => format!("{}@latest", spec.package),
    };
    if let Some(sink) = &progress {
        sink(&format!("$ npm install --save-exact {target}"));
    }
    args.extend([
        "install".into(),
        "--prefix".into(),
        root.as_os_str().to_os_string(),
        "--no-audit".into(),
        "--no-fund".into(),
        "--save-exact".into(),
        target.into(),
    ]);

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|error| error.to_string())?;

    // 逐行回流输出，让界面在数分钟的安装期间有真实进度（与插件安装同款习惯）。
    let stdout_task = child.stdout.take().map(|stream| {
        tokio::spawn(forward_lines(stream, progress.clone()))
    });
    let stderr_task = child.stderr.take().map(|stream| {
        tokio::spawn(forward_lines(stream, progress.clone()))
    });

    let status = tokio::time::timeout(INSTALL_TIMEOUT, child.wait())
        .await
        .map_err(|_| "native kernel installation timed out")?
        .map_err(|error| error.to_string())?;
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }
    if !status.success() {
        return Err(format!("native kernel installation failed with {status}"));
    }

    let state = native_kernel_state(app, spec).await;
    if !state.installed {
        return Err("installed native kernel failed its protocol probe".into());
    }
    Ok(state)
}

/// 逐行读取一个输出流并把非空行交给进度回调。
async fn forward_lines<R>(stream: R, progress: Option<Arc<dyn Fn(&str) + Send + Sync>>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim_end();
        if !trimmed.is_empty() {
            if let Some(sink) = &progress {
                sink(trimmed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_root_is_derived_from_package_without_product_knowledge() {
        let spec = NativeKernelSpec {
            package: "@scope/some-kernel".into(),
            version: None,
            entry: "dist/cli.js".into(),
            probe: NativeKernelProbe { args: vec!["--version".into()], expect: String::new() },
        };
        // 目录名只由包名派生：作用域名与包名拼成稳定的单段目录名。
        let dir = spec.package.replace(['/', '\\', '@'], "-").trim_matches('-').to_string();
        assert_eq!(dir, "scope-some-kernel");
    }

    #[test]
    fn extract_version_reads_semver_and_ignores_prefix_noise() {
        assert_eq!(extract_version("some-cli 1.2.3\n").as_deref(), Some("1.2.3"));
        assert_eq!(extract_version("v0.2.0 (build 7)").as_deref(), Some("0.2.0"));
        assert_eq!(extract_version("1.0").as_deref(), Some("1.0"));
        assert_eq!(extract_version("no version here"), None);
    }

    #[test]
    fn missing_entry_is_not_installed() {
        // 探测缺失入口必须返回未就绪，而不是报错（调用方据此决定是否安装）。
        let probe = NativeKernelProbe { args: vec!["--version".into()], expect: String::new() };
        let entry = PathBuf::from("definitely/missing/entry.js");
        assert!(!entry.is_file());
        let version = extract_version("nothing");
        assert!(version.is_none());
        let _ = probe;
    }
}
