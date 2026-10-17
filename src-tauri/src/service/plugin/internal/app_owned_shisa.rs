//! 清理本应用早期写入的两个 Shisa 资源链接。
//!
//! 背景：**本应用**（不是用户）曾在 profile 里写过
//! `link:<resources>/node_modules/shisa-provider` 与 `.../shisa-ui` 两个依赖，并把它们
//! 登记进 `dsh.profile.bundles`。这两份资源随插件改为内置/独立发布后已不再随包分发，
//! 于是 profile 里留下**指向不存在目录**的 `link:` 依赖与 bundle 登记。
//!
//! 这类悬空引用的通用清理逻辑（`prune_dangling_link_deps`）会**故意跳过**官方作用域的
//! 包名（`@deepseek-ai/*`），以免误删用户自己安装的核心包；因此这两个本应用自己留下的
//! 引用没有任何通用路径可以清掉，会导致 `dsh plugin install` 解析 bundle 失败、服务起不来。
//!
//! 本模块只认**精确等于本应用资源目录**的那两个 `link:` 值：
//! - 用户指向别处（含用户自装同名包）→ 不动；
//! - registry / git spec → 不动；
//! - 凭据、会话、patch 层、node_modules → 从不触碰。
//!
//! 一次性：改完写备份，重复执行无副作用。

use std::path::Path;

use serde_json::Value;

/// 本应用曾写入的两个资源链接：包名 ↔ 随包资源子目录。
const LEGACY_LINKS: [(&str, &str); 2] = [
    (
        "@deepseek-ai/dsh-experimental-shisa-provider",
        "shisa-provider",
    ),
    ("@deepseek-ai/dsh-experimental-shisa-ui", "shisa-ui"),
];

pub(super) fn migrate(profile: &Path, resources: &Path) -> Result<(), String> {
    let path = profile.join("package.json");
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("APP_OWNED_SHISA_READ_FAILED: {e}")),
    };
    let mut manifest: Value =
        serde_json::from_slice(&raw).map_err(|e| format!("APP_OWNED_SHISA_PARSE_FAILED: {e}"))?;
    let removed = repair(&mut manifest, resources);
    if removed.is_empty() {
        return Ok(());
    }
    // Exclusive backup creation: never overwrite the original recovery copy.
    use std::io::Write;
    let backup = profile.join("package.json.before-shisa-cleanup.bak");
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup)
    {
        Ok(mut file) => {
            file.write_all(&raw)
                .and_then(|_| file.sync_all())
                .map_err(|e| format!("APP_OWNED_SHISA_BACKUP_FAILED: {e}"))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("APP_OWNED_SHISA_BACKUP_FAILED: {e}")),
    }
    super::manifest::write_profile_manifest(&path, &manifest)?;
    log::info!(
        "APP_OWNED_SHISA_CLEANED: removed app-owned bundle references {:?}; backup={}",
        removed,
        backup.display()
    );
    Ok(())
}

/// 归一化路径用于精确比较：正反斜杠统一、去掉 Windows verbatim 前缀与尾斜杠，
/// Windows 上再按小写比较（文件系统大小写不敏感）。
fn normalize(value: &str) -> String {
    let value = value.replace('\\', "/");
    let value = value.trim_start_matches("//?/").trim_end_matches('/');
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value.to_string()
    }
}

fn repair(manifest: &mut Value, resources: &Path) -> Vec<String> {
    let mut removed = Vec::new();
    for (name, folder) in LEGACY_LINKS {
        let expected = normalize(&resources.join("node_modules").join(folder).to_string_lossy());
        let owned = manifest
            .get("dependencies")
            .and_then(|v| v.get(name))
            .and_then(Value::as_str)
            .and_then(|s| s.strip_prefix("link:"))
            .is_some_and(|s| normalize(s) == expected);
        if !owned {
            continue;
        }
        if let Some(deps) = manifest.get_mut("dependencies").and_then(Value::as_object_mut) {
            deps.remove(name);
        }
        if let Some(bundles) = manifest
            .pointer_mut("/dsh/profile/bundles")
            .and_then(Value::as_array_mut)
        {
            bundles.retain(|v| v.as_str() != Some(name));
        }
        removed.push(name.to_string());
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_owned_links_only_and_idempotent() {
        let root = std::env::temp_dir().join("sabishii-cleanup-fixture");
        let name = "@deepseek-ai/dsh-experimental-shisa-provider";
        let mut m = json!({"dependencies":{name:format!("link:{}", root.join("node_modules/shisa-provider").display()),"@deepseek-ai/dsh-experimental-shisa-ui":"^0.2.1","other":"link:/missing/user"},"dsh":{"profile":{"bundles":[name,"@deepseek-ai/dsh-experimental-shisa-ui","other"]}},"custom":{"keep":true}});
        assert_eq!(repair(&mut m, &root), vec![name]);
        assert!(repair(&mut m, &root).is_empty());
        assert_eq!(
            m["dsh"]["profile"]["bundles"],
            json!(["@deepseek-ai/dsh-experimental-shisa-ui", "other"])
        );
        assert_eq!(m["custom"], json!({ "keep": true }));
        assert_eq!(m["dependencies"]["other"], "link:/missing/user");
    }

    #[test]
    fn file_migration_preserves_original_backup_and_new_optional_package() {
        let dir = std::env::temp_dir().join(format!(
            "shisa-cleanup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let resources = dir.join("app/resources");
        let old = "@deepseek-ai/dsh-experimental-shisa-provider";
        let new = "@sabishii-me/dsh-model-provider-shisa";
        let original = serde_json::to_vec(&json!({"dependencies":{old:format!("link:{}",resources.join("node_modules/shisa-provider").display()),new:"https://example.test/plugin.tgz"},"dsh":{"profile":{"bundles":[old]}}})).unwrap();
        std::fs::write(dir.join("package.json"), &original).unwrap();
        migrate(&dir, &resources).unwrap();
        assert_eq!(
            std::fs::read(dir.join("package.json.before-shisa-cleanup.bak")).unwrap(),
            original
        );
        let repaired: Value =
            serde_json::from_slice(&std::fs::read(dir.join("package.json")).unwrap()).unwrap();
        assert_eq!(repaired["dependencies"][new], "https://example.test/plugin.tgz");
        assert_eq!(repaired["dsh"]["profile"]["bundles"], json!([]));
        migrate(&dir, &resources).unwrap();
        assert_eq!(
            std::fs::read(dir.join("package.json.before-shisa-cleanup.bak")).unwrap(),
            original
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn never_removes_same_named_user_link() {
        let mut m = json!({"dependencies":{"@deepseek-ai/dsh-experimental-shisa-provider":"link:/user/source"}});
        let original = m.clone();
        assert!(repair(&mut m, Path::new("/app/resources")).is_empty());
        assert_eq!(m, original);
    }
}
