#!/bin/bash
# 更换 Azure VM IP 后，一键更新所有相关配置
# 用法: ./scripts/change-azure-ip.sh <新IP>

set -e

NEW_IP="$1"

if [ -z "$NEW_IP" ]; then
    echo "用法: $0 <新IP>"
    echo "例如: $0 52.123.45.67"
    exit 1
fi

# 验证 IP 格式
if ! echo "$NEW_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "错误: IP 格式不对 — $NEW_IP"
    exit 1
fi

# 读取旧 IP
OLD_IP=$(grep -A1 'Host codepilot-tunnel' ~/.ssh/config | grep HostName | awk '{print $2}')
if [ -z "$OLD_IP" ]; then
    echo "错误: 无法从 ~/.ssh/config 读取旧 IP"
    exit 1
fi

if [ "$OLD_IP" = "$NEW_IP" ]; then
    echo "IP 没变，还是 $OLD_IP，不需要更新。"
    exit 0
fi

echo "=========================================="
echo "  Azure VM IP 更新"
echo "  旧 IP: $OLD_IP"
echo "  新 IP: $NEW_IP"
echo "=========================================="
echo ""

# 1. SSH Config
echo "[1/5] 更新 ~/.ssh/config ..."
sed -i.bak "s/HostName $OLD_IP/HostName $NEW_IP/" ~/.ssh/config
echo "  ✅ SSH config 已更新"

# 2. SSH 公钥 — 提示手动操作
echo ""
echo "[2/5] SSH 公钥..."
echo "  ⚠️  如果是全新 VM，需要手动执行:"
echo "     ssh-copy-id -i ~/.ssh/id_ed25519.pub demouser@$NEW_IP"
echo "  如果只是换了 IP（同一台 VM），可以跳过。"
echo ""
read -p "  按 Enter 继续..."

# 3. 测试 SSH 连接
echo ""
echo "[3/5] 测试 SSH 连接..."
if ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new codepilot-tunnel "echo '  ✅ SSH 连接成功'" 2>/dev/null; then
    :
else
    echo "  ❌ SSH 连接失败！检查:"
    echo "     - 新 IP 是否正确"
    echo "     - SSH 公钥是否已部署"
    echo "     - Azure NSG 22 端口是否开放"
    exit 1
fi

# 4. 重启 SSH 隧道
echo ""
echo "[4/5] 重启 SSH 隧道..."
launchctl kickstart -k gui/$(id -u)/com.codepilot.tunnel 2>/dev/null || true
echo "  ✅ SSH 隧道已重启"

# 5. 生成新的 Xray 连接链接
echo ""
echo "[5/5] 生成新的客户端连接信息..."

# Xray Reality 链接
XRAY_LINK="vless://f6ea9362-167b-4347-8857-9b6197a74d7c@${NEW_IP}:8443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Cl863Z-RAcQ669OHsYLh7Dkfl2ero-KV0CCtxz8H70c&sid=948e60e72025da79&type=tcp#Azure-Reality"

echo ""
echo "=========================================="
echo "  ✅ 全部更新完成！"
echo "=========================================="
echo ""
echo "📋 还需要手动操作:"
echo ""
echo "1. GoDaddy DNS — 改 ccpilot A 记录为 $NEW_IP"
echo "   https://dcc.godaddy.com/manage-dns"
echo ""
echo "2. Xray 客户端 — 删旧配置，导入新链接:"
echo "   $XRAY_LINK"
echo ""
echo "3. RustDesk 客户端 — ID Server 改为 $NEW_IP"
echo ""
echo "4. (可选) 更新 docs/xray-reality-setup.md 中的 IP"
echo ""
