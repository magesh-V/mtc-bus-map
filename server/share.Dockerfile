# Share cards for mtc.reclaimchennai.city (share_api.py): stdlib + Pillow.
# libraqm gives Pillow complex-script shaping, so Tamil renders correctly.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libraqm0 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir pillow==11.0.0
WORKDIR /app
