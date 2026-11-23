# dsh-bridge-mcp

简体中文 · [English](README.md)

[![npm](https://img.shields.io/npm/v/dsh-bridge-mcp?style=flat-square)](https://www.npmjs.com/package/dsh-bridge-mcp)
[![ci](https://github.com/6thChoice/dsh-bridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/6thChoice/dsh-bridge-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-374151.svg)](LICENSE)

**从 Claude Code、Antigravity、Codex 或任何其他 agent，把一件事交给一个**已有的** DeepSeek Harness
会话去做，并拿回那个会话的回答。**

你手上那个 DSH 会话已经握着某个任务的上下文、工具和做到一半的进度。这个工具让别的 harness（或者一段
shell 脚本）可以直接问它一句，等**你这条消息自己所属的那一轮**结束，然后把答案当纯文本取回来。

```sh
dsh-bridge send "ingest 那块你做到哪了？只说结论" --title "polymarket" --latest
```

- 一条消息进去，一个答案出来。不新建会话，不 fork 任何东西。
- 返回的答案属于**消费你这条消息的那一轮**——绝不是在发送时恰好也在跑的另一轮。
- 长任务：`--detach` 立刻返回 `rpcId`，之后 `dsh-bridge result --rpc-id <id> --wait` 在另一个进程里、
  甚至重启后取回结论。
- 能打**远端** DSH 主机，不只是本机进程。
- 零运行时依赖，Node ≥ 22.19。

## 为什么不用现成的 DSH 插件？

已经有一个目的相似的宿主内插件（npm 上的 [`dsh-bridge`](https://github.com/baixianger/dsh-bridge)，
一个 DSH 插件，把会话消息能力暴露给宿主自己的 agent）。两者都合理，只是位置不同：

| | DSH 插件 | `dsh-bridge-mcp`（本工具） |
|---|---|---|
| 安装 | 装进某个 DSH profile，受插件版本栅栏约束 | 不往 DSH 里加任何东西，就是个客户端，等同开一个浏览器标签页 |
| 触达范围 | 仅本机宿主进程 | 任何可达的 DSH Web 主机，包括经 TLS 的远端 |
| 调用方 | DSH 自己的 agent | 任何 harness：Claude Code、Antigravity、Codex、脚本 |
| 完成语义 | 投递确认（宿主收下了这条消息） | 等到消费你这条消息的那一轮结束，带退出码 |
| 代价 | 跟随 DSH 的插件 API | 依赖 DSH 的浏览器 cookie 认证，DSH 发版可能需要这边跟一下 |

想在单个宿主内让 DSH 的 agent 互相发消息，选插件；调用方在 DSH 之外、或主机在另一台机器上，选这个。

## 安装

零安装（推荐给 MCP 用）：

```sh
npx -y dsh-bridge-mcp
```

全局安装，会同时得到两个命令——`dsh-bridge`（CLI）与 `dsh-bridge-mcp`（MCP server）：

```sh
npm i -g dsh-bridge-mcp
```

从源码：

```sh
git clone https://github.com/6thChoice/dsh-bridge-mcp
cd dsh-bridge-mcp && npm install && npm run build && npm link
```

## 60 秒上手

```sh
dsh-bridge doctor            # 主机、认证路径、连通性，以及每一项失败该怎么修
dsh-bridge sessions --limit 5
dsh-bridge send "只回一个词：PONG" --cwd ~/code/my-project --latest
```

接进某个 harness —— `setup` 会用**你这台机器**的真实路径生成配置块：

```sh
dsh-bridge setup claude-code           # 或 antigravity、codex、cursor、cline、continue、zed、raw
dsh-bridge setup claude-code --write   # 直接写入（仅 Claude Code 与 Antigravity）
```

每个 harness 的可粘贴配置在 [`examples/`](examples/)，包括
[`examples/remote-host.md`](examples/remote-host.md)（远端主机）。详见
[`docs/install.md`](docs/install.md)。

## 五个命令

| 命令 | 用途 |
|---|---|
| `dsh-bridge send <text> (target)` | 发一条消息，打印其所属那一轮的最终回答 |
| `dsh-bridge result --rpc-id <id>` | 事后读回这次发送；`--wait` 阻塞到结束 |
| `dsh-bridge sessions (target)` | 列出与解析会话 |
| `dsh-bridge doctor` | 诊断主机、认证路径、连通性 |
| `dsh-bridge setup <harness>` | 生成本机可用的 MCP 配置 |

寻址：`--session <id|前缀>`、`--title <子串>`、`--cwd <路径>`、`--latest`。只允许一族；不给选择器是
错误，匹配到多个也是错误（会列出候选，不猜）。完整参考见 [`docs/usage.md`](docs/usage.md)。

MCP 工具：`dsh_send`、`dsh_result`、`dsh_sessions`，语义一致；`structuredContent` 携带 JSON 结论，
`isError` 与 CLI 退出码对齐。

## 它会如实告诉你结果

- 纯文本模式 stdout **只有**最终 assistant 文本——可以直接塞进另一个 agent 的 tool result。
- `--json` 给出 `rpcId`、`sessionId`、`turn`、`status`、`reason`、`text`、`toolCalls[{name,ok}]`、
  `durationMs`、`usage`、`host`。
- 退出码：`0` 完成（或已 detach，或仍 pending）、`2` 超时、`3` 该轮以错误/取消结束、`1` 本地失败。
  超时场景下 `rpcId` 与"稍后取回"的提示写到 **stderr**，所以只解析 stdout 的调用方不会把半截当成最终答案。
- 仍在跑的一轮绝不输出文本：`pending` 的含义是"持久日志里还没有结论"。

## 认证

两条路径，自动选择，都只是拿到一个普通的 DSH 浏览器会话：

1. **启动 URL 令牌** —— `dsh web` 打印的 `http://127.0.0.1:<端口>/?token=…`。这是 DSH 的公开流程；令牌换
   成浏览器 cookie，跨机器、跨 DSH 版本都稳。
2. **凭据自签** —— 读 `$DSH_HOME/.credentials.yaml` 里的 `client-connection/browser-session`，为目标主机
   签出浏览器 cookie。零操作步骤，桌面端必需（它从不打印启动 URL）。

cookie 只在内存里，绝不打印。`doctor` 会告诉你走的是哪条。指向非你控制的主机之前，请先读
[`SECURITY.md`](SECURITY.md)：发一条 prompt 就等于让那台主机上的 agent 有能力执行命令，把这个工具当成
DSH 输入框本身来对待。

## 已知边界

- 认证跟随 DSH 内部实现（cookie 签名方案、凭据记录）。DSH 发版可能把它打断；`doctor` 会让失败很显眼，
  [`docs/protocol.md`](docs/protocol.md) 记录了到底验证过什么。已验证对象是 DSH `0.2.1-rc.2`，更老的
  `0.1.x` 是尽力支持。
- 阻塞式 `send` 同时受调用方自己的工具超时限制（Claude Code 的 Bash 工具上限 10 分钟）以及 `--timeout`
  限制。长任务请用 `--detach` + `result`。
- `result` 报 `pending` 不等于该轮还活着——也可能是 prompt 被丢弃，或落在读取窗口之外。
- follow socket 掉线不重试；答案仍可用 `result` 读回。
- `--steer` 打进一个已经跑了很久的轮次，可能在投递之后失败。

完整清单（带 file:line）在 [`docs/backlog.md`](docs/backlog.md)。

## 开发

```sh
npm install && npm run build
npm run typecheck && npm test
```

集成测试会拉起一个一次性的 `dsh web`（临时 `DSH_HOME` + 本地 stub 模型服务）——不打真实模型、不碰真实
会话——并且在找不到 `dsh` 时自动跳过。见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 许可证

MIT © 2026 6thChoice。见 [`LICENSE`](LICENSE)。
