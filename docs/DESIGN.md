# DSH 远程控制插件：设计说明

> 目标：在本机 A 的 DeepSeek Harness（DSH）里，直接让另一台电脑 B 上的 DSH 执行会话任务，
> 并把过程和结果拿回 A。用户已确认的约束：B 为 macOS/Linux、与本机同一局域网；
> 阶段 A 先做「本机 agent 通过工具把任务发给远端」；阶段 B 再做「本机 DSH 界面里的远程电脑页面」；
> 远端先采用自动执行（不把审批转回本机）。

## 1. 交付物

| 位置 | 内容 |
| --- | --- |
| `（本仓库根目录）` | 插件本体（零外部依赖，单包两端：controller / worker） |
| `lib/protocol.js` | HTTP JSON 协议、事件→转录文本渲染、会话转录环形缓冲 |
| `lib/worker.js` | 被控端：LAN HTTP 服务 + 用 `ctx.agents` 驱动真实 DSH 会话 |
| `lib/controller.js` | 控制端：注册 9 个 `remote_dsh_*` agent 工具（含配对） |
| `scripts/worker-setup.sh` | B 端一键自配置脚本（找 dsh、装插件、生成 token、选端口、写配置、启动、打印配对码） |
| `lib/index.js` | bundle 入口（按 `config.role` 分发） |
| `plugins/dsh-remote-control/tools/worker-smoke.mjs` | 冒烟测试（含 resume） |
| `plugins/dsh-remote-control/tools/worker-client.mjs` | 手工调试客户端（直接发任务到 worker） |
| `plugins/dsh-remote-control/tools/sdk-drive.mjs` | 用 SDK stdio 驱动一个 DSH 会话的测试工具 |
| `docs/SETUP.md` | 安装 / 使用 / 排障指南（用户主文档） |
| （开发仓库内部侦察文档，未随插件发布） | 更完整的 DSH 内部能力侦察与备选方案（R1/R2/R3/R4） |

本机 A 的 Desktop DSH 已经装好 controller 并实测通过；B 端需要按用户指南部署 worker。

## 2. 已实测的端到端结论（证据）

1. **worker 可在独立 DSH profile 中运行**：用 `--from-default-profile sdk` 初始化 profile，禁用
   `sdk-app-startup` / `sdk-jsonrpc-server` 两条 stdio 行、insert worker 行后，
   `dsh --profile worker` 常驻，`GET /v1/hello` 返回 200。
2. **真实模型会话**：worker 用 `ctx.agents.create()` 创建会话、`agent.followup()` 入队提示词、
   `agent.whenIdle()` 等待，得到真实模型回复（`deepseek-official/deepseek-flash`，
   也验证过 `deepseek-account` 账号路由）。
3. **中文无损**：Node HTTP 客户端发送中文提示词、远端回复中文，全程 UTF-8 正常。
4. **远端自动执行**：worker 对新建会话调用 `ctx.permissionPresets.set(session, 'danger-full-access')`，
   会话运行时上下文显示 `Current DSH file policy: danger-full-access`、审批关闭，
   远端可写工作区外路径（`D:\ai-remote-test.txt`，测试后删除）。
5. **会话持久化与 resume**：close 后 `POST /v1/sessions/resume` 能恢复同一持久会话并继续回答（smoke 测试 PASS）。
6. **controller 在真实 agent 循环中可用**：
   - 在 SDK profile 的 agent 里，模型自主调用 `remote_dsh_hosts / start / wait` 并正确总结远端结果；
   - 在本机 Desktop app 的当前会话里（HMR 实时加载插件后），模型侧工具列表出现 `remote_dsh_*` 工具
     工具，并成功用 `remote_dsh_start` 在 worker 上跑完任务、拿回中文回答。
7. **HMR 热生效**：向 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加插件行或修改 `hosts` 后，
   无需重启 DSH，下一步即生效（已改回 `hosts: []`，等待用户填真实远端）。

## 2.5 零配置安装（0.2.0 起）

- **B 端自配置**：`scripts/worker-setup.sh` 一条命令完成 找 dsh → clone 仓库 → 建 profile →
  生成/复用 token → 选空闲端口 → 写 profile patch → 建 workspace → 后台启动 → 等待 `/v1/hello` →
  打印配对码；支持 `--dry-run/--status/--stop/--mode bundle`，重复运行即升级并重启（token 复用）。
- **worker 自身容错**：未配置 token 时自动生成（不再拒绝启动）；配置端口被占用时自动
  顺延到下一个空闲端口；启动后把 endpoint/token/配对码写入 `<DSH_HOME>/dsh-remote-control/worker.json`（0600）。
- **A 端配对**：新增 `remote_dsh_pair` / `remote_dsh_unpair` 工具，A 的 agent 收到配对码后
  验证并写入 `<DSH_HOME>/dsh-remote-control/hosts.json`（0600），与 config.hosts 合并使用，
  因此加远端不需要编辑 profile 配置。

## 3. 架构

```
┌────────────── 本机 A（Windows, Desktop DSH）──────────────┐        ┌────── 电脑 B（macOS/Linux, DSH CLI）──────┐
│ 用户在聊天里说「让另一台电脑做 X」                        │        │                                          │
│   ↓                                                       │  LAN   │  dsh --profile dsh-worker                │
│ 本机 agent                                                   │  HTTP  │   └─ remote-control worker 插件          │
│   └─ remote_dsh_pair / start / wait / send / ...（9 个工具） │◀──────▶│        ├─ node:http 监听 :7801          │
│        controller 插件 ── Bearer token ── HTTP JSON ────────┼────────┼──▶      ├─ ctx.agents.create/resume       │
│                                                           │        │        ├─ agent.followup / whenIdle      │
│                                                           │        │        └─ session/event → 转录缓冲       │
└───────────────────────────────────────────────────────────┘        └──────────────────────────────────────────┘
```

- **两端同一个包、两种角色**：`config.role: controller | worker`；也可以把 profile 行直接指向
  `lib/controller.js` / `lib/worker.js`（本机安装即如此，免去 npm 安装）。
- **零第三方依赖**：只用 Node 内置 `node:http` / `node:crypto` / `node:fs` / `node:path` / `node:os`
  和服务端 `fetch`。插件不 import 任何 `@deepseek-ai/*` 包，所以既能按包安装、也能用文件 URL 直接加载。
- **worker 会话就是真正的 DSH 会话**：出现在 B 自己的会话存储里、用 B 的模型/工具/沙箱/skills；
  断线后可用 resume 恢复。
- **controller 只注册 agent 工具**，不改本地 UI（Phase B 才做 UI）。

## 4. 传输协议（worker HTTP API，`/v1`）

认证：所有请求需 `Authorization: Bearer <token>`（也接受 `?token=`，供浏览器/简单客户端用）。
请求/响应均为 JSON；错误体 `{ ok: false, error: { code, message } }` 并带合适 HTTP 状态码。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/health` | 存活探测（含协议版本、uptime） |
| GET | `/v1/hello` | 主机信息：hostname/platform/arch/cwd、模型路由、可用 provider、会话数 |
| GET | `/v1/sessions` | 列出本 worker 创建的活会话 |
| POST | `/v1/sessions` | 新建会话 `{ cwd?, provider?, model?, reasoningEffort?, maxTokens? }` → `{ sessionId, cwd, provider, model }` |
| POST | `/v1/sessions/resume` | 恢复持久会话 `{ sessionId, provider?, model? }` → `{ sessionId, cwd, resumed }` |
| GET | `/v1/sessions/:id` | 单会话状态（status/idle/seq/title/turns/lastAssistantText/error） |
| GET | `/v1/sessions/:id/events?afterSeq&limit&maxChars` | 按持久 seq 游标读转录（增量） |
| GET | `/v1/sessions/:id/wait?timeoutMs&afterSeq` | **长轮询**到 idle 或超时，返回增量转录；客户端断开即中止等待 |
| POST | `/v1/sessions/:id/prompt` | 入队用户消息 `{ text }`（立即返回 messageId） |
| POST | `/v1/sessions/:id/abort` | 取消当前轮次（`agent.cancel({ kind: 'user' })`） |
| POST | `/v1/sessions/:id/close` | 处置 agent 句柄（持久会话日志保留，可 resume） |

**游标语义**：游标是 DSH 会话事件的持久 `seq`，controller 按 `host/sessionId` 记住"最后已读 seq"，
所以 `wait` 只返回新内容、token 成本可控。**转录渲染**只挑选模型需要的 durable 事件：
user/assistant 消息、tool call/result（截断）、turn end（异常时）、权限/沙箱变更、压缩、错误；
工具结果默认截断到 900 字符，整段转录有字符预算（默认 12000），超长时保留头尾。

## 5. controller 的工具

| 工具 | 作用 |
| --- | --- |
| `remote_dsh_hosts` | 列出配置的远端 + 在线探测 + 型号/cwd；用户提到"另一台电脑"时先调它 |
| `remote_dsh_start` | 在远端建会话并入队任务；返回 sessionId + 初始进度（默认等 15s） |
| `remote_dsh_wait` | 长轮询到远端空闲（默认 45s），返回自上次读取以来的转录；循环调用直到 idle |
| `remote_dsh_send` | 向已有远端会话发后续消息（回答它的问题/追加要求） |
| `remote_dsh_status` | 单会话状态，或列出远端全部活会话 |
| `remote_dsh_log` | 不等待，直接读某游标之后的转录（回看中间细节） |
| `remote_dsh_abort` | 停止远端当前轮次 |
| `remote_dsh_pair` | 用 worker 打印的配对码（`dshrc1.…`）验证并持久保存远端，免改配置 |
| `remote_dsh_unpair` | 移除通过配对码添加的远端 |

工具描述里写明了正确用法（自包含 prompt、先 start 再 wait、远端是另一台机器），
实测模型（deepseek-account/deepseek-flash）能正确按此流程自主调用。

## 6. 安全模型与已知取舍

- **token 是唯一凭据**：控制端与被控端共享一个 ≥16 字符的随机 token；恒定时间比较。
  token 未配置时 worker 会自动生成并写入 `<DSH_HOME>/dsh-remote-control/worker.json`（0600），
  同时以配对码形式打印到日志；配对码等同 token，必须当作密码保管。
  未配置 token 时 worker 拒绝启动（不会静默裸奔）。
- **局域网明文 HTTP**：同一可信局域网场景；token 会以明文随请求传输，**不要**在不可信网络/公网使用。
  后续可加 TLS（`node:https` + 自签证书 + controller 指纹校验）或反向代理。
- **远端自动执行 = 远端可执行任意命令**：MVP 按用户选择采用 `danger-full-access`（按会话固定，
  只影响 worker 创建的会话，不影响 B 自己的 GUI 会话）。只应在自己控制的电脑上启用。
- **审批/提问暂不转发**：用户选择先自动执行。架构上 DSH 的 `approval/request`、
  `user-questions/request` 转发 waterfall 已存在，后续可把 B 的请求桥到 A 的
  `ctx.approval.request()` / `ctx.userQuestions.ask()`（见 （开发仓库内部侦察文档，未随插件发布） §4.3/§4.4）。
- **单 worker 内存会话表**：worker 进程重启后活会话列表丢失，需 `resume`（已实现）恢复；
  controller 侧也在内存里记游标，A 端进程重启后重新读即可（`afterSeq=0` 重读）。
- **会话数量上限**：worker 默认最多 8 个活会话（`maxSessions`），防止失控占用。

## 7. 配置参考

### controller（A 端，本机 desktop profile patch）

```yaml
- insert:
    - id: remote-control
      name: 'file:///D:/AIProjects/DSHDev/plugins/dsh-remote-control/lib/controller.js'
      config:
        hosts:
          - name: work-mac
            endpoint: 'http://192.168.1.20:7801'
            token: '<与 worker 相同的 token>'
            description: '办公室 Mac'
            # workdir: '/Users/me/work'   # 可选：远端默认工作目录
        startWaitMs: 15000            # 可选
        defaultWaitTimeoutMs: 45000   # 可选
        maxWaitTimeoutMs: 120000      # 可选
```

### worker（B 端 profile patch）

```yaml
- insert:
    - id: remote-control-worker
      name: 'file:///Users/me/dsh-remote-control/lib/worker.js'   # B 上插件目录的绝对路径/文件 URL
      config:
        token: '<与 controller 相同的 token>'
        listenHost: '0.0.0.0'        # 局域网监听；也可填具体网卡 IP
        port: 7801
        workspaceRoot: '/Users/me/work'   # 可选；会话默认 cwd 且限制 cwd 不越界
        permissionPreset: danger-full-access   # 默认值；null 表示沿用 B 自己的默认策略
        maxSessions: 8
        provider: deepseek-account    # 可选；省略则用 B 的 agentDefaultModel.selection
        model: deepseek-flash
```

## 8. Phase B：本机 DSH 界面里的「远程电脑」页面（待实现）

目标 UX：本地 GUI 侧边栏出现「远程电脑」，列表显示各远端在线状态与会话，点开可直接发消息、
看流式转录，像操作本地会话一样。

**已核实的关键限制**（见 （开发仓库内部文档，未随插件发布） §6 与 （开发仓库内部侦察文档，未随插件发布） §7.3）：
DSH 的 **Client/React UI 插件不是纯 JS 能手写的**——需要 `dsh.client = { platform: 'web', ... }`
声明 + 预构建的浏览器 bundle，而该 bundle 依赖 DSH 仓库的构建工具链（随附包的 `lib/client.js`
是 626KB 级打包产物）。当前机器只有安装包（app.asar），没有 DSH 源码仓库/构建链。
因此 Phase B 建议分两条路线：

### B-1（推荐先做，零构建链）：本机 Host 插件自带的独立页面

1. controller Host 插件在本地 DSH 的 web 服务上注册同源 HTTP 路由（`ctx.webServer` 的
   route/index-inject 机制，证据见 （开发仓库内部侦察文档，未随插件发布） §2.2 与
   `dsh-host-webserver` README），提供：
   - `GET  /remote-control/api/hosts`（状态）
   - `GET  /remote-control/api/sessions?host=`
   - `POST /remote-control/api/sessions`（新建）
   - `POST /remote-control/api/prompt`
   - `GET  /remote-control/api/events?host=&sessionId=&afterSeq=`（SSE 或长轮询）
   - `GET  /remote-control/`（返回自带的单文件 HTML+JS 管理页面）
2. 页面用原生 HTML/JS/CSS（无 React、无构建步骤），由 Host 插件 `readFile` 静态提供；
   认证沿用 DSH 现有 cookie / browser-trust fence。
3. 入口：在 DSH 里打开 `http://127.0.0.1:<当前 GUI 端口>/remote-control/`（可收藏），
   或由 host 插件在系统浏览器打开。功能：主机列表 + 在线状态、会话列表、新会话、对话流、
   中断按钮。
4. 验收：不打开远端浏览器，仅在本机页面完成"新会话 → 发消息 → 看到远端工具调用/回复"；
   断线重连按 seq 补齐；离线 host 显示明确错误。

这条路线**不需要 DSH 构建工具链**，是当前条件下最快能落地的"页面"形态；缺点是不是
侧边栏原生入口，而是一个同源标签页。

### B-2（需要 DSH 源码仓库 + 构建链）：侧边栏原生页面

若后续能拿到 DSH 仓库并构建前端（`pnpm run build`），再按原计划实现 Client 插件：

1. 新 client 包（`dsh.client` 声明 + `./client` 浏览器入口），用 Web 客户端已有的
   slot/sidebar 注册机制加页面（参考 `dsh-client-ui-sidebar`、`dsh-client-ui-settings` 等
   包的 README 与 `lib/client.js` 产物结构）。
2. Host 侧复用 B-1 的同源路由；页面通过 `fetch` 调它们。
3. 接入 web/desktop profile 的浏览器插件栏，支持浏览器侧 HMR。

工作量估计：B-1 Host 路由 + 单文件页面约 1~2 天；B-2 需要构建链与 client 插件 API 熟悉，
约 2~3 天。在 Phase B 完成前，Phase A 已经可以满足"在本机用自然语言指挥另一台电脑执行 DSH 会话任务"。

## 9. 后续可选项

- 审批/用户提问转发（B → A，复用 A 原生审批卡）。
- TLS + token 轮换 + 主机白名单。
- 反向连接（B 主动连 A，适配 NAT/不同网络）。
- 多 A 控制端并发/租约；B 端会话列表与历史同步。
- 直接复用 DSH 官方 `session/*` Remote 端点（R2 完整版）以获得分页/投影/事件保真
  （见 （开发仓库内部侦察文档，未随插件发布） §4、§5.2）。
