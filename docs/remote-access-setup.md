# CodePilot 远程访问设置

通过 SSH 反向隧道 + Caddy 反向代理，实现从任何地方安全访问运行在 Mac 上的 CodePilot。

## 架构

```
手机/浏览器
  │
  ▼  HTTPS (443)
Azure VM (20.109.142.51)
  │  Caddy: HTTPS 证书 + Basic Auth + 反向代理
  ▼
  localhost:8080
  │  SSH 反向隧道 (Mac 主动建立)
  ▼
Mac:4000 (CodePilot)
```

## 访问地址

```
https://ccpilot.swifttools.eu
用户名: kuangqie
密码: 123!@
```

## 组件说明

### 1. SSH 密钥 (Mac)

- **私钥**: `~/.ssh/id_ed25519`
- **公钥**: `~/.ssh/id_ed25519.pub` (已部署到 Azure VM)
- **算法**: ed25519, 无密码短语 (launchd 需要免密)

### 2. SSH Config (Mac)

文件: `~/.ssh/config`

```
Host codepilot-tunnel
    HostName 20.109.142.51
    User demouser
    Port 22
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ExitOnForwardFailure yes
```

**换 IP/服务器时只需改这里的 `HostName`**，其他配置不用动。

### 3. SSH 隧道 launchd 服务 (Mac)

文件: `~/Library/LaunchAgents/com.codepilot.tunnel.plist`

- 开机自启 (`RunAtLoad`)
- 断线自动重连 (`KeepAlive`)
- 重试间隔 10 秒 (`ThrottleInterval`)
- 心跳保活 30 秒 (SSH Config 中 `ServerAliveInterval`)
- 日志: `~/.codepilot/tunnel.log`, `~/.codepilot/tunnel.error.log`

### 4. Caddy 反向代理 (Azure VM)

文件: `/etc/caddy/Caddyfile`

```
ccpilot.swifttools.eu {
    basic_auth * {
        kuangqie $2a$14$nHrRXGU08UTfsP2/S5iQW.fERlvBrvfuOxcJ0fV2lcIWLo0/xMqqC
    }

    reverse_proxy localhost:8080 {
        flush_interval -1
        header_up Connection {>Connection}
        header_up Upgrade {>Upgrade}
    }
}
```

功能:
- **自动 HTTPS**: Let's Encrypt 证书, 自动续期
- **Basic Auth**: 密码保护
- **SSE 支持**: `flush_interval -1` 禁用缓冲, 流式响应即时推送
- **WebSocket**: `Connection`/`Upgrade` header 透传
- **HTTP→HTTPS 重定向**: 自动

### 5. DNS (GoDaddy)

```
域名: swifttools.eu
记录: A | ccpilot | 20.109.142.51 | TTL 600
```

### 6. Azure NSG 入站规则

| 端口 | 用途 |
|------|------|
| 22   | SSH (管理 + 隧道) |
| 443  | HTTPS (CodePilot 访问) |
| 80   | HTTP (Let's Encrypt 证书续期, Caddy 自动重定向到 HTTPS) |

## 日常运维

### 检查隧道状态

```bash
# Mac 上
launchctl print gui/$(id -u)/com.codepilot.tunnel

# Azure 上检查端口
ssh codepilot-tunnel "ss -tlnp | grep 8080"
```

### 重启隧道

```bash
launchctl kickstart -k gui/$(id -u)/com.codepilot.tunnel
```

### 查看隧道日志

```bash
cat ~/.codepilot/tunnel.log
cat ~/.codepilot/tunnel.error.log
```

### 检查 Caddy 状态 (Azure)

```bash
ssh codepilot-tunnel "sudo systemctl status caddy"
ssh codepilot-tunnel "sudo journalctl -u caddy --since '10 min ago' --no-pager"
```

### 重启 Caddy (Azure)

```bash
ssh codepilot-tunnel "sudo systemctl restart caddy"
```

## 换 IP / 换服务器

如果 Azure VM IP 变了或换了新服务器:

1. **更新 DNS**: GoDaddy → `ccpilot` A 记录 → 新 IP
2. **更新 SSH Config**: `~/.ssh/config` 中 `HostName` 改为新 IP
3. **传公钥到新服务器**: `ssh-copy-id -i ~/.ssh/id_ed25519.pub user@新IP`
4. **新服务器装 Caddy**: 重复安装和配置步骤
5. **重启隧道**: `launchctl kickstart -k gui/$(id -u)/com.codepilot.tunnel`

## 换域名

1. **新域名 DNS**: 添加 A 记录指向 Azure VM IP
2. **更新 Caddyfile**: `ssh codepilot-tunnel` 登录后修改 `/etc/caddy/Caddyfile` 中的域名
3. **重载 Caddy**: `sudo systemctl reload caddy` (Caddy 自动申请新证书)

## 故障排查

| 问题 | 排查 |
|------|------|
| 访问超时 | 检查隧道是否运行: `launchctl print gui/$(id -u)/com.codepilot.tunnel` |
| 502 Bad Gateway | 隧道断了或 CodePilot 没启动, 检查 Mac 上 4000 端口 |
| 证书错误 | DNS 是否正确? `dig ccpilot.swifttools.eu`, Caddy 日志检查证书状态 |
| 401 认证失败 | 用户名/密码错误, 或浏览器缓存了旧凭据 |
| SSH 连接被拒 | Azure NSG 22 端口是否开放? SSH 密钥是否匹配? |

## 所有相关服务 (Mac)

| 服务 | plist | 用途 |
|------|-------|------|
| `com.codepilot.web` | `~/Library/LaunchAgents/com.codepilot.web.plist` | CodePilot Next.js (port 4000) |
| `com.codepilot.tunnel` | `~/Library/LaunchAgents/com.codepilot.tunnel.plist` | SSH 反向隧道到 Azure |
| `com.codepilot.caddy` | `~/Library/LaunchAgents/com.codepilot.caddy.plist` | 本地 Caddy (Tailscale 用) |
| `com.codepilot.cert-renew` | `~/Library/LaunchAgents/com.codepilot.cert-renew.plist` | 本地证书续期 |
