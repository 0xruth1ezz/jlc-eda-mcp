# JLC EDA MCP Server

这是从原 `jlc_import` 目录整理出来的独立仓库，用来让支持 Model Context Protocol 的客户端控制嘉立创 EDA。当前仓库路径是：

```bash
/Users/al/tmp/jlc-mcp
```

仓库包含三个部分：

- `src/`: MCP server，向 Codex、Claude Code、Cursor、Windsurf 等客户端暴露 PCB/原理图工具。
- `local_jlc_gateway.cjs`: 本机 gateway，接收 MCP server 的 HTTP 命令，并通过 WebSocket 转发给 EDA 插件。
- `jlc-bridge/`: 嘉立创 EDA 扩展插件，运行在 EDA 里执行实际操作。

## 架构

```text
MCP client
  -> stdio
MCP server: /Users/al/tmp/jlc-mcp/dist/index.js
  -> HTTP POST http://127.0.0.1:18800/command
local gateway: /Users/al/tmp/jlc-mcp/local_jlc_gateway.cjs
  -> WebSocket ws://127.0.0.1:18800/ws/bridge
jlc-bridge extension
  -> 嘉立创 EDA
```

MCP server 本身不直接控制 EDA，它只把工具调用发送给本机 gateway。`jlc-bridge` 插件启动后会连接 gateway 的 `/ws/bridge`，再由插件调用嘉立创 EDA 的扩展 API。

## 前置条件

- Node.js 18 或更新版本
- 嘉立创 EDA 专业版，能安装本地扩展
- 一个支持 MCP 的客户端
- 如需使用 `pcb_agent`，需要设置 `ANTHROPIC_API_KEY`

## 安装

```bash
cd /Users/al/tmp/jlc-mcp
npm install
npm run build
```

构建成功后，MCP 入口文件是：

```bash
/Users/al/tmp/jlc-mcp/dist/index.js
```

## 构建并安装 EDA 插件

```bash
cd /Users/al/tmp/jlc-mcp/jlc-bridge
npm install
npm run build
```

构建后会生成：

```text
/Users/al/tmp/jlc-mcp/jlc-bridge/build/jlc-bridge.eext
/Users/al/tmp/jlc-mcp/jlc-bridge/build/jlc-bridge.lcex
```

在嘉立创 EDA 里安装其中一个扩展包。插件会在 EDA 启动后自动尝试连接：

```text
ws://127.0.0.1:18800/ws/bridge
```

也可以在 EDA 的 `JLC Bridge` 菜单里查看状态或手动切换。

## 启动 gateway

在一个单独终端中运行：

```bash
cd /Users/al/tmp/jlc-mcp
npm run gateway
```

默认监听：

```text
http://127.0.0.1:18800
```

检查状态：

```bash
curl http://127.0.0.1:18800/state
```

如果 `bridgeConnected` 是 `true`，说明嘉立创 EDA 插件已经连上 gateway。

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `JLC_GATEWAY_HOST` | `127.0.0.1` | gateway 监听地址 |
| `JLC_GATEWAY_PORT` | `18800` | gateway 监听端口 |

## 配置 MCP 客户端

把下面配置加入你的 MCP 客户端配置文件。仓库里也有同样内容的 `mcp_config.example.json`。

```json
{
  "mcpServers": {
    "jlceda": {
      "command": "node",
      "args": [
        "/Users/al/tmp/jlc-mcp/dist/index.js"
      ],
      "env": {
        "GATEWAY_HTTP_URL": "http://127.0.0.1:18800/command"
      }
    }
  }
}
```

配置后重启 MCP 客户端。

如果要启用 `pcb_agent`，加上：

```json
{
  "env": {
    "GATEWAY_HTTP_URL": "http://127.0.0.1:18800/command",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "AGENT_MODEL": "claude-sonnet-4-20250514"
  }
}
```

## 运行顺序

1. 启动 gateway。
2. 打开嘉立创 EDA，并确认 `jlc-bridge` 插件已连接。
3. 启动或重启 MCP 客户端。
4. 在客户端里调用 `pcb_ping` 或 `pcb_get_state` 验证链路。

如果顺序反了也可以，插件和客户端可以稍后重连。但首次验证时按上面顺序更容易定位问题。

## 可用工具

当前 MCP server 注册 39 个工具，分组如下：

- 状态查询：`pcb_get_state`、`pcb_screenshot`、`pcb_run_drc`、`pcb_get_tracks`、`pcb_get_pads`、`pcb_get_net_primitives`、`pcb_get_board_info`、`pcb_get_feature_support`、`pcb_ping`
- 元件操作：`pcb_move_component`、`pcb_relocate_component`、`pcb_batch_move`、`pcb_select_component`、`pcb_delete_selected`、`pcb_create_component`
- 走线和过孔：`pcb_route_track`、`pcb_create_via`、`pcb_delete_tracks`、`pcb_delete_via`
- 铺铜和禁布区：`pcb_create_copper_pour`、`pcb_delete_pour`、`pcb_create_keepout`、`pcb_delete_keepout`
- 丝印：`pcb_get_silkscreens`、`pcb_move_silkscreen`、`pcb_auto_silkscreen`
- 高级规则：`pcb_create_diff_pair`、`pcb_list_diff_pairs`、`pcb_delete_diff_pair`、`pcb_create_equal_length`、`pcb_list_equal_lengths`、`pcb_delete_equal_length`
- 原理图：`sch_get_state`、`sch_get_netlist`、`sch_run_drc`、`pcb_open_document`
- 计算工具：`calc_impedance`、`calc_trace_width`
- Agent：`pcb_agent`，仅在设置 `ANTHROPIC_API_KEY` 后注册

所有 PCB 坐标和尺寸参数默认使用 mil。

## 本地验证

只验证 MCP server 能启动并列出工具，不需要 gateway：

```bash
cd /Users/al/tmp/jlc-mcp
npm run build
printf '%s\n' \
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node dist/index.js
```

端到端验证需要 gateway 和 EDA 插件都运行：

```bash
curl http://127.0.0.1:18800/state
```

然后在 MCP 客户端调用：

```text
pcb_ping
pcb_get_state
```

## 项目结构

```text
.
├── src/
│   ├── index.ts
│   ├── bridge-client.ts
│   ├── agent.ts
│   ├── calculators.ts
│   └── tools/
├── jlc-bridge/
│   ├── src/index.ts
│   ├── extension.json
│   ├── build/pack.js
│   ├── package.json
│   └── tsconfig.json
├── local_jlc_gateway.cjs
├── mcp_config.example.json
├── package.json
└── tsconfig.json
```

## 常见问题

### `jlc bridge is not connected`

gateway 已启动，但 EDA 插件没有连上。检查嘉立创 EDA 是否已打开、插件是否安装并启用，然后访问：

```bash
curl http://127.0.0.1:18800/state
```

### MCP 客户端找不到工具

先确认已经构建：

```bash
cd /Users/al/tmp/jlc-mcp
npm run build
```

再确认 MCP 配置里的路径是 `/Users/al/tmp/jlc-mcp/dist/index.js`，不是旧的 `jlc_import` 或 `/tmp/jlcmcp` 路径。

### 端口被占用

改 gateway 端口：

```bash
JLC_GATEWAY_PORT=18801 npm run gateway
```

同时把 MCP 配置改成：

```json
{
  "GATEWAY_HTTP_URL": "http://127.0.0.1:18801/command"
}
```

注意：当前 `jlc-bridge` 插件源码里默认连接 `ws://127.0.0.1:18800/ws/bridge`。如果改 gateway 端口，也需要同步修改 `jlc-bridge/src/index.ts` 里的 `WS_URL` 后重新构建并安装插件。
