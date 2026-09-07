#!/usr/bin/env bash
# 探测每条已存凭证是否仍然有效。
#
# 背景：企业微信每次授权新建一个机器人。问题是旧机器人的凭证还能不能用 ——
# 这决定「同一人重复授权时能否复用旧凭证」这个设计是否可行。
# 用只读的 contact.users.search 探，errcode=853005 表示 cli token invalid。
#
# 用法： bash scripts/probe-creds.sh <base-url> <region>
set -u
B="$1"; REGION="$2"
cd "$(dirname "$0")/.."

USERS=$(node scripts/mint-token.js --list --region "$REGION" 2>/dev/null \
  | grep -oE 'u_[0-9a-f]{32}')

for u in $USERS; do
  node scripts/mint-token.js --user "$u" --region "$REGION" --out /tmp/probe.tok >/dev/null 2>&1
  R=$(curl -s --max-time 90 -X POST "$B/mcp" \
        -H "authorization: $(cat /tmp/probe.tok)" \
        -H 'content-type: application/json' \
        -H 'accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wecom_contact_users_search","arguments":{"keyword":"__wecom_mcp_identity_probe__"}}}' \
      | grep '^data: ' | sed 's/^data: //')
  echo "$R" | REF="${u:0:14}" python3 tools/classify-probe.py
done
rm -f /tmp/probe.tok
