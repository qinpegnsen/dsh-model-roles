# GitHub 与 npm 双平台发布

本插件的默认发布约定是：**同一版本同时交付 GitHub 源码与公开 npm 包**。两边无法做原子事务；必须分别读回，不能因一个平台成功就宣称全部完成。

## 发布目标

- GitHub：`https://github.com/qinpegnsen/dsh-model-roles`
- npm 包名：`dsh-model-roles`
- npm registry：`https://registry.npmjs.org/`
- npm 访问级别：`public`
- 版本以 `package.json` 的 `version` 为准。npm 已存在的版本不可覆盖，更新代码需使用新版本。

## 1. 前置核对

在插件仓库根目录执行：

```bash
git status --short
git remote -v
gh api user --jq .login
npm whoami --registry https://registry.npmjs.org/
npm view dsh-model-roles version --registry https://registry.npmjs.org/
```

- 核对仓库和 npm 身份。已有包需确认当前 npm 账号拥有发布权限；首次发布前检查该名称是否被占用。
- `npm whoami` 返回 `401` 表示当前登录无效，停止发布，由用户在本机运行 `npm login --registry https://registry.npmjs.org/`。
- 首次发布前公开查询包名返回 `404` 只说明当前没有公开包；最终名称和权限以 registry 发布结果为准。
- 不读取 `.npmrc`、Token 或密码，也不把验证码写入对话、脚本或 CI 配置。

## 2. 准备同一版本

1. 更新版本（只有已有 npm 版本需要变更时才升版），使用说明应与当前 UI 一致。
2. 确认公开清单只含源码、可移植单元测试、文档与构建产物；本机截图、配置、账号信息和诊断记录不提交。
3. 按当前任务授权执行构建和测试：

```bash
npm run build
npm test
npm pack --dry-run
```

4. 核对安装包具有 `package.json`、`cordis.patch.yml`、`lib/client.js`、`lib/index.js`，且不包含敏感状态。本插件的 `files` 清单控制 npm 包内容；GitHub 源码清单单独核对。
5. 创建本地提交，记录该提交 SHA；之后发布过程中不再修改安装包内容。

## 3. 上传 npm 与 GitHub

发布 npm：

```bash
npm publish --access public --registry https://registry.npmjs.org/
```

如 npm 要求浏览器认证或二次验证，由用户在本机完成，不通过聊天接收凭据。失败后先查询确切版本是否已存在，未知结果不得盲目重发同一版本。

npm 发布成功后，推送相同内容的 GitHub 提交，并用 `v<版本>` 标记对应提交：

```bash
git push origin main
# 将 <版本> 替换为本次 package.json 中的版本；不可移动已存在的发布标签。
git tag "v<版本>"
git push origin "v<版本>"
```

若其中一个平台失败，只修复并补齐未完成的平台；已成功的版本不重复发布、不覆盖标签。

## 4. 验收与交付

- `npm view dsh-model-roles@<版本> version dist.integrity --registry https://registry.npmjs.org/` 能公开读出确切版本及包校验信息。
- 检查 npm 安装包文件清单与本地批准清单一致；必要时在临时目录中安装或解包验证，不覆盖用户现有的 DSH profile。
- GitHub `main` 与版本标签指向预期提交，CI 成功。
- 两边核对通过后，在 README 中将包名安装入口标为可用，并明确告知用户可在 DSH「添加插件」输入 `dsh-model-roles`。
- 缺登录、版本权限或任何一边未完成时，报告具体剩余步骤，不宣称双平台发布完成。

## 首次 npm 发布状态

首次发布已完成：npm `dsh-model-roles@0.1.0` 公开可用，GitHub 同名标签 `v0.1.0` 指向同一提交。后续发版按本流程执行，以 registry 与实际提交的读回结果为准。
