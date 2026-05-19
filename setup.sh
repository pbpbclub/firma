#!/bin/bash
# Запускать от root: bash /home/claude-runner/firma/setup.sh
set -e

echo "=== 1. Копируем проект ==="
cp -r /home/claude-runner/firma /opt/firma
chmod -R 755 /opt/firma

echo "=== 2. Устанавливаем зависимости backend ==="
pip3 install fastapi "uvicorn[standard]" --break-system-packages

echo "=== 3. Создаём systemd сервис ==="
cat > /etc/systemd/system/firma.service << 'EOF'
[Unit]
Description=Firma API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/firma/backend
ExecStart=/usr/bin/python3 -m uvicorn main:app --host 127.0.0.1 --port 8001
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable firma
systemctl start firma
echo "Backend: $(systemctl is-active firma)"

echo "=== 4. Устанавливаем Nginx ==="
apt-get install -y nginx

echo "=== 5. Nginx конфиг ==="
cat > /etc/nginx/sites-available/firma << 'EOF'
server {
    listen 80;
    server_name firma.nekitai.com;

    root /opt/firma/frontend/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8001/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

ln -sf /etc/nginx/sites-available/firma /etc/nginx/sites-enabled/firma
nginx -t && systemctl reload nginx

echo ""
echo "=== Готово! ==="
echo "Внутренняя проверка: curl http://localhost:8001/api/health"
echo "SSL — через Cloudflare автоматически (proxied включён)"
echo "Открывай: https://firma.nekitai.com"
