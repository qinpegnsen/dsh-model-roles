# DSH Model Roles · 规划／执行模型

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 提供两个模型预设：**规划模型**与**执行模型**。点击菜单或按快捷键，即可切换当前对话使用的模型。

输入框只增加一个 **双模型** 按钮，不再并排放置多个控件。

## 功能

- 分别保存两个模型及其可选的推理强度；不预设供应商或模型名称。
- 单按钮菜单提供「规划模型」「执行模型」「配置双模型…」，角色行显示当前有效快捷键。
- 按钮在当前选择匹配预设时显示「规划」或「执行」；否则显示「双模型」。若两个预设完全相同，优先显示「规划」。
- 复用 DSH 模型目录和选择接口，原有模型选择器与 `/model` 仍可正常使用。
- 失效模型、失效推理强度、配置冲突与切换失败会提示，不自动改选其他模型。

**只切换模型和推理强度，不切换规划模式或文件权限，不发送聊天消息，不自动规划或执行任务。**

## 安装

前提：已安装并配置 DSH，Web GUI 能正常列出至少一个可用模型。

### 从 GitHub 安装

在侧边栏 **插件 → 添加插件** 输入：

```text
https://github.com/qinpegnsen/dsh-model-roles.git
```

安装完成后启用插件。也可通过终端安装到 `web` profile：

```bash
dsh plugin --profile web add https://github.com/qinpegnsen/dsh-model-roles.git
```

若使用其他 profile，请替换 `web`。仓库包含构建产物，普通安装无需先构建，也无需另开 Web 服务器。

安装并启用后刷新 GUI，再打开一个普通对话，在输入框工具栏「权限」控件旁寻找 **双模型** 按钮。若看不到，先在插件页核对启用状态，再刷新页面。

### 从源码本地安装

```bash
git clone https://github.com/qinpegnsen/dsh-model-roles.git
cd dsh-model-roles
npm run build
npm test
dsh plugin --profile web add "$PWD"
```

PowerShell 下最后一行可用：

```powershell
dsh plugin --profile web add (Get-Location).Path
```

构建和单元测试使用 Node.js 自带模块，不需要运行 `npm install`。React、UI 组件和模型服务由 DSH 在运行时提供。

## 使用

1. 点击输入框中的 **双模型 → 配置双模型…**。
2. 分别选择规划、执行模型。如果该模型提供推理强度，可一并设置，然后点击 **保存**。
3. 点击 **双模型 → 规划模型 / 执行模型**，或使用快捷键切换。
4. 以 DSH 原有模型选择器显示的模型名称为准。切换从下一次模型请求开始生效，已经运行中的步骤不改变。

未配置预设时只提示先配置，不替你选择模型。要清除某一预设，在配置窗口选「未配置」后保存。

### 默认快捷键

| 平台 | 规划模型 | 执行模型 |
| --- | --- | --- |
| macOS | `Command + Option + 1`（`⌘⌥1`） | `Command + Option + 2`（`⌘⌥2`） |
| Windows | `Ctrl + Alt + 1` | `Ctrl + Alt + 2` |
| Linux | 默认不绑定，使用菜单 | 默认不绑定，使用菜单 |

在 **设置 → 编辑快捷键** 搜索「规划」或「执行」，可修改或清除绑定。可选键位由 DSH 快捷键服务校验，不绕过浏览器或系统限制。

Web 中快捷键面向当前主对话，不在终端、非对话面板或模态窗口中切换模型。DSH Desktop 的键盘拦截策略由宿主控制；本版本未进行 Desktop 实机验证。

## 配置与隐私

预设只保存在当前浏览器、当前 DSH 地址的 `localStorage`：

```text
dsh.model-roles.v1
```

只包含提供方 ID、模型 ID 和可选的推理强度；不保存密码、API Key、账号登录态或聊天内容。配置不会跨设备同步。不同标签页读取同一份配置；保存前会检查配置是否已被其他窗口修改。

插件本身不新增网络请求或遥测。模型目录读取和模型切换由已有的 DSH 服务完成。

## 兼容性与验证范围

- 当前已核验的 DSH 版本：**0.2.0-rc.2**。
- 依赖 DSH 的 `modelDirectories`、`shortcuts`、`slots`、会话服务及共享 UI 组件；其他 DSH 版本尚未验证。
- **macOS Chrome Web GUI** 已实测：菜单配置与保存、菜单切换、两个快捷键、原生模型位回显、取消不写入、刷新后配置保留。
- Windows 默认键位已声明，尚未做 Windows 浏览器实机验证；Linux 使用菜单。
- 不支持已寻址的子智能体会话。权限、模型凭据与供应商可用性仍由 DSH 管理。
- 当前单元测试覆盖配置校验、跨窗口冲突、切换互斥、无效模型拒绝、远程失败、会话生命周期和插件注册清理。单元测试不替代实机 UI 验收。

## 开发

```bash
npm run build
npm test
```

- `src/core.cjs`：预设存储、模型校验、切换与快捷键目标解析。
- `src/client.cjs`：单按钮菜单、配置窗口和反馈。
- `scripts/build.mjs`：生成 DSH 客户端 factory 与无行为的宿主入口。
- `lib/`：随仓库提供的构建产物，便于直接安装。改源码后先重新构建，再一并提交产物。
- `test/*.test.cjs`：不依赖账号、网络或浏览器的单元测试。

已安装插件的源码编辑不保证自动生效。没有对应构建监听时，重建后需停用并重新启用插件，再刷新 GUI；必要时按宿主提示重启 DSH。不要为此另开替代 GUI 服务器。

## 停用

在 **插件 → 规划／执行模型** 停用组合包，即移除单按钮菜单及快捷键。原有模型选择器继续可用；当前对话模型不随停用自动恢复。浏览器里的预设与快捷键覆盖保留，重新启用后可继续使用。

## 发布约定

本插件后续按 **GitHub + npm 同版本发布**。完成 npm 发布后，DSH「添加插件」可直接填写包名 `dsh-model-roles`；只存在 GitHub 仓库不代表 npm 包已发布。

当前首次 npm 发布尚未完成；在 registry 可以查询到公开版本之前，请继续使用上面的 GitHub 地址安装。

维护者发布步骤见 [双平台发布流程](https://github.com/qinpegnsen/dsh-model-roles/blob/main/docs/releasing.md)。

## 许可证

[MIT](LICENSE)
