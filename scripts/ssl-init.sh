#!/usr/bin/env bash
set -euo pipefail

# Usage: ./ssl-init.sh <domain> <email> [staging]
# Example: ./ssl-init.sh romaflooringdesigns.com sales@romaflooringdesigns.com
# Add "1" as third arg for Let's Encrypt staging (testing)

DOMAIN="${1:?Usage: $0 <domain> <email> [staging]}"
EMAIL="${2:?Usage: $0 <domain> <email> [staging]}"
STAGING="${3:-0}"
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"

DATA_PATH="./certbot"
RSA_KEY_SIZE=4096

if [ "$STAGING" != "0" ]; then
    STAGING_ARG="--staging"
    echo "=== SSL Init (STAGING MODE) ==="
else
    STAGING_ARG=""
    echo "=== SSL Init (PRODUCTION) ==="
fi

echo "Domain: $DOMAIN"
echo "Email: $EMAIL"

# Create required directories
echo "Creating certificate directories..."
mkdir -p "$DATA_PATH/conf/live/$DOMAIN"
mkdir -p "$DATA_PATH/www"

# Download recommended TLS parameters
if [ ! -e "$DATA_PATH/conf/options-ssl-nginx.conf" ]; then
    echo "Downloading recommended TLS parameters..."
    curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
        > "$DATA_PATH/conf/options-ssl-nginx.conf"
    curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem \
        > "$DATA_PATH/conf/ssl-dhparams.pem"
fi

# Create dummy certificate so nginx can start
echo "Creating dummy certificate..."
openssl req -x509 -nodes -newkey rsa:$RSA_KEY_SIZE -days 1 \
    -keyout "$DATA_PATH/conf/live/$DOMAIN/privkey.pem" \
    -out "$DATA_PATH/conf/live/$DOMAIN/fullchain.pem" \
    -subj "/CN=localhost" 2>/dev/null

# Start nginx with dummy cert
echo "Starting nginx..."
docker compose $COMPOSE_FILES up -d frontend
echo "Waiting for nginx to start..."
sleep 5

# Delete dummy certificate
echo "Removing dummy certificate..."
rm -rf "$DATA_PATH/conf/live/$DOMAIN"

# Request real certificate
echo "Requesting Let's Encrypt certificate..."
docker compose $COMPOSE_FILES run --rm certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    -d "$DOMAIN" \
    -d "www.$DOMAIN" \
    $STAGING_ARG

# Reload nginx with real cert
echo "Reloading nginx..."
docker compose $COMPOSE_FILES exec frontend nginx -s reload

echo ""
echo "=== SSL certificate provisioned successfully ==="
echo "Certificate location: $DATA_PATH/conf/live/$DOMAIN/"
echo "Auto-renewal is handled by the certbot service."
