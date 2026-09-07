#!/usr/bin/env python3
"""
把 wecom-cli 的 `--schema` 输出转成 MCP 工具定义 —— 移植中唯一必须新写的那段代码。

为什么需要它：wecom-cli 的 `$ref` 用的是**裸名**（"$ref": "SchedulesCreateReq"），
不是标准的 "#/$defs/SchedulesCreateReq"。JSON Schema 校验器（参考实现按 Draft 7 校验
inputSchema）解析不了裸名，所以必须把引用内联展开成自包含 schema。

同时只取 request 侧：response schema 和未被引用的类型定义全部丢弃，这是 inputSchema
体积远小于 `--schema` 全量输出的原因。

用法：
  python3 to_mcp_schema.py <schemas目录> [--tier1 名单文件]
"""
import json
import os
import sys

MAX_DEPTH = 12          # 防御环引用；超深退化为宽松 object
NAME_PREFIX = "wecom_"

# 远程 MCP 传输下的结构性约束（2026-08-27 Quick Desktop 实测发现）：
# Agent 与容器文件系统隔离，无法把文件放进容器，所以凡是只能通过本地文件路径提供内容的
# 方法一律不可用。不从目录里删掉它们（仍可被 discover 到、也可能有 media_id 走法），
# 但必须在 description 里说清楚，否则模型会反复尝试传路径然后失败 —— 实测 Quick 为了
# 往智能文档写内容，先误用 doc.contents.append、再试 pages.overwrite 传路径，
# 兜了三圈才找到唯一可用的 smartpage.blocks.update(mdx)。
FILE_PATH_PARAMS = {"file_path", "content_path"}
INLINE_ALTS = {"mdx", "content", "media_id", "file_content_media"}

# 关键方法的替代路径提示。键是方法名前缀，值是该走哪条路。
REDIRECT_HINTS = {
    "smartpage.pages.append": "改用 wecom_smartpage_blocks_update（method=append + mdx 内联 Markdown）",
    "smartpage.pages.overwrite": "改用 wecom_smartpage_blocks_update（method=replace/append + mdx 内联 Markdown）",
    "smartpage.import": "改用 wecom_smartpage_create 建文档，再用 wecom_smartpage_blocks_update 写 mdx 内容",
    "smartsheet.import": "只能走 media_id；而 media_id 需先上传本地文件，远程 MCP 下同样不可得",
    "disk.files.upload": "只能走 file_content_media（media_id）；远程 MCP 下无法上传本地文件取得 media_id",
    "media.upload": "若只是要把文本内容写入文档，直接用 wecom_smartpage_blocks_update(mdx) 或 wecom_doc_contents_append(content)，无需上传文件。",
}

# 文档类型容易被混用：doc.* 是 Word 在线文档，smartpage.* 是智能文档，smartsheet.* 是智能表格。
# 实测模型会拿 doc.contents.append 去写 smartpage 的 docid 然后失败。
DOCTYPE_WARNINGS = {
    "doc.contents.append": "仅适用于 Word 在线文档（doc）。写智能文档请用 wecom_smartpage_blocks_update，写智能表格请用 wecom_smartsheet_records_* 。",
    "doc.contents.get": "仅适用于 Word 在线文档（doc）。读智能文档请用 wecom_smartpage_pages_get。",
    "doc.contents.overwrite": "仅适用于 Word 在线文档（doc）。改智能文档请用 wecom_smartpage_blocks_update。",
}


def annotate_description(method, desc, prop_names):
    """把远程 MCP 的结构性约束写进工具描述，让模型一次就走对路。"""
    notes = []
    fp = prop_names & FILE_PATH_PARAMS
    if fp:
        alts = prop_names & INLINE_ALTS
        hint = REDIRECT_HINTS.get(method)
        if not alts:
            notes.append("【远程 MCP 下不可用】本方法只能通过容器内本地文件路径提供内容，"
                         "Agent 无法把文件放入容器。" + (hint or "请寻找支持内联内容参数的同类方法。"))
        else:
            notes.append(f"【注意】{'/'.join(sorted(fp))} 在远程 MCP 下不可用（Agent 无法把文件放入容器），"
                         f"请改用内联参数 {'/'.join(sorted(alts))}。" + (hint or ""))
    if method in DOCTYPE_WARNINGS:
        notes.append("【文档类型】" + DOCTYPE_WARNINGS[method])
    return desc + ("\n\n" + "\n".join(notes) if notes else "")



def inline(node, defs, depth=0, seen=None):
    """递归内联裸名 $ref。seen 记录当前分支上已展开的类型名，遇环即退化。"""
    if seen is None:
        seen = frozenset()
    if depth > MAX_DEPTH:
        return {"type": "object", "description": "（嵌套过深，已省略；用 wecom_invoke 传完整 JSON）"}
    if not isinstance(node, dict):
        return node

    ref = node.get("$ref")
    if ref:
        if ref in seen:
            # 环引用：不再展开，保留描述让模型知道这里是递归结构
            return {"type": "object",
                    "description": node.get("description", f"递归结构 {ref}")}
        target = defs.get(ref)
        if target is None:
            # 悬空引用：CLI 侧 schema 不完整，退化而不是崩
            return {"type": node.get("type", "object"),
                    "description": node.get("description", f"未解析的类型 {ref}")}
        merged = inline(target, defs, depth + 1, seen | {ref})
        # 引用点自带的 description 优先（更贴近字段语义）
        if node.get("description") and isinstance(merged, dict):
            merged = {**merged, "description": node["description"]}
        return merged

    out = {}
    for k, v in node.items():
        if k == "properties" and isinstance(v, dict):
            out[k] = {pk: inline(pv, defs, depth + 1, seen) for pk, pv in v.items()}
        elif k == "items":
            out[k] = inline(v, defs, depth + 1, seen)
        elif k in ("anyOf", "oneOf", "allOf") and isinstance(v, list):
            out[k] = [inline(x, defs, depth + 1, seen) for x in v]
        else:
            out[k] = v
    return out


def to_tool(doc):
    """{method, description, request:{$ref}, schemas:{...}} → MCP 工具定义"""
    method = doc["method"]
    defs = doc.get("schemas", {})
    schema = inline(doc.get("request", {}), defs)
    if schema.get("type") != "object":
        schema = {"type": "object", "properties": {}}
    schema.setdefault("properties", {})
    # Draft 7：required 必须是根级数组（wecom-cli 本来就这么给，此处只做兜底）
    if "required" in schema and not isinstance(schema["required"], list):
        del schema["required"]
    schema["additionalProperties"] = False
    return {
        "name": NAME_PREFIX + method.replace(".", "_"),
        "description": annotate_description(
            method, doc.get("description", ""), set(schema["properties"])),
        "inputSchema": schema,
    }


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    root = sys.argv[1]
    mdir = os.path.join(root, "methods")
    tier1 = set()
    if "--tier1" in sys.argv:
        with open(sys.argv[sys.argv.index("--tier1") + 1]) as f:
            tier1 = {l.strip() for l in f if l.strip() and not l.startswith("#")}

    tools, full_sz, in_sz, errs = {}, {}, {}, []
    for fn in sorted(os.listdir(mdir)):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(mdir, fn)
        doc = json.load(open(path))
        name = doc.get("method", fn[:-5])
        full_sz[name] = len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
        try:
            t = to_tool(doc)
        except Exception as e:                      # noqa: BLE001
            errs.append((name, repr(e)[:80]))
            continue
        tools[name] = t
        in_sz[name] = len(json.dumps(t, ensure_ascii=False, separators=(",", ":")))

    with open(os.path.join(root, "mcp-tools.json"), "w") as f:
        json.dump(tools, f, ensure_ascii=False, indent=2)

    tot_full, tot_in = sum(full_sz.values()), sum(in_sz.values())
    print(f"转换 {len(tools)}/{len(full_sz)} 个方法"
          + (f"，失败 {len(errs)}" if errs else "，零失败"))
    print(f"--schema 全量(紧凑) {tot_full/1024:.0f} KB → MCP inputSchema {tot_in/1024:.0f} KB "
          f"(降到 {tot_in/tot_full*100:.0f}%)")
    if tier1:
        t1 = sum(in_sz[n] for n in tier1 if n in in_sz)
        t2 = tot_in - t1
        miss = [n for n in tier1 if n not in in_sz]
        print(f"\nTier1 {len(tier1)-len(miss)} 个常驻: {t1/1024:.0f} KB ≈ {t1/4/1024:.0f}K tokens")
        print(f"Tier2 {len(in_sz)-len(tier1)+len(miss)} 个按需: {t2/1024:.0f} KB（discover/invoke，不占常驻）")
        if miss:
            print(f"名单中不存在的方法: {miss}")
    print("\ninputSchema 体积 Top 10:")
    for n, s in sorted(in_sz.items(), key=lambda kv: -kv[1])[:10]:
        print(f"  {s/1024:6.1f} KB  (全量 {full_sz[n]/1024:5.1f})  {n}")
    for n, e in errs:
        print(f"  ERR {n}: {e}")


if __name__ == "__main__":
    main()
