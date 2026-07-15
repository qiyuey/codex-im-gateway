# Codex IM Gateway

> 在 Telegram 接收指定 Codex 任务的结果，并用手机继续同一个任务。

简体中文 | [English](README.md)

[![CI](https://github.com/qiyuey/codex-im-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/qiyuey/codex-im-gateway/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-26%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-11%2B-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Codex IM Gateway 是一个本地优先的 Codex 插件。你可以让任务留在电脑上运行，
在 Telegram 收到结果，并在不回到桌面的情况下安全地继续原任务。

项目目前处于 **pre-alpha** 阶段。Telegram 流程已经可用，但仍需从源码构建，
并通过本地 Codex marketplace 安装。Slack、Discord、飞书和通用 Webhook 尚在计划中。

## 你可以用它做什么

- 把明确指定的 Codex 任务或定时任务最终结果发送到 Telegram。
- 用 `/threads` 浏览允许范围内的 Codex 项目和任务。
- 在 Telegram 直接发消息，继续当前选中的任务。
- 回复某张结果卡片，准确回到生成该卡片的任务。
- 在 Telegram 回答 Codex 的非敏感选择题或开放问题。
- 关注桌面端任务，在任务完成、失败、产生有效结果后中断或阻塞时收到一次通知。

网关不会把桌面端的推理、命令、工具调用或中间输出实时发送到 Telegram。
从 Telegram 发起的任务会在运行期间持续更新同一条占位消息。

## 安装前准备

你需要：

- Node.js 26 或更高版本
- pnpm 11 或更高版本
- 已安装并登录、且兼容仓库内协议快照的 Codex Desktop/CLI
- 通过 [BotFather](https://t.me/BotFather) 创建的 Telegram Bot
- 你的 Telegram 数字用户 ID

网关面向“一个可信用户与 Bot 私聊”的场景。Telegram 请求可以在你允许的工作区中
启动 Codex 任务，但完整主机权限并不受这些工作区路径限制。因此 Telegram 账号和
Bot Token 都属于本机安全边界，请像保护电脑本身一样保护它们。

## 从源码安装

### 1. 构建网关

```bash
git clone https://github.com/qiyuey/codex-im-gateway.git
cd codex-im-gateway
pnpm install --frozen-lockfile
pnpm check
cp .env.example .env
```

`pnpm check` 会依次执行格式检查、类型检查、测试、生产构建、分发包冒烟测试和插件校验。

### 2. 配置 `.env`

在本地 `.env` 文件中填写：

```dotenv
TELEGRAM_BOT_TOKEN=你的-Bot-Token
TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_ALLOWED_CHAT_ID=123456789
CODEX_IM_GATEWAY_ALLOWED_WORKSPACES=/工作区的绝对路径
CODEX_IM_GATEWAY_LANGUAGE=zh
```

- `TELEGRAM_ALLOWED_CHAT_ID` 必须与 `TELEGRAM_ALLOWED_USER_ID` 相同；群聊和其他用户会被拒绝。
- `CODEX_IM_GATEWAY_ALLOWED_WORKSPACES` 可以填写多个绝对路径；macOS/Linux 用 `:` 分隔，
  Windows 用 `;` 分隔。
- `CODEX_IM_GATEWAY_LANGUAGE` 可设为 `zh` 或 `en`，默认为 `zh`。它会切换网关生成的
  按钮、命令、任务卡片、提问和状态消息，但不会翻译 Codex 的输出。
- 不要提交 `.env`，也不要把 Bot Token 粘贴到 Codex 对话里。

### 3. 安装本地插件

把当前源码目录加入一个可信的本地 Codex marketplace，从该 marketplace 安装
`codex-im-gateway`，然后新建一个 **Codex 任务**，让内置技能和 MCP 服务加载生效。
具体可参考官方的
[本地插件安装说明](https://developers.openai.com/codex/plugins/build#install-a-local-plugin-manually)
和本项目的[运维指南](docs/operations.md)。

这里没有用脚本自动改写 marketplace：它属于你的 Codex 配置，仓库不应该覆盖已有的
个人或项目 marketplace。

### 4. 启动并验证

在安装 Codex 的电脑上保持守护进程运行：

```bash
pnpm start
```

另开一个终端，确认网关和 Codex 连接都正常：

```bash
node dist/cli.js health
node dist/cli.js app-server-health
```

然后打开与 Bot 的私聊，发送 `/threads`，选择允许范围内的项目和任务，再发送一条简短
消息。Bot 的回复应当继续你刚才选择的任务。

## 日常使用

### 把任务结果发送到 Telegram

消息发送是显式开启的。要求 Codex 把 `$telegram-delivery` 作为最后一步：

```text
运行测试，汇总所有失败，并把 $telegram-delivery 作为最后一步，将结果发送到 Telegram。
```

同样的要求也可以写进定时任务提示词。没有要求 Telegram 投递的任务不会自动发送，
除非你已从 Telegram 选择并关注了该任务。

### 从 Telegram 继续任务

使用 `/threads` 选择项目和最近的任务。选择后：

- 普通消息会继续当前任务；
- 回复结果卡片或问题卡片，会继续与该卡片绑定的任务；
- 选择另一个任务会把当前关注切换过去；
- `/mute` 停止完成通知，但保留当前任务；
- `/detach` 同时清除当前任务和关注状态。

回复路由是持久化的：网关不会把回复悄悄转发到无关的当前任务。如果通知没有可信的
Codex 任务元数据，它会被明确标为“独立通知”，并提供任务选择器，而不会猜测回复目标。

### Telegram 命令

| 命令 | 作用 |
| --- | --- |
| `/threads` | 先选择项目，再选择最近任务 |
| `/use <ID 前缀>` | 通过无歧义的 ID 前缀选择任务 |
| `/current` | 查看当前任务 |
| `/new` | 在第一个允许的工作区中新建任务 |
| `/mute` | 停止当前任务的完成通知 |
| `/detach` | 清除当前任务和关注状态 |
| `/stop` | 中断当前执行，并取消排队中的后续消息 |

守护进程启动时会把这些命令注册到 Telegram Bot 菜单。

## 安全模型

- 守护进程使用 Telegram 长轮询，不开放公网监听端口。
- 只接受配置中的 Telegram 私聊用户和 Chat ID。
- 每次选择任务都会重新检查工作区白名单。
- 本地 SQLite 收件箱让通知投递支持重试和幂等处理。
- Telegram 不接受密钥输入，也不接受命令、文件或权限审批。
- `disable` 是持久化的紧急开关，可以停止来自 Telegram 的任务执行。

网关是访问本地 Codex 的入口，不是额外的沙箱。在个人可信环境之外使用前，请先阅读
[威胁模型](docs/threat-model.md)。

## 排障与运维

```bash
# 基础健康检查
node dist/cli.js health
node dist/cli.js app-server-health

# 检查队列，不输出事件正文
node dist/cli.js events --state queued
node dist/cli.js events --state dead_letter
node dist/cli.js notifications --state queued
node dist/cli.js notifications --state dead_letter

# 恢复过期租约
node dist/cli.js recover

# 紧急停止 / 恢复来自 Telegram 的任务执行
node dist/cli.js disable
node dist/cli.js enable
```

运行状态默认保存在 `~/.local/share/codex-im-gateway/gateway.sqlite`。安装或刷新插件后
需要新建 Codex 任务；修改 `.env` 后需要重启守护进程。

备份、Token 轮换、队列恢复和卸载步骤见 [docs/operations.md](docs/operations.md)。

## 常见问题

**它会把所有 Codex 任务都发送到 Telegram 吗？**

不会。任务必须明确要求使用 `$telegram-delivery`，或者你已经从 Telegram 选择并关注该任务。

**我能在 Telegram 回答 Codex 的问题吗？**

对于从 Telegram 发起的任务，非敏感的 `request_user_input` 问题会显示为有时限的一次性
卡片。你可以选择选项，或直接回复该卡片。权限审批和敏感输入仍需在电脑上完成。

**其他 Telegram 用户能控制我的 Codex 吗？**

按预期配置时，只接受指定数字用户 ID 与 Bot 的私聊。转发上下文、其他聊天和白名单外的
工作区都会被拒绝。

**卸载网关会删除 Codex 任务吗？**

不会。Codex 始终是任务数据的事实来源；网关只保存队列、投递、关注和消息绑定状态。

**为什么我收到了“独立通知”？**

Codex 没有为本次投递提供一致、可信的任务与执行元数据。网关仍会发送结果，但不会猜测
后续回复应该进入哪个任务。

## 项目文档

- [运维指南](docs/operations.md)
- [架构](docs/architecture.md)
- [威胁模型](docs/threat-model.md)
- [实现计划](PLAN.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 支持与反馈

- [报告问题](https://github.com/qiyuey/codex-im-gateway/issues/new?template=bug_report.yml)
- [提交功能建议](https://github.com/qiyuey/codex-im-gateway/issues/new?template=feature_request.yml)

## 许可证

MIT License — 见 [LICENSE](LICENSE)。
