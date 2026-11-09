"""Upload a PTrade read-only JSON snapshot to MyAgent.

Usage:
  set MYAGENT_BRIDGE_URL=https://agent.example.com/quant/api/bridge
  set TICKFLOW_BRIDGE_TOKEN=<local bridge token>
  py upload_readonly_snapshot.py ptrade_readonly_snapshot.json

The bridge token is read from the environment only and is never printed.
"""
import json
import os
import pathlib
import sys
import urllib.request


def main():
    if len(sys.argv) != 2:
        raise SystemExit("用法: py upload_readonly_snapshot.py <ptrade_readonly_snapshot.json>")
    token = os.environ.get("TICKFLOW_BRIDGE_TOKEN", "").strip()
    base = os.environ.get("MYAGENT_BRIDGE_URL", "https://agent.xdailab.com/quant/api/bridge").rstrip("/")
    if not token:
        raise SystemExit("请先设置 TICKFLOW_BRIDGE_TOKEN；不要把令牌写进脚本或聊天")
    path = pathlib.Path(sys.argv[1]).resolve()
    raw = path.read_bytes()
    if len(raw) > 1_000_000:
        raise SystemExit("快照超过 1 MB")
    payload = json.loads(raw.decode("utf-8"))
    request = urllib.request.Request(
        base + "/ptrade/read-only",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-tickflow-bridge-token": token},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        print(response.read().decode("utf-8"))


if __name__ == "__main__":
    main()
