#!/usr/bin/env bash
# refresh_token 授权类型的端到端实测。
#
# 走完整一遍：授权码 → 令牌对 → 用 refresh 续期 → 新 access 能调 MCP → 重放旧 refresh 应被拒。
# 需要一个**已有企业微信凭证**的 userId（授权码分支不查凭证，但 refresh 分支会查）。
#
# 用法： bash scripts/test-refresh.sh <base-url> <userId> <aws-cli> <region>
set -u

B="$1"; USER_ID="$2"; AWSC="$3"; REGION="$4"
CB="http://127.0.0.1:9000/cb"
# RFC 7636 附录 B 的示例对，verifier 已知，方便构造 PKCE
VERIFIER="dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
CHALLENGE="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
FLOW="reftest$(date +%s)"

jqf() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('$1',''))"; }

echo "① 注册 DCR 客户端"
CID=$(curl -s --max-time 30 -X POST "$B/register" -H 'content-type: application/json' \
  -d "{\"redirect_uris\":[\"$CB\"]}" | jqf client_id)
[ -n "$CID" ] || { echo "  ✗ 注册失败"; exit 1; }
echo "  client_id ${CID:0:24}…"

echo "② 写入测试流程记录（指向已有凭证的用户）"
cat > /tmp/reflow.json <<JSON
{
  "flowId":          { "S": "$FLOW" },
  "userId":          { "S": "$USER_ID" },
  "redirectUri":     { "S": "$CB" },
  "clientState":     { "S": "refresh-e2e" },
  "codeChallenge":   { "S": "$CHALLENGE" },
  "containerSession":{ "S": "" },
  "ttl":             { "N": "$(( $(date +%s) + 300 ))" }
}
JSON
"$AWSC" dynamodb put-item --table-name wecom-mcp-auth-flows --region "$REGION" \
  --item file:///tmp/reflow.json || exit 1
echo "  flowId $FLOW"

echo "③ 领取授权码"
CODE=$(curl -s --max-time 60 "$B/authorize/status?flow=$FLOW" \
  | python3 -c "import json,sys,urllib.parse as up; d=json.load(sys.stdin); r=d.get('redirect',''); print(up.parse_qs(up.urlparse(r).query).get('code',[''])[0])")
[ -n "$CODE" ] || { echo "  ✗ 没拿到 code"; exit 1; }
echo "  code ${CODE:0:12}…"

echo "④ 授权码换令牌对"
R1=$(curl -s --max-time 30 -X POST "$B/token" \
  -d "grant_type=authorization_code&code=$CODE&client_id=$CID&code_verifier=$VERIFIER&redirect_uri=$CB")
A1=$(echo "$R1" | jqf access_token); RT1=$(echo "$R1" | jqf refresh_token)
echo "  access  ${A1:0:16}…"
echo "  refresh ${RT1:0:16}…"
[ -n "$RT1" ] || { echo "  ✗ 没签发 refresh_token"; echo "  $R1"; exit 1; }

echo "⑤ 用 refresh 续期"
R2=$(curl -s --max-time 30 -X POST "$B/token" \
  -d "grant_type=refresh_token&refresh_token=$RT1&client_id=$CID")
A2=$(echo "$R2" | jqf access_token); RT2=$(echo "$R2" | jqf refresh_token)
[ -n "$A2" ] || { echo "  ✗ 续期失败: $R2"; exit 1; }
echo "  新 access  ${A2:0:16}…"
echo "  新 refresh ${RT2:0:16}…"
[ "$RT1" != "$RT2" ] && echo "  ✓ refresh 已轮换" || echo "  ✗ refresh 没换，轮换失效"

echo "⑥ 新 access 能调 MCP 吗"
N=$(curl -s --max-time 90 -X POST "$B/mcp" -H "authorization: Bearer $A2" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | grep '^data: ' | sed 's/^data: //' \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['result']['tools']))" 2>/dev/null)
[ "${N:-0}" -gt 0 ] && echo "  ✓ 工具数 $N" || echo "  ✗ 调用失败"

echo "⑦ 重放已轮换的旧 refresh（应被拒并吊销家族）"
E=$(echo "$(curl -s --max-time 30 -X POST "$B/token" \
  -d "grant_type=refresh_token&refresh_token=$RT1&client_id=$CID")" | jqf error_description)
[ "$E" = "token_reuse_detected" ] && echo "  ✓ 判定为重放" || echo "  ✗ 预期 token_reuse_detected，实得「$E」"

echo "⑧ 家族已吊销，新 refresh 也应失效"
E2=$(echo "$(curl -s --max-time 30 -X POST "$B/token" \
  -d "grant_type=refresh_token&refresh_token=$RT2&client_id=$CID")" | jqf error_description)
[ "$E2" = "revoked" ] && echo "  ✓ 已吊销" || echo "  ✗ 预期 revoked，实得「$E2」"

rm -f /tmp/reflow.json
