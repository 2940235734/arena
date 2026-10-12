# MCP 使用说明（Arena AI MCP）

将 VS Code 当前工作区接入 MCP（Model Context Protocol）客户端的独立实现：VS Code 扩展 + PHP 后端。无需公网映射、WebSocket、Composer 或数据库，扩展主动连接后端，MCP 客户端通过 Streamable HTTP 访问工作区工具。

MCP 仓库地址：**[https://github.com/2940235734/Mcp](https://github.com/2940235734/Mcp)** —— 在这里下载 `Arena-mcp-1.6.0.vsix` 扩展及最新说明。

## 架构

```text
MCP 客户端 ── HTTPS /mcp/w_ID + MCP Bearer ──> PHP-FPM
                                                    │ 文件锁任务队列
VS Code 扩展 ── HTTPS /api/bridge/w_ID/poll ──────────┤
             <── 有租约的任务                        │
             ── /result + 独立 Bridge Bearer ────────┘
```

扩展主动连接后端，电脑无需开放端口。后端只负责认证和任务转发，不保存工作区文件。

## 系统要求

- VS Code 1.96 或更高版本，本地文件或远程扩展主机上的 `file:` 工作区；不支持虚拟文件系统。
- PHP 8.2+，生产环境使用多 worker 的 PHP-FPM（内置 `json`、`hash` 等模块即可）。
- HTTPS 域名（默认 `https://mcp.j0a.cn`）。

## 一、安装 VS Code 扩展

1. 从 [MCP 仓库](https://github.com/2940235734/Mcp) 下载 `Arena-mcp-1.6.0.vsix`。
2. VS Code 扩展视图右上角菜单 → **从 VSIX 安装…**，选择该文件。
3. 打开一个**已信任**的文件工作区，左侧活动栏出现 Arena AI MCP 图标。

## 二、部署 PHP 后端

1. 将 `backend` 目录上传到服务器，站点运行目录设为 `backend/public`。
2. 复制 `config.example.php` 为 `config.php`（或运行 `php bin/console.php init` 自动生成），修改：
   - `app_key`：64 位随机十六进制字符；
   - `public_url`：你的 HTTPS 域名；
   - `allowed_hosts` / `allowed_origins`：填写你的域名；
   - `storage_dir`：后端私有存储目录。
3. 确认权限：PHP-FPM 用户可读取 `config.php`，可读写 `storage`。
4. 多 worker PHP-FPM 是生产运行前提；Windows 单进程 `php -S` 仅用于本机测试。

## 三、首次绑定工作区

1. 打开目标工作区，点击侧栏 Arena AI MCP 面板。
2. 点击 **绑定并连接当前工作区**。1.6.0 起首次绑定**不需要服务器级令牌**。
3. 服务器自动生成独立的 `w_...` 绑定 ID，以及 `bridge_` / `mcp_` 凭据。
4. 面板可执行：
   - **选择或更换项目**：切换绑定到其他工作区目录，各项目保留独立链接；
   - **诊断连接**：只访问健康接口，不发送凭据、不创建绑定；
   - **重新随机生成**：为所选工作区更换绑定与凭据，旧链接、旧会话和其他窗口连接失效；
   - **移除本机绑定凭据** / **断开当前连接**。

## 四、配置 MCP 客户端

MCP 地址为 `https://mcp.j0a.cn/mcp/w_WORKSPACE_ID`，不是域名首页。`TOKEN` 是服务器发放的 **`mcp_...`** 工作区令牌，不是 pair/bridge 令牌。

VS Code 的 `mcp.json`：

```json
{
  "servers": {
    "j0a-workspace": {
      "type": "http",
      "url": "https://mcp.j0a.cn/mcp/w_WORKSPACE_ID",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

其他客户端字段可能叫 `mcpServers`、`http` 或 `streamable-http`，按客户端文档填写同一 URL 和 `Authorization` 请求头。**不要把含真实令牌的配置提交到 Git。**

## 五、非原生客户端 HTTP POST 接入

支持 MCP 的客户端请直接添加；无法原生连接时，用 HTTP POST 按顺序发送以下四个独立请求（不要合并批量），每一步都带 `Authorization: Bearer TOKEN`、`Content-Type: application/json` 和 `Accept: application/json, text/event-stream`：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"http-client","version":"1.0.0"}}}
```

从响应头保存 `MCP-Session-Id`，从响应正文保存 `result.protocolVersion` 和 `result.instructions`，后续请求带上 `MCP-Session-Id` 和 `MCP-Protocol-Version` 请求头：

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

此通知成功返回 HTTP 202 和空正文，无需解析 JSON。然后调用 `tools/list`，最后调用 `workspace_status` 确认项目在线，再等待下一条指令：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workspace_status","arguments":{}}}
```

## 六、可用工具

只读工具（始终可见）：

| 工具 | 说明 |
| --- | --- |
| `workspace_info` | 读取工作区名称与工具权限，不返回本机绝对路径 |
| `workspace_status` | 确认已绑定工作区是否在线，返回项目名称与当前权限 |
| `list_files` | 列出工作区内文件，跳过凭据、依赖与符号链接，返回相对路径 |
| `read_file` | 按行读取工作区内 UTF-8 文本，拒绝凭据文件和二进制文件 |
| `search_files` | 工作区内大小写敏感的普通文本搜索，非正则表达式 |
| `get_diagnostics` | 读取 VS Code 已有的诊断结果，不运行外部命令 |

写入工具（默认开启，`j0aMcp.enableWrites`，直接执行，不弹确认窗）：

| 工具 | 说明 |
| --- | --- |
| `write_file` | 新建或覆盖工作区内 UTF-8 文本文件 |
| `create_file` | 仅新建文本文件，目标已存在时失败 |
| `delete_file` | 删除工作区内普通文件，不删除目录 |
| `move_file` | 工作区内移动普通文件，不覆盖目标 |

命令工具（默认关闭）：

| 工具 | 说明 |
| --- | --- |
| `run_command` | 仅执行 `j0aMcp.allowedCommands` 中预先配置的固定命令 ID |

## 七、安全与权限

- 访问限于当前所选工作区根目录，拒绝路径穿越、绝对路径、符号链接、凭据文件、依赖目录和超大文件。
- 文本文件上限 128 KiB，请求上限 1 MiB，队列上限 64；工具超时默认 25 秒，最长可配置 60 秒，无自动重放。
- `run_command` 默认关闭；开启 `j0aMcp.enableCommands` 后只能调用白名单中的固定命令 ID，无 shell 子进程、不提权、不跨出工作区。
- 工作区接口始终要求 Bearer 认证；默认用 `Authorization` 请求头，不建议开启 URL 令牌模式。
- 断开连接只关闭本窗口桥接，不等同于撤销服务端凭据；永久撤销需使用 PHP 管理 CLI。
- 多窗口共享绑定，但各自持有任务领取租约；重新随机生成后旧窗口的连接会失效并返回 409。

## 八、常见问题

- **503**：检查 PHP-FPM 用户对 `config.php` 的读取权限、对 `storage` 的读写权限，以及站点运行目录是否为 `backend/public`。
- **`isError: true` 的 `workspace_status`**：工作区离线或超时，不能据此报告在线，请先在 VS Code 中重连。
- **Cloudflare/reCAPTCHA 质询**：需要在站点配置中对 MCP/API 入口排除质询，插件不会自动完成网页质询或降低 TLS 校验。
- **409 更换请求失败**：服务端要求匹配当前绑定 ID，过期窗口请先移除本机绑定再重新连接。
- **只支持旧 `/sse` 的客户端**：本实现不提供旧式独立 SSE 服务，请升级到支持 Streamable HTTP 的客户端。

## 九、本机开发与测试

```powershell
cd E:\EasyAI\workspace-mcp
npm install
npm test
cd extension
npm install
npm run check
npm run package
```

调试扩展可在 VS Code 的 Extension Development Host 中加载 `extension` 目录；后端可用 `MCP_PUBLIC_URL=http://127.0.0.1:端口`、`MCP_ALLOWED_HOSTS=127.0.0.1` 配合扩展用户设置做本机调试，生产环境只用 HTTPS。