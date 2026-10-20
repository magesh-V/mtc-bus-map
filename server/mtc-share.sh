#!/usr/bin/env bash
# Share links + social cards for mtc.reclaimchennai.city (/r /s /b /og) — a container
# on Caddy's `web` network (Caddy: `reverse_proxy @share mtc-share:5064`), no host port.
# Image: ~/projects/mtc-live/share/Dockerfile (python + Pillow). Cards cached in share-cache/.
docker build -q -t mtc-share:1 ~/projects/mtc-live/share >/dev/null
docker rm -f mtc-share 2>/dev/null
docker run -d --name mtc-share --restart unless-stopped --network web --user "$(id -u):$(id -g)" \
  -v ~/projects/mtc-live/share_api.py:/app/share_api.py:ro \
  -v ~/projects/maps-site/mapsv2/data:/data:ro -v ~/projects/maps-site/mapsv2/live:/live:ro \
  -v ~/projects/maps-site/mapsv2/db:/db:ro -v /usr/share/fonts/truetype/noto:/fonts:ro \
  -v ~/projects/mtc-live/share-cache:/cache \
  mtc-share:1 python3 share_api.py --data /data --live /live --db /db --fonts /fonts --cache /cache --port 5064
