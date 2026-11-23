#!/bin/bash
# EC2 user-data for the Countersign server (Amazon Linux 2023). Contains no secrets: the app's .env comes from SSM Parameter
# Store at boot, the code from a private S3 bundle, both read with the instance role. deploy.sh fills in the double-underscore placeholders.
# Safe to run again (deploy.sh does, through SSM, to ship new code): it keeps the database and caches, reseeds only once.
set -euo pipefail
exec > >(tee -a /var/log/countersign-bootstrap.log) 2>&1
echo "bootstrap start $(date -u +%FT%TZ)"

REGION="__REGION__"
BUCKET="__BUCKET__"
BUNDLE_KEY="__BUNDLE_KEY__"
PARAM="__PARAM__"
DEADLINE="__DEADLINE__"            # systemd calendar form, for example 2026-11-23 08:00:00 UTC
DEADLINE_EPOCH="__DEADLINE_EPOCH__"
APP=/opt/countersign
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

# Keep a copy so a later deploy can re-run exactly this script.
if [ "$(readlink -f "$0")" != /usr/local/sbin/countersign-bootstrap ]; then
  install -m 700 "$0" /usr/local/sbin/countersign-bootstrap
fi

# 1. Self-destruct first, so it is armed even if a later step fails. Shutdown behavior is "terminate", so a poweroff deletes
# the instance. A systemd timer lives on disk and survives reboots; Persistent=true fires it at boot if the time passed while off.
if [ "$(date -u +%s)" -ge "$DEADLINE_EPOCH" ]; then
  echo "deadline $DEADLINE has passed: powering off (terminates the instance)"
  systemctl poweroff
  exit 0
fi
cat > /etc/systemd/system/countersign-selfdestruct.service <<'UNIT'
[Unit]
Description=Countersign demo server: power off at the deadline (instance terminates on shutdown)

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl poweroff
UNIT
cat > /etc/systemd/system/countersign-selfdestruct.timer <<UNIT
[Unit]
Description=Countersign demo server self-destruct at $DEADLINE

[Timer]
OnCalendar=$DEADLINE
Persistent=true
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now countersign-selfdestruct.timer

# 2. A little swap: t3.small has 2 GB and pip builds plus pandas and scikit-learn are heavy.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile
  echo "/swapfile none swap defaults 0 0" >> /etc/fstab
fi
swapon -a || true

# 3. Packages.
PY=python3.12
if ! dnf install -y python3.12 python3.12-pip nginx; then
  PY=python3.11
  dnf install -y python3.11 python3.11-pip nginx
fi
id countersign >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /sbin/nologin countersign
mkdir -p "$APP"

# 4. Code: the committed tree plus the built frontend. Runtime state (database, caches, clips, uploads) is not in the bundle,
# so unpacking over the old tree keeps it.
aws s3 cp "s3://$BUCKET/$BUNDLE_KEY" /tmp/countersign-bundle.tar.gz --only-show-errors
rm -rf "$APP/frontend/dist"
tar -xzf /tmp/countersign-bundle.tar.gz -C "$APP"
rm -f /tmp/countersign-bundle.tar.gz

# 5. Python environment; pip runs again only when requirements.txt changed.
if [ ! -x "$APP/venv/bin/python" ]; then
  "$PY" -m venv "$APP/venv"
fi
REQ_HASH=$(sha256sum "$APP/backend/requirements.txt" | cut -d' ' -f1)
if [ "$(cat "$APP/venv/.req-hash" 2>/dev/null || true)" != "$REQ_HASH" ]; then
  "$APP/venv/bin/pip" install --quiet --upgrade pip
  "$APP/venv/bin/pip" install --quiet -r "$APP/backend/requirements.txt"
  echo "$REQ_HASH" > "$APP/venv/.req-hash"
fi

# 6. Settings. deploy.sh writes the parameter after the CloudFront address exists, so wait for it (up to 20 minutes).
umask 077
for _ in $(seq 1 120); do
  if aws ssm get-parameter --name "$PARAM" --with-decryption --query Parameter.Value --output text > "$APP/.env.new" 2>/dev/null; then
    break
  fi
  sleep 10
done
if [ ! -s "$APP/.env.new" ]; then
  echo "settings parameter $PARAM not readable after 20 minutes" >&2
  exit 1
fi
mv "$APP/.env.new" "$APP/.env"
umask 022
chown -R countersign:countersign "$APP"
chmod 600 "$APP/.env"

# 7. Seed the database once.
if [ ! -f "$APP/backend/countersign.db" ]; then
  (cd "$APP/backend" && runuser -u countersign -- "$APP/venv/bin/python" seed/seed.py)
fi

# 8. The backend: one always-on process on localhost only.
cat > /etc/systemd/system/countersign.service <<UNIT
[Unit]
Description=Countersign backend (uvicorn)
After=network-online.target
Wants=network-online.target

[Service]
User=countersign
WorkingDirectory=$APP/backend
ExecStart=$APP/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips 127.0.0.1
Restart=always
RestartSec=3
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT

# 9. nginx: the built frontend with SPA fallback, and the backend paths proxied without buffering (the event stream).
cat > /etc/nginx/nginx.conf <<NGINX
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;
include /usr/share/nginx/modules/*.conf;

events { worker_connections 1024; }

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    log_format main '\$remote_addr [\$time_local] "\$request_method \$uri" \$status \$body_bytes_sent \$request_time';
    access_log /var/log/nginx/access.log main;
    sendfile on;
    keepalive_timeout 65;
    server_tokens off;
    client_max_body_size 25m;

    server {
        listen 80 default_server;
        listen [::]:80 default_server;
        server_name _;
        root $APP/frontend/dist;

        location /api/ {
            proxy_pass http://127.0.0.1:8000;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header Connection "";
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto https;
            proxy_buffering off;
            proxy_cache off;
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
            gzip off;
        }

        location /mcp {
            proxy_pass http://127.0.0.1:8000;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header Connection "";
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto https;
            proxy_buffering off;
            proxy_read_timeout 3600s;
        }

        location / {
            try_files \$uri \$uri/ /index.html;
        }
    }
}
NGINX
nginx -t
systemctl daemon-reload
systemctl enable countersign nginx
systemctl restart countersign
systemctl restart nginx

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo "backend healthy"
    break
  fi
  sleep 2
done
systemctl list-timers countersign-selfdestruct.timer --no-pager || true
echo "bootstrap done $(date -u +%FT%TZ)"
