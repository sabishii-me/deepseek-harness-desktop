//! 首次启动引导的命令面。
//!
//! 只做三件事：把清单里的步骤声明交给界面、读出进度、记录某一步完成。
//! 本模块**不认识任何具体产品**：步骤从清单来，完成判定按 id 走，
//! `remote-call` 的字段路径与取值同样来自配置。

use serde::Serialize;
use tauri::AppHandle;

use crate::config::manifest;
use crate::config::onboarding::{
    self, OnboardingKind, OnboardingState, OnboardingStep, RemoteCallSpec,
};

/// 界面视图：一个步骤的声明（原样透传配置，界面自己决定如何渲染）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingStepView {
    pub id: String,
    pub kind: OnboardingKind,
    pub title: String,
    pub optional: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemoteCallSpec>,
    /// 该步骤是否已完成。
    pub completed: bool,
}

/// 界面视图：引导整体状态。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingView {
    /// 清单声明的全部步骤（含完成标记）。
    pub steps: Vec<OnboardingStepView>,
    /// 引导是否已结束（全部步骤完成）。
    pub finished: bool,
    /// 结束时间戳。
    pub finished_at: Option<String>,
    /// 当前应展示的步骤 id；`None` 表示无需引导。
    pub current: Option<String>,
}

fn project(state: &OnboardingState, steps: &[OnboardingStep]) -> OnboardingView {
    let views: Vec<OnboardingStepView> = steps
        .iter()
        .map(|step| OnboardingStepView {
            id: step.id.clone(),
            kind: step.kind,
            title: step.title.clone(),
            optional: step.optional,
            remote: step.remote.clone(),
            completed: state.is_completed(&step.id),
        })
        .collect();
    // 当前步骤 = 第一个未完成的。全部完成则没有当前步骤。
    let current = views.iter().find(|view| !view.completed).map(|view| view.id.clone());
    OnboardingView {
        steps: views,
        finished: state.finished_at.is_some(),
        finished_at: state.finished_at.clone(),
        current,
    }
}

/// 只有清单声明了步骤时才有引导：没配置就没有这一步，界面据此直接收尾。
#[tauri::command]
pub fn get_onboarding(app_handle: AppHandle) -> OnboardingView {
    let Some(manifest) = manifest::read(&app_handle) else {
        return OnboardingView {
            steps: Vec::new(),
            finished: false,
            finished_at: None,
            current: None,
        };
    };
    let state = onboarding::read_state(&app_handle);
    project(&state, &manifest.onboarding.steps)
}

/// 标记某一步完成。
///
/// 只接受清单里声明过的 id：界面无法凭此写入任意键。重复标记无副作用。
/// 全部步骤完成时写入结束时间，之后界面不再展示引导。
#[tauri::command]
pub fn complete_onboarding_step(app_handle: AppHandle, id: String) -> Result<OnboardingView, String> {
    let Some(manifest) = manifest::read(&app_handle) else {
        return Err("ONBOARDING_MANIFEST_MISSING".to_string());
    };
    let section = manifest.onboarding;
    if section.step(&id).is_none() {
        return Err(format!("ONBOARDING_UNKNOWN_STEP: {id}"));
    }
    let mut state = onboarding::read_state(&app_handle);
    state.complete(&id);
    state.settle(&section, &now_rfc3339());
    if let Some(path) = onboarding::state_path(&app_handle) {
        onboarding::write_state_at(&path, &state)?;
    }
    Ok(project(&state, &section.steps))
}

/// 用给定集合覆盖已完成步骤（回退时用）。
///
/// 只接受清单里声明过的 id：界面无法凭此写入任意键。覆盖时清掉结束时间，
/// 让引导重新处于进行中。
#[tauri::command]
pub fn reset_onboarding_steps(
    app_handle: AppHandle,
    ids: Vec<String>,
) -> Result<OnboardingView, String> {
    let manifest = manifest::read(&app_handle).ok_or("ONBOARDING_MANIFEST_MISSING")?;
    let section = manifest.onboarding;
    for id in &ids {
        if section.step(id).is_none() {
            return Err(format!("ONBOARDING_UNKNOWN_STEP: {id}"));
        }
    }
    let mut state = onboarding::read_state(&app_handle);
    state.completed = ids;
    state.finished_at = None;
    if let Some(path) = onboarding::state_path(&app_handle) {
        onboarding::write_state_at(&path, &state)?;
    }
    Ok(project(&state, &section.steps))
}

/// 读一次某个 `remote-call` 步骤的状态，返回是否已完成。
///
/// 只按清单里该步骤的配置调用：命名空间、方法名、判定字段全部来自配置，
/// 本命令不认识任何具体服务。传输失败返回 `Err`（界面据此显示可读错误），
/// 「调用成功但条件未达成」返回 `Ok(false)`——两者不能混为一谈。
#[tauri::command]
pub async fn probe_onboarding_remote(
    app_handle: AppHandle,
    id: String,
) -> Result<OnboardingRemoteState, String> {
    let (base, spec) = remote_target(&app_handle, &id)?;
    let (value, done) = crate::service::onboarding::remote::read_state(&base, "", &spec).await?;
    Ok(OnboardingRemoteState {
        ready: done,
        // 服务端返回值原样交给界面：字段语义由配置与插件自己解释。
        state: value,
    })
}

/// 一次 remote 探测的结果：完整状态值 + 是否已满足配置的完成条件。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingRemoteState {
    pub ready: bool,
    pub state: serde_json::Value,
}

/// 调用某个 `remote-call` 步骤 `actions` 里声明的方法。
///
/// 方法名与显示条件都在配置里；本命令不判断它是「登录」还是「退出」，
/// 只接受该步骤声明过的方法（见 `remote::invoke`）。
#[tauri::command]
pub async fn invoke_onboarding_remote(
    app_handle: AppHandle,
    id: String,
    method: String,
) -> Result<(), String> {
    let (base, spec) = remote_target(&app_handle, &id)?;
    crate::service::onboarding::remote::invoke(&base, "", &spec, &method).await
}

/// 取出该步骤的 Remote 配置与服务基地址。
///
/// 步骤缺失、类型不是 `remote-call`、或未配置 `remote` 都给出精确错误：
/// 界面据此提示配置问题，而不是静默失败。
fn remote_target(
    app_handle: &AppHandle,
    id: &str,
) -> Result<(String, RemoteCallSpec), String> {
    let manifest = manifest::read(app_handle).ok_or("ONBOARDING_MANIFEST_MISSING")?;
    let step = manifest
        .onboarding
        .step(id)
        .ok_or_else(|| format!("ONBOARDING_UNKNOWN_STEP: {id}"))?;
    if step.kind != OnboardingKind::RemoteCall {
        return Err(format!("ONBOARDING_NOT_REMOTE_STEP: {id}"));
    }
    let spec = step
        .remote
        .clone()
        .ok_or_else(|| format!("ONBOARDING_REMOTE_SPEC_MISSING: {id}"))?;
    let port = crate::service::workflow::instances::port(app_handle);
    Ok((crate::config::get_dsh_service_url(port), spec))
}

/// 当前时间戳（秒精度，UTC）。失败时回落到空串，不影响完成标记本身。
pub(crate) fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => format!("{}", elapsed.as_secs()),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::onboarding::{OnboardingSection, RemoteAction, RemoteCondition, RemoteField};

    fn step(id: &str) -> OnboardingStep {
        OnboardingStep {
            id: id.to_string(),
            kind: OnboardingKind::PluginSelection,
            title: id.to_string(),
            optional: true,
            remote: None,
        }
    }

    #[test]
    fn no_steps_means_no_onboarding() {
        let view = project(&OnboardingState::default(), &[]);
        assert!(view.steps.is_empty());
        assert_eq!(view.current, None);
    }

    #[test]
    fn current_is_the_first_unfinished_step() {
        let steps = vec![step("plugins"), step("kernel")];
        let mut state = OnboardingState::default();
        state.complete("plugins");
        let view = project(&state, &steps);
        assert_eq!(view.current.as_deref(), Some("kernel"));
        assert!(view.steps[0].completed);
        assert!(!view.steps[1].completed);
    }

    #[test]
    fn all_done_has_no_current_step() {
        let steps = vec![step("plugins")];
        let mut state = OnboardingState::default();
        state.complete("plugins");
        state.finished_at = Some("t".to_string());
        let view = project(&state, &steps);
        assert_eq!(view.current, None);
        assert!(view.finished);
    }

    #[test]
    fn remote_spec_is_passed_through_verbatim() {
        // 宿主不解析 namespace/方法名/字段路径的语义，只原样交给界面与执行器。
        let spec = RemoteCallSpec {
            namespace: "any-namespace".to_string(),
            read: "readState".to_string(),
            done: RemoteCondition { path: "state".to_string(), equals: "ok".to_string() },
            fields: vec![RemoteField {
                show_when: None,
                path: "organisation".to_string(),
                label: None,
                copy: false,
            }],
            actions: vec![RemoteAction {
                show_when: Some(RemoteCondition {
                    path: "state".to_string(),
                    equals: "signed-out".to_string(),
                }),
                method: "authorize".to_string(),
                label: "preinstall.remote_sign_in".to_string(),
            }],
            poll_ms: None,
        };
        let steps = vec![OnboardingStep {
            id: "model".to_string(),
            kind: OnboardingKind::RemoteCall,
            title: "model".to_string(),
            optional: true,
            remote: Some(spec.clone()),
        }];
        let view = project(&OnboardingState::default(), &steps);
        assert_eq!(view.steps[0].remote.as_ref(), Some(&spec));
    }

    #[test]
    fn declares_the_three_generic_kinds() {
        // 动作类型是宿主的通用能力集合，与具体产品无关。
        let section = OnboardingSection { steps: vec![step("a")] };
        assert_eq!(section.step("a").map(|s| s.kind), Some(OnboardingKind::PluginSelection));
        assert!(section.step("missing").is_none());
    }
}
