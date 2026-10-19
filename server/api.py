"""Thin authenticated client for the Chennai One API.

Session from CHENNAI_ONE_TOKEN / CHENNAI_ONE_SID (log in to the Chennai One app
and copy the `token` and `session_id` headers); falls back to a local
../dataset/harvest_all.py. Never printed: responses have both redacted."""
import json, os, re, subprocess, pathlib
TOKEN, SID = os.environ.get("CHENNAI_ONE_TOKEN"), os.environ.get("CHENNAI_ONE_SID")
if not TOKEN:
    _src = (pathlib.Path(__file__).resolve().parent.parent / "dataset/harvest_all.py").read_text()
    TOKEN = re.search(r"^TOKEN = '([^']+)'", _src, re.M).group(1)
    SID = re.search(r"^SID = '([^']+)'", _src, re.M).group(1)
BASE = "https://api.moving.tech/pilot/app/v2"
H = ["-H", f"token: {TOKEN}", "-H", f"session_id: {SID}", "-H", "content-type: application/json",
     "-H", "x-bundle-version: 0.1.7", "-H", "x-client-version: 3.6.0", "-H", "x-config-version: 0.0.1",
     "-H", "x-device: google/sdk_gphone64_arm64/Android v15/goldfish_arm64/Handset",
     "-H", "x-package: in.mobility.cumta", "-H", "x-rn-version: --", "-A", "okhttp/4.12.0"]
def call(path, method="GET", body=None, timeout=40):
    cmd = ["curl", "-s", "-g", "-w", "\n%{http_code}", "--max-time", str(timeout), "-X", method, *H]
    if body is not None: cmd += ["--data", json.dumps(body)]
    r = subprocess.run(cmd + [BASE + path], capture_output=True, text=True)
    body_, code = r.stdout.rsplit("\n", 1) if "\n" in r.stdout else (r.stdout, "000")
    return int(code), body_.replace(TOKEN, "<tok>").replace(SID, "<sid>")
