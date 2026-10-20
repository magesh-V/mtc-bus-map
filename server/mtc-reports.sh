#!/usr/bin/env bash
# Rider reports API for mtc.reclaimchennai.city/api — a container on Caddy's `web`
# network (Caddy: `reverse_proxy /api/* mtc-reports:5063` in the mtc block), so no
# host port or firewall rule is involved. Data: ~/projects/mtc-live/reports/*.jsonl
docker rm -f mtc-reports 2>/dev/null
docker run -d --name mtc-reports --restart unless-stopped --network web --user "$(id -u):$(id -g)" \
  -v ~/projects/mtc-live/report_api.py:/app/report_api.py:ro -v ~/projects/mtc-live/reports:/app/reports \
  -w /app python:3.12-alpine python3 report_api.py --dir /app/reports --port 5063
