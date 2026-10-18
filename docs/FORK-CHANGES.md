# 本 fork 相对上游的改动

上游：`dsh-tauri`（`3a8ec841`，v0.24.1）
本仓库：`sabishii-me/deepseek-harness-desktop`，分支 `feat/jouzu-kernel`
规模：44 个提交，110 个文件

---

## 0. 边界（先读这段）

**DSH 核心没有改，也不在这个仓库里。**

DSH 是运行时下载的独立依赖（`<AppData>/dev.sabishii.dshdesktop/dependencies/dsh`），
由 `manifest.jsonc` 声明版本、安装器负责获取。本仓库不含任何 `packages/dsh-*` 核心源码。

**改动范围只有三处：**

| 层 | 路径 | 说明 |
|---|---|---|
| 桌面壳层前端 | `src/` | onboarding、webview/iframe、i18n、store |
| 桌面壳层 Rust | `src-tauri/` | 内核安装、插件安装、运行时自包含、构建 |
| **桌面自带的内置插件** | `packages/dsh-tauri-kernel`、`packages/dsh-tauri-ui`、`packages/dsh-tauri-bundle` | 这些是**桌面自己的**插件，不是 DSH 的包 |

**另外两个独立公开仓库**（不在本仓库内，构建期从它们的 Release 拉取 tgz）：

| 仓库 | 内容 | 当前版本 |
|---|---|---|
| `sabishii-me/dsh-model-provider-shisa` | Shisa 模型提供商 | `v0.1.1` |
| `sabishii-me/dsh-jouzu-bridge` | Jouzu 模型桥接（loopback 传输 + Pi 扩展） | `v0.1.0` |

---

## 1. 应用身份

| 项 | 上游 | 本 fork |
|---|---|---|
| `productName` | `DSH Tauri` | `DSH-Desktop` |
| `identifier` | `dsh-tauri` | `dev.sabishii.dshdesktop` |
| 更新源 | 上游 | `sabishii-me/deepseek-harness-desktop` |

提交：`e072efa8`、`2ea85b7e`、`acbec110`

安装默认落在 `%LOCALAPPDATA%\Sabishii.dev\DSH-Desktop\`，Windows 数据选择与全局
`DSH_HOME` 隔离（`acbec110`），因此可与上游版本并存。

---

## 2. 运行时自包含

**桌面不再采用用户机器上的 node / pnpm。**

| 变化 | 原因 |
|---|---|
| `PREFER_BUNDLED_NODE_RUNTIME` 默认 true | 全新 Windows 机器没有 node |
| `pnpm_ready()` 只认捆绑 pnpm | 用户 pnpm 版本漂移会破坏 store 与 ABI |
| 删除 `find_user_pnpm_*` / `user_pnpm_invocation` | 不再有第二套发现路径 |

提交：`c3c7be4f`、`2d499c01`

捆绑版本在 `scripts/bundle-runtime.ts`：`NODE_VERSION`、`PNPM_VERSION`。
下载源已验活（nodejs.org / npmmirror、registry.npmjs.org / registry.npmmirror.com）。

**例外**：探测「用户已经装了什么」时用用户自己的 npm（`service/kernel/install.rs` 的
`system_npm_program`），因为捆绑 npm 只会回答它自己的根目录。

---

## 3. 原生内核机制

`packages/dsh-tauri-kernel` 提供：一个会话一个子进程，行分隔 JSON 协议，
事件投影到官方 `NativeSink`。官方 agent factory / agent-loop **不替换**。

**支持的三个原生内核**：`codex`、`claude`、`jouzu`（`NATIVE_BACKENDS`，同时也是选择器顺序）。

### 3.1 Jouzu 后端

`host/backends/jouzu.ts` 说 Pi RPC 模式：

- 文本/推理经 `message_update` 流式投影
- 工具执行经 `tool_execution_start|end`
- 回合只在 `agent_settled` 结算
- `extension_ui_request` 自动应答，避免子进程阻塞

提交：`db171f1b`、`88bc9557`、`e4712462`、`b612ac07`、`c7b41c1d`、`a045649d`、
`f856bcee`、`47659b95`、`a39ef23a`、`24b37399`

### 3.2 Jouzu 使用 Shisa 模型

`host/service/jouzu-model-access.ts`：Jouzu 的模型目录**追加** Shisa 的模型，
id 形如 `dsh/shisa/<id>`；选中后经 loopback 桥接把 DSH 的模型服务提供给 Jouzu 子进程。

提交：`9d8dde6d`
依赖包：`@sabishii-me/dsh-jouzu-bridge`（`ede82434`）

### 3.3 内核安装（一次性，非插件安装）

`src-tauri/src/service/kernel/install.rs`：

- **零产品名**：包名、入口、探测参数全部来自 `manifest.jsonc` 的 `kernels`
- **版本不写死**：来自配置，支持 `latest`
- **走与插件安装同一条执行器**（`run_plugin_install_with_transient_retry`），
  因此继承串行锁、取消、瞬时重试、逐行 `preinstall-log`
- **三个来源依次探测**：应用托管槽位 → DSH 档案 → 系统全局 npm 根；
  三者都跑同一个协议探测，**任何位置找到就算已装，不再提示安装**

提交：`5257d9a8`、`58c3b0bc`、`48cc516d`

### 3.4 内核选择器的忙态

点选后立即关闭下拉并显示目标内核名 + spinner，而不是等会话建好才变。

提交：`d35dc588`

---

## 4. Onboarding

**配置驱动**：步骤声明在 `src-tauri/resources/manifest.jsonc` 的 `onboarding.steps`，
宿主只认四种通用 `kind`：`plugin-selection` / `native-kernel` / `remote-call`。
加步骤只改配置，不改壳层代码；宿主代码里不出现任何具体产品字面量。

### 4.1 时序（关键，容易改错）

```
插件步骤 → 内核步骤 → [启动 DSH 服务] → 全屏层仍盖着 → 模型适配 → 撤层
```

**服务启动 ≠ 用户可见。** 全屏层（`webview.tsx` 的 `data-onboarding-layer`）压在
iframe 之上，服务在下面跑，用户看不到。

`preinstall/store.ts` 的两条约束：

- `advance()` 在下一步需要服务（`kind === 'remote-call'`）时就调 `finish()`，
  而不是等所有步骤完成 —— 否则模型步骤在服务启动前执行，必然连接失败
- `finish()` 幂等（`finishedOnce`）。它会重启服务，被多处触发时界面会在
  「等待服务」和「正常」之间来回跳。失败时复位以便重试

提交：`a10b811c`、`6ad83a1b`、`0b836b45`、`7c8687cc`、`d7bc2b01`

### 4.2 remote-call 步骤的界面规则

`src/layout/components/setup-preinstall.tsx` 的 `RemoteCallStep`：

| 规则 | 内容 |
|---|---|
| R1 | 值为空的字段**整行不渲染**（不出现幽灵空行） |
| R2 | 只翻译存在的 i18n key，不存在则**整条不渲染**（绝不输出 key 原文） |
| R3 | 同一时刻卡片内**最多一个** action |
| R4 | 顶部按配置的 `states` 表显示状态标题 |
| R5 | 字段是正文不是表单 |
| R6 | `open: true` 的字段渲染成按钮，不是裸 URL |
| — | 首次探测未回时显示「正在读取状态…」，不渲染空卡片 |

**i18n 是扁平 key**（`keySeparator: false`），不要嵌套。

提交：`e1f6b14a`、`0e7fcba0`

### 4.3 官方 onboarding 的抑制

`iframe.tsx` 推 `dsh://onboarding:allow`，值是 `!showedOnboarding` ——
**「这次启动展示过引导」就抑制**，不是「此刻还没问完」。

理由：我们只在首次启动展示引导，第三步已经问过要不要登录；在同一个启动里再问一次
就是重复打扰。之后没有展示引导的启动照常放行，交给核心自己的就绪判定。

---

## 5. 构建

`pnpm build` 的链路（CI 与本机完全一致，**不需要额外步骤**）：

```
tauri build
  → beforeBuildCommand: pnpm build
      → prebuild:
          build:plugins        # pnpm deploy 13 个内置插件到 resources/
          bundle:resources     # 从 Release 拉我们自己的两个包
      → tsc && vite build
  → 打包 resources/**/*
```

**两条必须知道的规则：**

1. **`bundle:resources` 必须跑在 `pruneDeployment` 之后** —— 它在 `prebuild` 里，
   顺序正确。把我们的包放进 `resources/` 之后不要再跑 `build:plugins`，否则会被当
   orphan 删掉
2. **内核包由 `pnpm deploy` 带进来**（它在 `dsh-tauri-bundle` 的依赖里），
   **不要再手写拷贝** —— 手写拷贝跑在 pruner 之后，会把 `.map`（含完整源码）和
   `.d.ts` 塞回安装包

提交：`312fad8e`、`022e9765`、`5d7de135`、`2f32c0af`、`0ae7bdc3`

**依赖声明**：`@sabishii-me/dsh-jouzu-bridge` 的 `zod` 是通过在
`packages/dsh-tauri-bundle/package.json` 里声明来带进包的（`bf85c979`）。
tarball 只含一个包，不带依赖树；`@deepseek-ai/*` 由 DSH 运行时提供，所以被排除。

---

## 6. 构建与验证命令

```bash
pnpm install
pnpm build                       # 插件 + 资源 + 前端
npx tsc --noEmit                 # 类型检查
npx vitest run --project unit    # 单元测试
npx tauri build                  # release 安装包（NSIS + MSI）
```

**dev 注意**：`tauri dev` 只起 vite，**不重建插件产物**。改 `packages/*` 之后
必须先 `pnpm --filter <pkg> build`，否则界面不会变。

**已知的既有测试失败**（与我们的改动无关，上游/环境问题）：
`dsh-tauri-remote` 的 POSIX-sh 测试与 `migrate.test.ts` 的 mode bits 断言
（Windows 上无法通过）。

---

## 7. 排障

| 现象 | 位置 |
|---|---|
| 桌面壳层日志 | `%APPDATA%\dev.sabishii.dshdesktop\logs\desktop.log` |
| DSH 子进程日志 | 同目录 `logs\tauri\dsh-web.log` |
| 引导进度 | `%APPDATA%\dev.sabishii.dshdesktop\onboarding.json` |
| 内核/模型 500 | 先看 `dsh-web.log` 的 `ERR_MODULE_NOT_FOUND`，多半是依赖没进包 |

---

## 8. 已知限制

- **Jouzu 会话首次未选模型就发消息**：会用 Jouzu 自己的 baseline 模型，之后在 DSH
  的模型选择器里切到其他 provider 会被 `BRIDGE_KERNEL_IMMUTABLE` 拒绝。
  仅影响历史会话，新会话正常。修法未定，不要在没有复现步骤的情况下盲改。
- **`bg_task` / `bg_status` / `subagent`** 无法经公开扩展 API 走 DSH 沙箱。
- 安装包未签名，未验证更新下载/安装往返。
