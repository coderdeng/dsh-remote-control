# DSH 远程控制：Git 安装与部署指南

本仓库是一个可独立使用的 DSH（DeepSeek Harness）插件包：
**controller** 装在你坐着的电脑 A 上，向 DSH agent 注册 `remote_dsh_*` 工具；
**worker** 装在另一台电脑 B 上，常驻一个局域网 HTTP 服务，用 B 的 DSH 执行真实会话。

> 阶段 A（本仓库当前能力）：A 的 DSH agent 通过工具让 B 执行 DSH 会话任务。
> 阶段 B（本机界面里的「远程电脑」页面）尚未实现，设计见 [DESIGN.md](DESIGN.md) 第 8 节。

---

## 0. 方式选择

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| **A. clone + file URL（推荐）** | `git clone <repo-url> ~/dsh-remote-control` | 不依赖 npm/pnpm 网络，插件零依赖，最稳 |
| B. `dsh plugin add git+…`（可选） | `dsh plugin --profile dsh-worker add git+<repo-url>` | 作为 DSH bundle 安装，需要 B 有网络/pnpm 且有权限访问仓库 |

下面默认方式 A；方式 B 见第 5 节。

**先决条件**：A 与 B 在同一可信局域网；B 已安装 DSH 并能正常使用（模型已登录/已配置）；
B 上放行 TCP 7801（防火墙）；两端 DSH 版本尽量一致（本插件在 0.2.1-rc.2 验证）。

---

## 1. B 端（另一台电脑，一次性部署）

以 macOS/Linux 为例，把 `<TOKEN>`、`<B 的 IP>`、`<你的用户名>` 换成实际值。

### 1.1 clone 仓库

```bash
git clone <repo-url> ~/dsh-remote-control
cd ~/dsh-remote-control
ls lib/            # 应看到 controller.js worker.js protocol.js index.js
```

私有仓库需要 B 上已配置可访问该仓库的 Git 凭据（SSH key 或 HTTPS token）；公开仓库直接 clone。

### 1.2 找到 B 上的 dsh 命令

```bash
command -v dsh && dsh --version        # 已加入 PATH 时
```

没有 `dsh` 命令时，用 DSH 桌面应用自带的 CLI：

```bash
find /Applications -maxdepth 6 -name dsh -path '*runtime/cli/bin*' 2>/dev/null
# 例如 "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --version
```

下文把该命令记为 `dsh`。

### 1.3 生成共享 token

```bash
openssl rand -hex 24        # 得到 48 位十六进制字符串；没有 openssl 用: head -c 32 /dev/urandom | base64
```

这个 token 同时填进 B 的 worker 配置和 A 的 controller 配置。

### 1.4 创建 worker profile 并写配置

```bash
dsh --profile dsh-worker --from-default-profile sdk --dump-config > /dev/null   # 初始化 profile
mkdir -p ~/dsh-work
nano ~/.dsh/profiles/dsh-worker/cordis.patch.yml
```

把文件内容整体换成（token 与路径换成实际值）：

```yaml
# B 端：常驻 DSH 运行时 + remote-control worker
- id: sdk-app-startup
  disabled: true          # 不用 SDK stdio 入口，改为常驻 HTTP 服务
- id: sdk-jsonrpc-server
  disabled: true
- id: hmr
  disabled: true

- insert:
    - id: remote-control-worker
      name: 'file:///Users/<你的用户名>/dsh-remote-control/lib/worker.js'
      config:
        token: '<TOKEN>'
        listenHost: '0.0.0.0'          # 监听所有网卡；更安全可填 B 的具体局域网 IP
        port: 7801
        workspaceRoot: '/Users/<你的用户名>/dsh-work'
        permissionPreset: danger-full-access   # 远端会话自动执行，不弹审批
        # 模型路由：不填则用 B 的 DSH 默认选择（base 默认是 deepseek-official/deepseek-flash）。
        # 如果 B 是「DSH 账号登录」（桌面版默认），通常填下面两行：
        provider: deepseek-account
        model: deepseek-flash
        # 如果 B 用 API Key：provider: deepseek-official，并确保 B 的 DSH 凭据/env
        # 里有可用的 DEEPSEEK_API_KEY。若 B 用的是自定义/第三方 provider（在 B 的
        # desktop profile patch 里配置的那套），需要把对应 provider 配置与 provider/model
        # 也加到本 worker profile 的 patch 里。
```

> worker 直接使用 B 的默认 DSH_HOME（`~/.dsh`），复用 B 上已有的模型登录。
> **不要**把 A 的 `.credentials.yaml` 复制到 B（会互相顶掉登录）；B 若未登录，先在 B 上正常打开 DSH 登录。
> 启动后用 `curl .../v1/hello` 看 `selection` 字段确认实际模型路由；如果 agent 报"模型不可用"，
> 改上面的 `provider`/`model` 后重启 worker。

### 1.5 启动并验证

```bash
dsh --profile dsh-worker                                        # 前台（调试用）
# 或后台常驻：
nohup dsh --profile dsh-worker > ~/dsh-worker.log 2>&1 &
```

B 本机验证：

```bash
curl -s -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:7801/v1/hello
# 期望 {"ok":true,...,"permissionPreset":"danger-full-access",...}
```

A 上跨机验证（在 A 的仓库/工作副本里执行）：

```powershell
$node = 'C:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node .\tools\worker-smoke.mjs 'http://<B 的 IP>:7801' '<TOKEN>'
# 期望最后一行 SMOKE OK（验证 hello/建会话/真实模型回复/关闭/resume）
```

### 1.6 防火墙

- macOS：系统设置 → 网络 → 防火墙 → 选项，允许 `dsh`/终端接受传入连接。
- Linux：`sudo ufw allow 7801/tcp`（或对应防火墙工具）。
- 更安全：`listenHost` 填 B 的具体内网 IP，而不是 `0.0.0.0`。

---

## 2. A 端（本机）配置

### 2.1 挂载 controller

在 A 的 DSH profile patch（Desktop 版为
`~/.dsh/profiles/desktop/cordis.patch.yml`，Windows 用户目录对应 `C:\Users\<你>\.dsh\...`）中加：

```yaml
- insert:
    - id: remote-control
      name: 'file:///<A 上仓库/工作副本的绝对路径>/lib/controller.js'
      config:
        hosts:
          - name: work-mac
            endpoint: 'http://192.168.1.20:7801'
            token: '<与 B 的 worker 相同的 TOKEN>'
            description: '办公室 Mac'
            # workdir: '/Users/me/work'    # 可选：远端默认工作目录
        startWaitMs: 15000            # 可选
        defaultWaitTimeoutMs: 45000   # 可选
```

保存后 **无需重启 DSH**（profile patch 由 HMR 实时重载）；首次挂载插件代码或更新插件代码后建议重启一次
DSH，以便重新 import 最新的 `lib/*.js`。

### 2.2 验证与使用

在 A 的 DSH 聊天里说：

> 看看远端电脑是否在线

agent 会调用 `remote_dsh_hosts`；显示 online 后即可：

- 「在另一台电脑上，把 `~/work` 里的测试跑一遍，告诉我失败原因」
- 「让 work-mac 整理桌面截图，按日期归档」
- 「远端那个会话继续：把脚本改成带日志的版本」

工具：`remote_dsh_hosts`、`remote_dsh_start`、`remote_dsh_wait`、`remote_dsh_send`、
`remote_dsh_status`、`remote_dsh_log`、`remote_dsh_abort`。

---

## 3. 安全须知

1. token 等于 B 上的任意执行权限；不要外发、不要提交到仓库。
2. 同网段明文 HTTP，仅在自己可控的可信局域网使用；跨不可信网络请先上 VPN 或自行加 TLS 反向代理。
3. `permissionPreset: danger-full-access` 让远端会话可执行任意命令；只在你自己的电脑上启用。
   它只影响 worker 创建的会话，不改 B 自己 GUI 会话的策略。
4. 停止 B 的 worker 进程后，A 端立即无法再操作 B。

---

## 4. 运维与排障

| 场景 | 操作 |
| --- | --- |
| 查看 B 日志 | `~/dsh-worker.log`（nohup 时）或前台输出 |
| 停止 B worker | 前台 Ctrl+C；后台 `pkill -f "profile dsh-worker"` |
| 换 token | 改 B 配置并重启 worker；改 A 的 `hosts[].token` 保存即可 |
| 多台远端 | A 的 `hosts` 追加条目；工具用 `host` 参数区分 |
| 暂停远程功能 | A 的 `hosts: []` 保存 |
| 卸载 B | 停 worker；删 `~/.dsh/profiles/dsh-worker` 与 `~/dsh-remote-control` |
| 显示 OFFLINE | B worker 没启动 / IP 端口错 / 防火墙 / 不同网段；先 `curl` B 本机，再从 A curl B IP |
| 401 auth/denied | 两端 token 不一致（注意空格换行）；改 B 后需重启 worker |
| 远端模型不可用 | B 的 DSH 登录/API Key 未配好；先确认 B 本机能正常开 DSH 会话 |
| A 升级 DSH 后工具消失 | 升级可能重置 profile patch；重新加入上面的 `- insert:` 段 |
| 更新插件代码后行为没变 | HMR 只重载配置不重新 import 模块；重启 DSH 或按开发模式配置 HMR module root |

---

## 5. 可选安装方式：作为 DSH bundle 安装（方式 B）

前提：B 能访问该 git 仓库与 npm registry（DSH 自带 pnpm）；公开仓库免凭据，私有仓库需 B 上有访问凭据。
本仓库根目录就是包本身，带 `dsh.bundle.patch`，可以直接按 bundle 安装：

```bash
dsh plugin --profile dsh-worker add git+<repo-url>
# 或固定提交：dsh plugin --profile dsh-worker add 'git+<repo-url>#<commit>'
```

首次执行会自动初始化一个 **base profile**，并把它加入 `dsh.profile.bundles`；bundle 的
`cordis.patch.yml` 会向组合中插入一条默认禁用的 `remote-control` 行。随后编辑
`~/.dsh/profiles/dsh-worker/cordis.patch.yml` 启用并配置：

```yaml
- id: remote-control
  disabled: false
  config:
    role: worker
    token: '<TOKEN>'
    listenHost: '0.0.0.0'
    port: 7801
    workspaceRoot: '/Users/<你>/dsh-work'
    permissionPreset: danger-full-access
    provider: deepseek-account      # 见 1.4 节模型路由说明
    model: deepseek-flash
```

然后 `dsh --profile dsh-worker` 启动即可（base profile 没有 stdio app，插件自己让进程常驻）。
验证方式与 1.5 节相同。

> 该方式已在本机用 `git+file://` 的本地仓库实测：bundle 安装成功、组合出
> `remote-control` 行、base profile 启动后 `/v1/hello` 正常返回。真实 GitHub/Gitee 地址同理，
> 只是需要 B 能 `git ls-remote` / `pnpm` 访问该仓库；若 B 网络受限，请使用方式 A（clone + file URL）。

---

## 6. 开发

```bash
node --test test/bridge.test.mjs                              # 单元 + 端到端（假 DSH）测试
node tools/worker-smoke.mjs http://127.0.0.1:7801 <token>     # 对真实 worker 冒烟
node tools/worker-client.mjs http://127.0.0.1:7801 <token> "任务"
```

插件零第三方依赖，只用 Node 内置模块；不 import 任何 `@deepseek-ai/*` 包，
因此既能作为安装包加载，也能通过 profile patch 的 file URL 直接加载。
