#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"
HEALTH_URL="${HEALTH_CHECK_URL:-http://localhost:3001/health}"
MAX_ATTEMPTS=30
SLEEP_INTERVAL=2

echo "=== Roma Flooring Designs — Production Deploy ==="
echo "Started at $(date)"

# Tag current API image for rollback
CURRENT_IMAGE=$(docker compose $COMPOSE_FILES images api -q 2>/dev/null || true)
if [ -n "$CURRENT_IMAGE" ]; then
    echo "Tagging current API image for rollback..."
    docker tag "$CURRENT_IMAGE" flooring-api:rollback 2>/dev/null || true
fi

# Pull latest code
echo "Pulling latest code..."
git pull origin main

# Bring down existing containers
echo "Stopping containers..."
docker compose $COMPOSE_FILES down --remove-orphans

# Build and start
echo "Building and starting containers..."
docker compose $COMPOSE_FILES up --build -d

# Check for pending migrations
if [ -d "database/migrations" ] && [ "$(ls -A database/migrations 2>/dev/null)" ]; then
    echo "WARNING: Pending migrations found in database/migrations/"
    echo "Run migrations manually before proceeding."
fi

# Health check
echo "Running health checks..."
HEALTHY=false
for i in $(seq 1 $MAX_ATTEMPTS); do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
        echo "Health check passed on attempt $i/$MAX_ATTEMPTS"
        HEALTHY=true
        break
    fi
    echo "Waiting for API... ($i/$MAX_ATTEMPTS)"
    sleep $SLEEP_INTERVAL
done

if [ "$HEALTHY" = true ]; then
    echo "Deploy successful!"
    # Clean up old images
    docker image prune -f
    echo "Completed at $(date)"
else
    echo "ERROR: Health check failed after $MAX_ATTEMPTS attempts"
    echo ""
    echo "=== ROLLBACK INSTRUCTIONS ==="
    echo "1. Check logs: docker compose $COMPOSE_FILES logs api"
    echo "2. If rollback image exists:"
    echo "   docker compose $COMPOSE_FILES down"
    echo "   docker tag flooring-api:rollback flooring-api:latest"
    echo "   docker compose $COMPOSE_FILES up -d"
    echo "3. Or revert to previous commit:"
    echo "   git log --oneline -5"
    echo "   git checkout <previous-commit>"
    echo "   docker compose $COMPOSE_FILES up --build -d"
    exit 1
fi
