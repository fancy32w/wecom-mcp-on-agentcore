"""判定一次 MCP 工具调用的结果：凭证有效 / 失效（含 errcode）。

从 stdin 读 SSE data 帧的 JSON，用环境变量 REF 标注是哪条凭证。
独立成文件而不是内嵌 python -c：嵌在 bash 里时引号会被吃掉。
"""
import json
import os
import re
import sys

ref = os.environ.get('REF', '?')

try:
    d = json.load(sys.stdin)
except Exception:
    print(f'  {ref}…  ? 无法解析响应')
    sys.exit(0)

if d.get('error'):
    print(f'  {ref}…  ? 协议层报错 {json.dumps(d["error"], ensure_ascii=False)[:80]}')
    sys.exit(0)

r = d.get('result', {})
items = r.get('content') or [{}]
txt = items[0].get('text', '')

if not r.get('isError'):
    meta = (r.get('_meta') or {}).get('wecom_identity') or {}
    bot = meta.get('bot_id') or '?'
    who = meta.get('authorized_user_id') or '?'
    print(f'  {ref}…  ✓ 有效   bot={bot}  授权人={who}')
else:
    m = re.search(r'errcode\\?":\s*(\d+)', txt)
    code = m.group(1) if m else '?'
    print(f'  {ref}…  ✗ 失效   errcode={code}')
