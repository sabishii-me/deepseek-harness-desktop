//! 通用内核安装命令：把某个声明式 npm 包安装到托管目录并验证它能运行。
//!
//! 本模块只做「转发到 [`crate::service::kernel::install`] 并把进度推给界面」，
//! **不认识任何具体内核**：包名、版本、入口、探测契约全部由调用方（界面）以数据传入。
//!
//! 进度复用壳层既有的 `preinstall-log` 事件通道（与插件安装同款）：界面在数分钟的
//! 安装期间能拿到逐行输出，不需要另造一套事件。

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, WebviewWindow};

use crate::config::manifest;
use crate::service::kernel::install::{
    install_native_kernel, native_kernel_state, NativeKernelSpec, NativeKernelState,
};

/// 复用插件安装的日志事件名：界面已有一个监听入口，无需新增事件类型。
const PROGRESS_EVENT: &str = "preinstall-log";

/// 某个可选内核的界面视图：清单声明的安装数据 + 当前托管状态。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelDescriptor {
    pub id: String,
    pub name: String,
    pub package: String,
    pub version: Option<String>,
    pub installed: bool,
    pub detected_version: Option<String>,
}

/// 清单声明的全部可选内核及其托管状态（只读）。
///
/// 界面只拿到数据，不需要知道任何具体内核；未声明则返回空列表。
#[tauri::command]
pub async fn get_native_kernels(app_handle: AppHandle) -> Result<Vec<KernelDescriptor>, String> {
    let Some(manifest) = manifest::read(&app_handle) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(manifest.kernels.len());
    for kernel in manifest.kernels {
        let spec = NativeKernelSpec {
            package: kernel.package.clone(),
            version: kernel.version.clone(),
            entry: kernel.entry.clone(),
            probe: crate::service::kernel::install::NativeKernelProbe {
                args: kernel.probe.args.clone(),
                expect: kernel.probe.expect.clone(),
            },
        };
        let state = native_kernel_state(&app_handle, &spec).await;
        out.push(KernelDescriptor {
            id: kernel.id,
            name: kernel.name,
            package: kernel.package,
            version: kernel.version,
            installed: state.installed,
            detected_version: state.version,
        });
    }
    Ok(out)
}

/// 安装清单里声明的某个内核（按 id 查找，参数仍来自清单数据）。
#[tauri::command]
pub async fn install_native_kernel_by_id(
    app_handle: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<NativeKernelState, String> {
    let manifest = manifest::read(&app_handle)
        .ok_or_else(|| "resource manifest is unavailable".to_string())?;
    let kernel = manifest
        .kernels
        .into_iter()
        .find(|kernel| kernel.id == id)
        .ok_or_else(|| format!("unknown native kernel: {id}"))?;
    let spec = NativeKernelSpec {
        package: kernel.package,
        version: kernel.version,
        entry: kernel.entry,
        probe: crate::service::kernel::install::NativeKernelProbe {
            args: kernel.probe.args,
            expect: kernel.probe.expect,
        },
    };
    let sink: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line: &str| {
        let _ = window.emit(PROGRESS_EVENT, serde_json::json!({ "line": line }));
    });
    install_native_kernel(&app_handle, &spec, Some(sink)).await
}

/// 查询某内核的托管安装状态（只读，不触发安装）。
#[tauri::command]
pub async fn get_native_kernel_state(
    app_handle: AppHandle,
    spec: NativeKernelSpec,
) -> Result<NativeKernelState, String> {
    Ok(native_kernel_state(&app_handle, &spec).await)
}

/// 安装（或确认已就绪）某内核；进度经 `preinstall-log` 事件回流。
#[tauri::command]
pub async fn install_native_kernel_package(
    app_handle: AppHandle,
    window: WebviewWindow,
    spec: NativeKernelSpec,
) -> Result<NativeKernelState, String> {
    let sink: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line: &str| {
        let _ = window.emit(PROGRESS_EVENT, serde_json::json!({ "line": line }));
    });
    install_native_kernel(&app_handle, &spec, Some(sink)).await
}
