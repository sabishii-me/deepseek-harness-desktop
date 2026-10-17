//! Onboarding 进度与步骤配置。
//!
//! 两个职责，都与具体产品无关：
//!
//! 1. **步骤配置**：从资源清单的 `onboarding.steps` 读出「有哪些步骤」。宿主只认
//!    [`OnboardingKind`] 这几种通用动作类型，不认识任何具体插件/产品。不配置某一步，
//!    那一步就不存在。
//! 2. **进度状态**：读写应用数据目录下的 `onboarding.json`，形如
//!    `{"version":1,"completed":["plugins","kernel"],"finished_at":null}`。
//!
//! 进度用**步骤 id 的集合**而不是一组布尔字段：新增步骤时旧用户自动视为「未完成」，
//! 删除步骤后残留的 id 被忽略，两者都不需要改代码。这是与 `setting.rs` 里那些
//! 一次性布尔标记的本质区别。
//!
//! 声明式判定：步骤是否完成只看「id 是否在 `completed` 里」，不看任何业务语义。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// 进度文件在应用数据目录下的文件名。
const STATE_FILE: &str = "onboarding.json";
/// 当前状态格式版本；结构不兼容变更时递增，读到更低版本按空进度处理。
const STATE_VERSION: u32 = 1;

/// 宿主支持的通用步骤动作类型。
///
/// 新增一种动作类型需要宿主实现对应的执行器；新增**某个具体步骤**则只需改清单。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OnboardingKind {
    /// 让用户挑选并安装推荐插件。
    PluginSelection,
    /// 安装清单声明的一个可选原生内核。
    NativeKernel,
    /// 调用某个 Remote 服务的方法完成设置（如授权登录），按配置的字段判定完成。
    RemoteCall,
}

/// 一次字段比较：从结果对象里取 `path` 指向的单层字段，与 `equals` 比较。
///
/// 宿主不知道这个字段表示什么、取值有什么含义——它只做相等比较。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteCondition {
    /// 单层字段名。
    pub path: String,
    /// 比较目标。
    pub equals: String,
}

/// 卡片正文的一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteField {
    /// 何时显示；缺省 = 总是显示。
    #[serde(default)]
    pub show_when: Option<RemoteCondition>,
    /// 取哪个字段。
    pub path: String,
    /// 行首文案的 i18n key；缺省时只显示值。
    #[serde(default)]
    pub label: Option<String>,
    /// 是否附带「复制」按钮（用于授权链接这类值）。
    #[serde(default)]
    pub copy: bool,
}

/// 卡片内的一颗按钮。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteAction {
    /// 何时显示；缺省 = 总是显示。
    #[serde(default)]
    pub show_when: Option<RemoteCondition>,
    /// 点击时调用的 Remote 方法名（本步骤 `namespace` 下）。
    pub method: String,
    /// 按钮文案的 i18n key。
    pub label: String,
}

/// `remote-call` 步骤的完整描述。
///
/// 宿主只执行三条原语：**取值**（`read`）→ **比较**（`done` / `showWhen`）→ **渲染**
/// （`fields`）或 **调用**（`actions`）。它不理解任何具体业务状态，因此换一个
/// provider（OAuth 设备授权、轮询某种就绪标志、……）只需改配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteCallSpec {
    /// Remote 命名空间，纯字符串透传。
    pub namespace: String,
    /// 读取状态的 Remote 方法名。
    pub read: String,
    /// 完成判定：比较为真即本步完成。
    pub done: RemoteCondition,
    /// 卡片正文行，按顺序渲染。
    #[serde(default)]
    pub fields: Vec<RemoteField>,
    /// 卡片内按钮。
    #[serde(default)]
    pub actions: Vec<RemoteAction>,
    /// 轮询间隔（毫秒）；缺省 1500。
    #[serde(default)]
    pub poll_ms: Option<u64>,
}

/// 清单 `onboarding.steps` 里的一项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingStep {
    /// 步骤唯一 id，也是进度集合里的键。
    pub id: String,
    /// 通用动作类型。
    pub kind: OnboardingKind,
    /// 步骤标题（i18n key 或直接文案，由界面决定如何解析）。
    pub title: String,
    /// 用户是否可跳过。
    #[serde(default)]
    pub optional: bool,
    /// `kind = remote-call` 时的调用描述。
    #[serde(default)]
    pub remote: Option<RemoteCallSpec>,
}

/// 清单里的 `onboarding` 节。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingSection {
    #[serde(default)]
    pub steps: Vec<OnboardingStep>,
}

impl OnboardingSection {
    /// 按 id 找步骤。
    pub fn step(&self, id: &str) -> Option<&OnboardingStep> {
        self.steps.iter().find(|step| step.id == id)
    }
}

/// 持久化的进度状态。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingState {
    /// 状态格式版本。
    #[serde(default)]
    pub version: u32,
    /// 已完成的步骤 id（顺序即完成顺序；不保证与配置顺序一致）。
    #[serde(default)]
    pub completed: Vec<String>,
    /// 全部步骤完成的时间戳；`None` 表示引导尚未结束。
    #[serde(default)]
    pub finished_at: Option<String>,
}

impl OnboardingState {
    /// 某步骤是否已完成。
    pub fn is_completed(&self, id: &str) -> bool {
        self.completed.iter().any(|done| done == id)
    }

    /// 记录一个步骤完成；重复记录无副作用。
    pub fn complete(&mut self, id: &str) {
        if !self.is_completed(id) {
            self.completed.push(id.to_string());
        }
    }

    /// 按配置判断是否全部完成，并在完成时写入结束时间。
    ///
    /// `now` 由调用方提供（便于测试）；已记录结束时间则保持不变。
    /// 按配置判定是否全部完成，并在完成时记录结束时间。
    ///
    /// `finished_at` 只是**历史记录**（引导何时走完），不参与「需不需要引导」的判断。
    /// 判据永远是步骤集合：新增步骤后即使旧时间戳还在，新步骤也是待办。把时间戳
    /// 当成开关会让「加步骤」永远影响不了已跑完引导的用户。
    pub fn settle(&mut self, section: &OnboardingSection, now: &str) {
        // 未配置任何步骤时不算「已完成引导」：没有步骤就没有引导，避免把空配置
        // 误记成「用户已经走过一遍」。
        if section.steps.is_empty() {
            return;
        }
        if section.steps.iter().all(|step| self.is_completed(&step.id)) {
            // 保留首次时间戳；重新完成时不覆盖。
            if self.finished_at.is_none() {
                self.finished_at = Some(now.to_string());
            }
        }
        else {
            // 有未完成步骤（典型：配置新增了一步）→ 清掉时间戳，与事实一致。
            self.finished_at = None;
        }
    }

    /// 归一化：版本不符时按空进度处理（结构不兼容的旧数据不猜语义）。
    fn normalize(mut self) -> Self {
        if self.version != STATE_VERSION {
            self = Self {
                version: STATE_VERSION,
                ..Self::default()
            };
        }
        self
    }
}

/// 进度文件路径：应用数据目录下的 `onboarding.json`。
pub fn state_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(STATE_FILE))
}

/// 读取进度；文件缺失或损坏时返回空进度（不阻断启动）。
pub fn read_state<R: Runtime>(app: &AppHandle<R>) -> OnboardingState {
    let Some(path) = state_path(app) else {
        return OnboardingState { version: STATE_VERSION, ..OnboardingState::default() };
    };
    read_state_at(&path).normalize()
}

/// [`read_state`] 的纯路径形态，便于测试。
pub fn read_state_at(path: &Path) -> OnboardingState {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return OnboardingState { version: STATE_VERSION, ..OnboardingState::default() };
    };
    serde_json::from_str::<OnboardingState>(&raw)
        .map(|state| state.normalize())
        .unwrap_or_else(|error| {
            log::warn!("ONBOARDING_STATE_INVALID: {}: {error}", path.display());
            OnboardingState { version: STATE_VERSION, ..OnboardingState::default() }
        })
}

/// 写入进度（先写临时文件再改名，避免中途崩溃留下半截 JSON）。
pub fn write_state_at(path: &Path, state: &OnboardingState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("ONBOARDING_STATE_DIR_FAILED: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(state)
        .map_err(|error| format!("ONBOARDING_STATE_SERIALIZE_FAILED: {error}"))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, raw).map_err(|error| format!("ONBOARDING_STATE_WRITE_FAILED: {error}"))?;
    std::fs::rename(&temp, path).map_err(|error| format!("ONBOARDING_STATE_RENAME_FAILED: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(ids: &[&str]) -> OnboardingSection {
        OnboardingSection {
            steps: ids
                .iter()
                .map(|id| OnboardingStep {
                    id: (*id).to_string(),
                    kind: OnboardingKind::PluginSelection,
                    title: (*id).to_string(),
                    optional: true,
                    remote: None,
                })
                .collect(),
        }
    }

    #[test]
    fn completing_is_idempotent() {
        let mut state = OnboardingState { version: STATE_VERSION, ..OnboardingState::default() };
        state.complete("plugins");
        state.complete("plugins");
        assert_eq!(state.completed, vec!["plugins".to_string()]);
    }

    #[test]
    fn settles_only_when_every_configured_step_is_done() {
        let section = section(&["plugins", "kernel"]);
        let mut state = OnboardingState { version: STATE_VERSION, ..OnboardingState::default() };
        state.complete("plugins");
        state.settle(&section, "t1");
        assert_eq!(state.finished_at, None, "尚有未完成步骤");
        state.complete("kernel");
        state.settle(&section, "t2");
        assert_eq!(state.finished_at.as_deref(), Some("t2"));
    }

    #[test]
    fn an_empty_section_never_settles() {
        // 没配步骤 ≠ 走完引导：否则以后新增步骤时旧用户永远不会看到。
        let mut state = OnboardingState { version: STATE_VERSION, ..OnboardingState::default() };
        state.settle(&OnboardingSection::default(), "t1");
        assert_eq!(state.finished_at, None);
    }

    #[test]
    fn settling_keeps_the_first_timestamp() {
        let section = section(&["plugins"]);
        let mut state = OnboardingState { version: STATE_VERSION, ..OnboardingState::default() };
        state.complete("plugins");
        state.settle(&section, "first");
        state.settle(&section, "second");
        assert_eq!(state.finished_at.as_deref(), Some("first"));
    }

    #[test]
    fn unknown_completed_ids_are_harmless() {
        let section = section(&["plugins"]);
        let mut state = OnboardingState {
            version: STATE_VERSION,
            completed: vec!["removed-step".to_string()],
            finished_at: None,
        };
        assert!(!state.is_completed("plugins"));
        state.complete("plugins");
        state.settle(&section, "t");
        assert_eq!(state.finished_at.as_deref(), Some("t"));
    }

    #[test]
    fn a_new_step_makes_a_finished_state_pending_again() {
        // 这是「加步骤不改代码」的核心保证：新增步骤后，旧时间戳不能把它隐住。
        let mut state = OnboardingState {
            version: STATE_VERSION,
            completed: vec!["plugins".to_string()],
            finished_at: Some("old".to_string()),
        };
        let wider = section(&["plugins", "kernel"]);
        assert!(!wider.steps.iter().all(|step| state.is_completed(&step.id)));
        state.settle(&wider, "new");
        // 仍有未完成步骤 → 时间戳必须清掉，否则界面会认为引导已结束。
        assert_eq!(state.finished_at, None);
        // 补上后再次收尾，时间戳恢复。
        state.complete("kernel");
        state.settle(&wider, "newer");
        assert_eq!(state.finished_at.as_deref(), Some("newer"));
    }

    #[test]
    fn mismatched_version_reads_as_empty() {
        let state = OnboardingState {
            version: 999,
            completed: vec!["plugins".to_string()],
            finished_at: Some("t".to_string()),
        }
        .normalize();
        assert_eq!(state.version, STATE_VERSION);
        assert!(state.completed.is_empty());
        assert_eq!(state.finished_at, None);
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("dsh-onboarding-{}", std::process::id()));
        let path = dir.join(STATE_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        let mut state = OnboardingState { version: STATE_VERSION, ..OnboardingState::default() };
        state.complete("plugins");
        state.complete("kernel");
        write_state_at(&path, &state).expect("write");
        assert_eq!(read_state_at(&path), state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_reads_as_empty() {
        let path = std::env::temp_dir().join("dsh-onboarding-missing/onboarding.json");
        let state = read_state_at(&path);
        assert_eq!(state.version, STATE_VERSION);
        assert!(state.completed.is_empty());
    }

    #[test]
    fn a_corrupt_file_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("dsh-onboarding-bad-{}", std::process::id()));
        let path = dir.join(STATE_FILE);
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(&path, "{not json").expect("write");
        let state = read_state_at(&path);
        assert!(state.completed.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
