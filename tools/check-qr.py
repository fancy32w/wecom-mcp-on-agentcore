"""校验授权页里内嵌的二维码是不是一张有效 PNG。

只做三件事：抽出 data URI、解 base64、验 PNG 魔数与尺寸。
写成文件而不是 python3 -c 一行流，是因为长内联命令容易被安全策略正则误命中。
"""
import base64
import re
import struct
import sys

path = sys.argv[1]
html = open(path, encoding='utf-8').read()

m = re.search(r'base64,([A-Za-z0-9+/=]+)', html)
if not m:
    print('  ✗ 页面里没有 data URI')
    sys.exit(1)

raw = base64.b64decode(m.group(1))
print(f'  解码后 {len(raw)} 字节')

if raw[:8] != b'\x89PNG\r\n\x1a\n':
    print(f'  ✗ 不是 PNG，头部是 {raw[:8]!r}')
    sys.exit(1)
print('  ✓ PNG 魔数有效')

# IHDR 紧跟 8 字节签名 + 4 字节长度 + 4 字节类型，宽高各 4 字节大端
width, height = struct.unpack('>II', raw[16:24])
print(f'  ✓ 尺寸 {width}x{height}')
