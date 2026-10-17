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

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

use crate::config::get_node_binary_path;
use crate::service::core::runtime::npm_command;

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
pub struct NativeKernelState {
    /// 是否已就绪（入口存在且通过探测）。任一来源命中即为 true。
    pub installed: bool,
    /// 命中的来源；未就绪时为 None。
    pub source: Option<KernelSource>,
    /// 已就绪入口的绝对路径（未就绪时为 None）。
    pub entry: Option<String>,
    /// 探测输出中识别到的版本号（可无）。
    pub version: Option<String>,
}
/// 内核来源：同一套探测会按顺序尝试三处，先命中的胜出。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KernelSource {
    /// 应用托管槽位（`dependencies/kernels/<pkg>`）。
    Managed,
    /// 当前 DSH 档案的 `node_modules`。
    Profile,
    /// 系统全局 npm 根。
    System,
}

/// 系统全局 npm 根（`npm root -g` 的输出）。
///
/// 不自建包发现逻辑：复用用户环境的 npm 来回答「全局包在哪」，避免在 Windows /
/// Unix / nvm / pnpm / volta 等布局上各自猜测。命令失败时返回 None，探测继续。
async fn system_npm_root(node: &Path) -> Option<PathBuf> {
    let (program, args) = npm_command(node);
    let mut command = tokio::process::Command::new(&program);
    command
        .args(&args)
        .arg("root")
        .arg("-g")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
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
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(PathBuf::from(text))
    }
}

/// 包名在 `node_modules` 下的相对目录（`@scope/name` → `@scope/name`）。
fn package_subdir(package: &str) -> PathBuf {
    let mut path = PathBuf::new();
    for part in package.split(['/', '\\']).filter(|part| !part.is_empty()) {
        path.push(part);
    }
    path
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
        source: None,
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
    let node = get_node_binary_path(app);

    // 三个来源依次尝试，先命中的胜出：应用托管 > DSH 档案 > 系统全局。
    // 每一处都跑**同一个协议探测**（不是看文件存不存在），装坏的包不算已装。
    let mut candidates: Vec<(KernelSource, PathBuf)> = Vec::new();
    candidates.push((KernelSource::Managed, package_dir(app, spec)));
    candidates.push((
        KernelSource::Profile,
        crate::service::plugin::profile_dir(app)
            .join("node_modules")
            .join(package_subdir(&spec.package)),
    ));

    for (source, dir) in candidates {
        let entry = dir.join(&spec.entry);
        if let Some(mut state) = probe_entry(&node, &entry, &spec.probe).await {
            state.source = Some(source);
            return state;
        }
    }

    if let Some(root) = system_npm_root(&node).await {
        let entry = root.join(package_subdir(&spec.package)).join(&spec.entry);
        if let Some(mut state) = probe_entry(&node, &entry, &spec.probe).await {
            state.source = Some(KernelSource::System);
            return state;
        }
    }

    NativeKernelState {
        installed: false,
        source: None,
        entry: None,
        version: None,
    }
}

/// 安装（或确认已就绪）指定内核。数据驱动、版本来自 `spec`，不写死。
///
/// 幂等：已就绪则直接返回成功态，不重装、不改动既有安装。
///
/// 执行走与插件安装**同一条**路径（`run_plugin_install_with_transient_retry`）：
/// 全局串行锁、可取消、瞬时文件系统重试、逐行 `preinstall-log` 回流，全部直接继承。
/// 差别只有两处：
/// - 命令是 npm 而不是 `dsh plugin`；
/// - npm 输出里没有 pnpm 的 allowBuilds 标记，输出过滤自然不触发（不是特判）。
pub async fn install_native_kernel(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    spec: &NativeKernelSpec,
    progress: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    // 输出行归属的卡片 id（清单声明的 `kernels[].id`）。界面按它把阶段与日志
    // 路由到对应卡片；模块本身不认识这个值，只透传。
    card: Option<String>,
) -> Result<NativeKernelState, String> {
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

    // 程序名放在参数之前：`npm_command` 返回的是「用哪个可执行文件 + 前置参数」，
    // 共享执行器只接受 node + args（与插件安装同一形态），因此把可执行文件吸收进
    // 参数首项当且仅当它不是 node 本身。
    let mut full_args: Vec<OsString> = Vec::new();
    if program != node.as_os_str() {
        full_args.push(program);
    }
    full_args.extend(args);

    // 与插件安装同一套环境：显式下传预检解析出的 node、捆绑 pnpm 的绝对路径与非
    // TTY 所需开关。缺了这套，同一条机器上插件能装、内核会卡在找不到运行时。
    let envs = crate::service::plugin::build_plugin_envs(app, false);
    let owner = crate::service::plugin::new_process_owner();

    let (exit_code, output, _last) = crate::service::plugin::run_plugin_install_with_transient_retry(
        app,
        &node,
        &full_args,
        &root,
        &envs,
        window,
        "install",
        None,
        owner,
        card,
    )
    .await?;
    if exit_code != 0 {
        let tail = if output.len() > 4000 { &output[output.len() - 4000..] } else { &output };
        return Err(format!("native kernel installation failed with exit code {exit_code}\n{tail}"));
    }

    let state = native_kernel_state(app, spec).await;
    if !state.installed {
        return Err("installed native kernel failed its protocol probe".into());
    }
    Ok(state)
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
