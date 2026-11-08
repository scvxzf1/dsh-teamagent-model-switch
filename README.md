# dsh-teamagent-model-switch

在 DSH Web 界面里直接切换模型，**包括已经启动的 AgentTeams 团队成员**，不需要重启 DSH、不需要改配置文件。

一个本地插件（local plugin）：前端是一个“模型切换”面板，后端只调用 DSH 与 AgentTeams 的原生接口。

---

## 功能

| 范围 | 作用 | 生效时机 |
| --- | --- | --- |
| 当前会话 | 调用 DSH 原生模型选择 | 后续尚未开始准备的模型步骤 |
| 新会话默认 | 保存普通会话的默认路由 | 之后新建的普通会话 |
| 新团队成员默认 | 更新 AgentTeams 全局默认渠道/模型 | 之后添加的成员 |
| **已启动成员（单个）** | 覆盖所选成员的有效路由 | 该成员后续尚未开始准备的步骤 |
| **已启动成员（整个团队）** | 一次切换团队内全部已启动成员 | 同上，逐成员报告结果 |

面板特性：

- 渠道/模型来自实际加载的目录，独立分组显示，可筛选。
- “应用”按钮按**实际路由差异**启用/禁用：已经是该模型时按钮为禁用状态并说明原因，不会重复提交。
- 已启动成员支持“单个成员”和“团队全部已启动成员（N 名）”；整批包含同模型成员，不会静默跳过，逐成员显示成功/失败/部分失败。
- 名单或模型版本在操作期间发生变化时，服务端返回 `409`，要求刷新后重新确认，不会拿旧名单强行写入。
- 提示区简短摘要 + 可展开的详细限制；浅色/深色主题下都保持可读对比度。

## 边界（重要）

- **不中断**：不会打断正在进行的模型调用、当前步骤或该步骤的重试。切换只影响之后**尚未开始准备**的步骤；已准备/已捕获的请求可能继续使用旧模型。
- **不唤醒**：不会发消息、唤醒成员、创建会话或重试失败任务。
- **保留**：成员 ID、创建描述、聊天历史、任务、attempt ownership、收件箱、工具与人设权限、原有后备（fallback）配置全部保留。
- **手动优先**：手动选择优先于该成员原有的 fallback；原配置保留，但手动覆盖生效期间不会自动退回旧后备模型。
- **两份记录不是一个事务**：团队侧的有效路由覆盖与子会话的 `model/selection` 日志分别写入。部分失败时接口明确返回 `partial`，面板要求你核对，不会假报全部成功。
- **原生旧卡片可能滞后**：AgentTeams 自带卡片可能仍显示创建时的模型，直到该插件自然重新加载。以本面板的“已保存 / liveNext / lastUsed”三项为准。
- 保存的是**路由配置**。没有发送付费验证请求，所以“应用成功”不代表上游模型健康、额度充足或有权限。

## 环境要求

- DSH Web（实测 `0.2.2-rc.1`），Node.js ≥ 20（实测 24）。
- 社区插件 `@nanmicoder/dsh-agent-teams`（实测 `0.1.28`）——**已有成员切换依赖它的内部模块**，见下方“维护”。
- Linux（systemd 用户服务示例）或 macOS；Windows 未验证。

## 安装

```bash
# 1. 取代码（放在任意目录，示例用 ~/.local/share）
git clone https://github.com/scvxzf1/dsh-teamagent-model-switch.git ~/.local/share/dsh-teamagent-model-switch
cd ~/.local/share/dsh-teamagent-model-switch

# 2. 生成指向本目录的 bundle patch（会写入 cordis.patch.yml）
node install.mjs

# 3. 注册到 DSH profile
#    编辑 ~/.dsh/profiles/<profile>/package.json：
#      "dependencies": { ..., "@local/dsh-model-switch": "link:/绝对路径/dsh-teamagent-model-switch" }
#      "dsh": { "profile": { "bundles": [ ..., "@local/dsh-model-switch" ] } }
#    然后在 profile 目录安装依赖（pnpm install 或 dsh plugin add）

# 4. 给已安装的 AgentTeams 打兼容补丁（可重复执行，自动备份）
node patch-teams.mjs

# 5. 重启一次 DSH Web，然后刷新浏览器页面
```

第 5 步的**一次重启是必须的**：DSH 的 Loader 只会导入新条目，重命名已有条目不会重新加载代码。之后所有 Apply 操作都不再重启 DSH。

验证：

```bash
curl -s http://127.0.0.1:<port>/plugins/local-model-switch/members
# 期望：{"available":true,"teams":[...]}
```

左侧栏出现“模型切换”即可开始使用。

### 环境变量

`install.mjs`、`patch-teams.mjs` 与插件运行时都读取同一组变量（默认值适合标准安装）：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | DSH 数据目录 |
| `DSH_PROFILE` | `web` | profile 名称 |
| `DSH_TEAMS_LIB` | `$DSH_HOME/profiles/$DSH_PROFILE/node_modules/@nanmicoder/dsh-agent-teams/lib` | AgentTeams 已安装模块目录 |
| `DSH_SDK` | `/usr/lib/node_modules/@deepseek-ai/dsh` | 全局 dsh 包（提供宿主 SDK 包） |

## 使用

1. 打开左侧 **模型切换**。
2. 选择渠道 → 模型 →（可选）推理档位。
3. 选择应用范围：
   - 勾选“当前会话 / 新会话默认 / 新团队成员默认”，点 **应用 · 无需重启**；
   - 或在下方选择团队，再选“单个成员”或“团队全部已启动成员”，点对应的应用按钮。
4. 阅读结果。出现 `partial` 或未知结果时，按提示刷新核对；可以显式重新确认持久化，但不会自动重试任务。

按钮在“所选范围已经是这个模型”时保持禁用——这是有意的，避免无意义的重复写入。

## 维护

`patch-teams.mjs` 会就地修改已安装的 AgentTeams 源码（`members.js`、`snapshot.js` 等），为的是让成员路由覆盖、fallback 优先级和恢复逻辑生效。它：

- 写入前校验目标源码版本，不匹配就**拒绝**而不是宽泛替换；
- 每次修改前生成 `*.model-switch-backup-<时间戳>` 备份；
- 可重复执行（幂等）。

AgentTeams 升级后需要重新执行一次。用户级 systemd drop-in 示例：

```ini
# ~/.config/systemd/user/dsh-web.service.d/model-switch.conf
[Service]
ExecStartPre=/usr/bin/node %h/.local/share/dsh-teamagent-model-switch/patch-teams.mjs
```

默认失败只警告、不阻断 DSH 启动（网页会拒绝不安全的写入）；需要严格失败可加 `--strict`。

### 卸载 / 回滚

1. 从 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 中移除 `@local/dsh-model-switch`。
2. 移除上面的 systemd drop-in。
3. 用 `*.model-switch-backup-*` 覆盖回被修改的 AgentTeams 源码（或重新安装该插件）。
4. 重启 DSH Web。

已保存的模型默认与成员路由记录属于 DSH/AgentTeams 自己的数据，卸载本插件不会自动还原它们。

## 测试

```bash
node --test test.mjs test-members.mjs test-fresh-members.mjs test-client-controls.mjs test-batch-members.mjs
```

157 项测试，覆盖：路由校验与凭据脱敏、真实内核 `AgentModel` 的 live/cold/维护通道切换、持久化部分失败、身份/代次/任务重新分配校验、批量全名单快照与 409 预检、按钮差异启用、批量结果判定、跨站拒绝、文字对比度回归。

> 测试依赖已安装并已打补丁的 AgentTeams 源码（`DSH_TEAMS_LIB`），不需要真实模型调用，也不会创建团队或修改成员数据。

## 已知限制

- 已准备/已捕获的模型步骤及其重试可能长期保留旧模型；要立刻生效只能等该步骤结束。
- 同一成员的两份持久化记录不是事务，极端情况下需要人工核对。
- AgentTeams 自带卡片可能滞后显示旧模型。
- 只在实测版本上验证；上游结构变化时 `patch-teams.mjs` 会拒绝执行，需要重新适配。

## English quickstart

A local DSH Web plugin that switches models from the browser, including **already-started AgentTeams members**, without restarting DSH.

```bash
git clone https://github.com/scvxzf1/dsh-teamagent-model-switch.git ~/.local/share/dsh-teamagent-model-switch
cd ~/.local/share/dsh-teamagent-model-switch && node install.mjs
# add "@local/dsh-model-switch": "link:<abs path>" to the profile dependencies
# and to dsh.profile.bundles, then install profile deps
node patch-teams.mjs      # patches the installed AgentTeams sources (backed up)
# restart the DSH Web service once, reload the page
```

Then open **模型切换** in the sidebar. Apply is disabled when the selected scopes already match, so no-op writes are impossible. Switches never interrupt running steps, never wake members and never retry failed tasks; only steps that have not started preparing use the new route.

## License

[Apache License 2.0](LICENSE)，版权归 `scvxzf1` 所有，详见 [NOTICE](NOTICE)。

本仓库不重新分发第三方代码：`patch-teams.mjs` 只对你已安装的 `@nanmicoder/dsh-agent-teams` 就地打文本补丁（该插件按其自身许可证授权）。
