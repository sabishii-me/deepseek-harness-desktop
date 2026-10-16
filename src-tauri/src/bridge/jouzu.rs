//! Optional, application-owned Jouzu installation. Never modifies global npm.
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;
use tokio::process::Command;
use tokio::sync::Mutex;

static INSTALL: Mutex<()> = Mutex::const_new(());
const VERSION: &str = "0.2.0";

pub(crate) fn managed_entry(app: &AppHandle) -> PathBuf {
    crate::config::get_base_dir(app).join("dependencies/jouzu/node_modules/jouzu/dist/cli.js")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JouzuInstallation {
    pub installed: bool,
    pub managed: bool,
    pub version: String,
    pub external_detected: bool,
}

#[tauri::command]
pub async fn get_jouzu_installation(app: AppHandle) -> Result<JouzuInstallation, String> {
    let installed = managed_entry(&app).is_file() && crate::config::get_base_dir(&app).join("dependencies/jouzu/.verified").is_file();
    // Detection only: never execute, upgrade, or uninstall a user's PATH shim.
    let external_detected = std::env::var_os("PATH").map(|path| {
        std::env::split_paths(&path).filter(|dir| dir.is_absolute()).any(|dir| {
            if cfg!(windows) {
                ["jouzu.exe", "jouzu.cmd", "jouzu.ps1"].iter().any(|name| dir.join(name).is_file())
            } else {
                dir.join("jouzu").is_file()
            }
        })
    }).unwrap_or(false);
    Ok(JouzuInstallation { installed, managed: installed, version: VERSION.into(), external_detected })
}

#[tauri::command]
pub async fn install_optional_jouzu(app: AppHandle) -> Result<JouzuInstallation, String> {
    let _lock = INSTALL.try_lock().map_err(|_| "Jouzu installation already running")?;
    let entry = managed_entry(&app);
    if get_jouzu_installation(app.clone()).await?.installed {
        return get_jouzu_installation(app).await;
    }
    let node = crate::config::get_node_binary_path(&app);
    let base = node.parent().ok_or("Node runtime directory missing")?;
    let candidates = [
        base.join("node_modules/npm/bin/npm-cli.js"),
        base.join("../lib/node_modules/npm/bin/npm-cli.js"),
    ];
    let npm = candidates.into_iter().find(|p| p.is_file())
        .ok_or("Selected Node runtime has no npm. Install Jouzu yourself or choose a Node runtime with npm.")?;
    let root = crate::config::get_base_dir(&app).join("dependencies/jouzu");
    tokio::fs::create_dir_all(&root).await.map_err(|e| e.to_string())?;
    let mut command = Command::new(&node);
    command.arg(npm).args(["install", "--prefix"]).arg(&root)
        .args(["--no-audit", "--no-fund", "--save-exact", &format!("jouzu@{VERSION}")])
        .stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let result = tokio::time::timeout(Duration::from_secs(600), command.output()).await
        .map_err(|_| "Jouzu installation timed out; retry from setup")?
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        let detail = String::from_utf8_lossy(&result.stderr);
        return Err(format!("Jouzu install failed: {}", detail.chars().take(2000).collect::<String>()));
    }
    if !entry.is_file() { return Err("Jouzu installation has no CLI entrypoint".into()); }
    let mut probe = Command::new(node);
    probe.arg(&entry).arg("--version").kill_on_drop(true);
    #[cfg(windows)]
    probe.creation_flags(0x08000000);
    let version = tokio::time::timeout(Duration::from_secs(30), probe.output()).await
        .map_err(|_| "Jouzu version check timed out")?.map_err(|e| e.to_string())?;
    if !version.status.success() { return Err("Jouzu version check failed".into()); }
    let mut protocol = Command::new(crate::config::get_node_binary_path(&app));
    protocol.arg(&entry).args(["pi", "--help"]).kill_on_drop(true);
    #[cfg(windows)]
    protocol.creation_flags(0x08000000);
    let help = tokio::time::timeout(Duration::from_secs(30), protocol.output()).await
        .map_err(|_| "Jouzu RPC capability check timed out")?.map_err(|e| e.to_string())?;
    if !help.status.success() || !String::from_utf8_lossy(&help.stdout).contains("rpc") {
        return Err("Installed Jouzu does not advertise RPC mode".into());
    }
    tokio::fs::write(root.join(".verified"), VERSION).await.map_err(|e| e.to_string())?;
    get_jouzu_installation(app).await
}
