# dsh-remote-control

DeepSeek Harness（DSH）跨机远程控制插件：一个包、两种角色，零第三方依赖。

- **controller**（控制端，装在你坐着的电脑 A）：向 DSH agent 注册 `remote_dsh_*` 工具，
  让你在聊天里直接指挥另一台电脑执行 DSH 会话任务。
- **worker**（被控端，装在另一台电脑 B）：常驻一个局域网 HTTP 服务，用 B 的本机 DSH
  创建/驱动真实会话，并把持久会话事件渲染成转录回传。

## 最快路径（零配置）

### B 端（被控电脑，macOS/Linux）

```bash
curl -fsSL https://raw.githubusercontent.com/coderdeng/dsh-remote-control/main/scripts/worker-setup.sh | bash
```

脚本会自动：找 `dsh` 命令、clone 本仓库到 `~/dsh-remote-control`、创建 `dsh-worker` profile、
生成 token、选空闲端口、写配置、创建 `~/dsh-work`、后台启动 worker，最后打印一条**配对码**
（`dshrc1.…`，含地址+token，等同于密码，只发给你的 A 端 agent）。

常用参数 / 运维：

```bash
bash scripts/worker-setup.sh --dry-run          # 只打印计划，不改任何东西
bash scripts/worker-setup.sh                    # 重跑：升级插件并重启 worker（token 复用）
bash scripts/worker-setup.sh --status           # 查看状态 / 配对码
bash scripts/worker-setup.sh --stop             # 停止 worker
bash scripts/worker-setup.sh --mode bundle      # 改为以 DSH bundle 方式安装
bash scripts/worker-setup.sh --keep-awake        # macOS：caffeinate 包住 worker，关屏/空闲不睡（默认开启）
bash scripts/worker-setup.sh --launchd           # macOS：装 LaunchAgent，登录自启 + 崩溃自动拉起
```

### A 端（控制电脑）

把 B 打印的配对码发给 A 的 DSH agent：

> 把这条配对码配对成远端电脑：`dshrc1.……`

agent 会调用 `remote_dsh_pair` 验证连通并持久保存（写入 `~/.dsh/dsh-remote-control/hosts.json`，
**不需要改 profile 配置**）。之后直接说「让另一台电脑做 XXX」即可。也可以用
`remote_dsh_unpair` 移除。

> A 端插件首次安装/升级后需要重启一次 DSH 才加载新代码；之后配对、加/删远端都不需要重启。

### macOS 常驻与休眠

- 默认在 macOS 上以 `caffeinate -i -s` 包住 worker：**屏幕关闭/空闲不会睡**（合盖仍会睡）。
- `--launchd` 会安装 `~/Library/LaunchAgents/com.dsh.remote-control.worker.plist`：登录自启、崩溃自动拉起；`--stop` 会卸载它。
- 合盖也要跑：接电源 + 外接显示器/键鼠的 clamshell 模式，或 `sudo pmset -a disablesleep 1`（危险，注意散热，用完改回 0）。

## 手动安装（不跑脚本时）

B 端 clone 后按 [docs/SETUP.md](docs/SETUP.md) 的 §1 手动配置 worker；A 端可以继续用配对码，
或在 profile 的 `cordis.patch.yml` 里手写 `hosts`（见 SETUP §3）。

## 工具（A 端 agent 可见）

| 工具 | 作用 |
| --- | --- |
| `remote_dsh_hosts` | 列出远端 + 在线探测 |
| `remote_dsh_pair` / `remote_dsh_unpair` | 用配对码添加 / 移除远端（免改配置） |
| `remote_dsh_start` | 在远端建会话、入队任务（可 resume 旧会话） |
| `remote_dsh_wait` | 长轮询到远端空闲并返回增量转录 |
| `remote_dsh_send` / `remote_dsh_status` / `remote_dsh_log` / `remote_dsh_abort` | 后续消息 / 状态 / 回看 / 中断 |

## 目录

```
lib/       插件本体（worker.js / controller.js / protocol.js / index.js）
scripts/   worker-setup.sh 一键部署脚本
docs/      SETUP.md 手动安装与排障；DESIGN.md 架构、协议、工具与 Phase B 计划
tools/     worker-smoke.mjs 冒烟、worker-client.mjs 手工客户端、sdk-drive.mjs 测试驱动
test/      node --test 用例（假 DSH 上下文 + 真实 HTTP + 配对流程）
```

## 本地验证

```bash
node --test test/bridge.test.mjs
node tools/worker-smoke.mjs http://127.0.0.1:7801 <token>
```

## 兼容性与安全

针对 DSH 0.2.1-rc.2 验证。插件只使用有文档的 Cordis 服务（`agents`、`tools`、
`permissionPresets`、会话事件），不 import 任何 `@deepseek-ai/*` 包，因此既能作为安装包加载，
也能通过 profile patch 的 file URL 直接加载。

token / 配对码等于远端电脑上的任意执行权限；只在自己可控的局域网内使用，不要把配对码提交进
仓库或发送到公共渠道。远端默认按会话启用 `danger-full-access`（自动执行、无审批）。
