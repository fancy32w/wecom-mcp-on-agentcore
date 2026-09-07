#!/usr/bin/env python3
"""
从 wecom-cli 提取全量方法 schema —— 参考实现 docker/generate-tools.js 的替代品原型。

链路：
  ① 13 次 `wecom-cli <service> --schema`  → 目录（methods 点分名 + skills）
  ② N  次 `wecom-cli <path...> --schema`  → 每个方法完整 JSON Schema
  ③ 落盘 + 汇总统计

关键发现：service 级 schema 的 methods[].name 是点分路径（如 calendar.schedules.cancel），
直接 split('.') 就是 CLI 参数，不需要递归走 --help 树。

用法：
  python3 extract-schemas.py [输出目录]
"""
import json
import os
import subprocess
import sys

SERVICES = [
    "calendar", "chat", "contact", "disk", "doc", "mail", "media",
    "message", "meeting", "sheet", "smartpage", "smartsheet", "todo",
]
CLI = os.environ.get("WECOM_CLI", "wecom-cli")
TIMEOUT = 15


def run_schema(args):
    """调用 wecom-cli ... --schema，返回 (dict|None, 错误信息)。硬超时 + stdin 关闭。"""
    try:
        p = subprocess.run(
            [CLI, *args, "--schema"],
            capture_output=True, text=True,
            timeout=TIMEOUT, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return None, f"timeout>{TIMEOUT}s"
    except FileNotFoundError:
        sys.exit(f"找不到 {CLI}，先 npm install -g @wecom/cli 并确认平台包已装")
    if p.returncode != 0:
        return None, f"exit={p.returncode} {p.stderr.strip()[:80]}"
    try:
        return json.loads(p.stdout), None
    except json.JSONDecodeError as e:
        return None, f"非JSON: {e}"


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else "schemas"
    os.makedirs(os.path.join(outdir, "methods"), exist_ok=True)

    catalog = {"services": {}, "methods": [], "skills": []}
    failures = []

    # ① 服务目录
    for svc in SERVICES:
        d, err = run_schema([svc])
        if err:
            failures.append((svc, err))
            continue
        methods = d.get("methods", [])
        skills = d.get("skills", [])
        catalog["services"][svc] = {
            "description": d.get("description", ""),
            "method_names": [m["name"] for m in methods],
            "skills": skills,
        }
        catalog["skills"].extend(skills)
        catalog["methods"].extend(methods)

    # ② 逐方法完整 schema
    detail = {}
    for m in catalog["methods"]:
        name = m["name"]
        d, err = run_schema(name.split("."))
        if err:
            failures.append((name, err))
            continue
        detail[name] = d
        with open(os.path.join(outdir, "methods", f"{name}.json"), "w") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)

    with open(os.path.join(outdir, "catalog.json"), "w") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    # ③ 汇总
    sizes = {n: len(json.dumps(d, ensure_ascii=False)) for n, d in detail.items()}
    total = sum(sizes.values())
    print(f"服务 {len(catalog['services'])}  方法目录 {len(catalog['methods'])}  "
          f"抓到完整 schema {len(detail)}  skills {len(set(catalog['skills']))}")
    print(f"schema 合计 {total/1024:.0f} KB  平均 {total/max(len(sizes),1)/1024:.1f} KB")
    print("\n体积 Top 15（决定 Tier1 名单时要避开的大块头）:")
    for n, s in sorted(sizes.items(), key=lambda kv: -kv[1])[:15]:
        print(f"  {s/1024:6.1f} KB  {n}")
    if failures:
        print(f"\n失败 {len(failures)} 项:")
        for n, e in failures:
            print(f"  {n}: {e}")


if __name__ == "__main__":
    main()
