# dsh-remote-control

DeepSeek Harness（DSH）跨机远程控制插件：一个包、两种角色，零第三方依赖。

- **controller**（控制端，装在你坐着的电脑 A）：向 DSH agent 注册 7 个 `remote_dsh_*` 工具，
  让你在聊天里直接指挥另一台电脑执行 DSH 会话任务。
- **worker**（被控端，装在另一台电脑 B）：常驻一个局域网 HTTP 服务，用 B 的本机 DSH
  创建/驱动真实会话，并把持久会话事件渲染成转录回传。

## 快速安装

### B 端（被控电脑）

```bash
git clone <repo-url> ~/dsh-remote-control
dsh --profile dsh-worker --from-default-profile sdk --dump-config > /dev/null
# 编辑 ~/.dsh/profiles/dsh-worker/cordis.patch.yml（见 docs/SETUP.md 1.4 节）
dsh --profile dsh-worker
```

### A 端（控制电脑）

在 DSH profile 的 `cordis.patch.yml` 中插入（路径换成 A 上本仓库的绝对路径）：

```yaml
- insert:
    - id: remote-control
      name: 'file:///path/to/dsh-remote-control/lib/controller.js'
      config:
        hosts:
          - name: work-mac
            endpoint: 'http://192.168.1.20:7801'
            token: '<与 worker 相同的 token>'
```

保存即由 HMR 生效（插件代码首次挂载/更新后重启一次 DSH）。

完整步骤（含 token、防火墙、验证脚本、排障、bundle 安装方式）见 **[docs/SETUP.md](docs/SETUP.md)**；
架构、协议、工具与 Phase B 计划见 **[docs/DESIGN.md](docs/DESIGN.md)**。

## 目录

```
lib/index.js       bundle 入口：按 config.role 分发（也可在 profile 里直接指向下面两个文件）
lib/controller.js  控制器：7 个 remote_dsh_* 工具 + HTTP 客户端 + 转录游标
lib/worker.js      被控端：HTTP JSON 服务 + 会话管理 + 权限预设 + 长轮询
lib/protocol.js    协议常量、认证、事件→转录文本渲染、SessionTranscript
tools/             调试/冒烟/测试驱动脚本
test/              node --test 用例（假 DSH 上下文 + 真实 HTTP）
docs/              安装指南（SETUP.md）与设计说明（DESIGN.md）
```

## 测试

```bash
node --test test/bridge.test.mjs
node tools/worker-smoke.mjs http://127.0.0.1:7801 <token>
```

## 兼容性

针对 DSH 0.2.1-rc.2 验证。插件只使用有文档的 Cordis 服务
（`agents`、`tools`、`permissionPresets`、会话事件），不 import 任何 `@deepseek-ai/*` 包，
因此既能作为安装包加载，也能通过 profile patch 的 file URL 直接加载。

## 安全

远端 worker 的 token 等于那台电脑上的任意执行权限；只在自己可控的局域网内使用，
不要把 token 提交进本仓库或发送到公共渠道。远端默认按会话启用 `danger-full-access`
（自动执行、无审批），仅在你自己控制的电脑上部署。
