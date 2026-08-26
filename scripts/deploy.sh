#!/usr/bin/env bash
set -euo pipefail

# Selective production deploy: pull master, then restart/rebuild ONLY what the
# diff touches. The backend is bind-mounted into the api container, so code
# changes need a restart, not a rebuild — a rebuild is only required when
# dependencies (package.json) or the Dockerfile change. Frontend files are
# bind-mounted read-only into nginx and go live with no action at all.

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"
HEALTH_URL="${HEALTH_CHECK_URL:-http://localhost:3001/health}"
MAX_ATTEMPTS=30
SLEEP_INTERVAL=2

echo "=== Roma Flooring Designs — Production Deploy ==="
echo "Started at $(date)"

BEFORE=$(git rev-parse HEAD)
echo "Pulling latest code..."
git pull origin master
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
    echo "Already up to date ($AFTER) — nothing to deploy."
    exit 0
fi

CHANGED=$(git diff --name-only "$BEFORE" "$AFTER")
echo "Changed files ($(echo "$CHANGED" | wc -l | tr -d ' ')):"
echo "$CHANGED" | head -20

REBUILD_API=false
RESTART_API=false
RELOAD_NGINX=false
FULL_UP=false

while IFS= read -r f; do
    case "$f" in
        backend/package*.json|backend/Dockerfile) REBUILD_API=true ;;
        backend/*)                                RESTART_API=true ;;
        docker-compose*.yml)                      FULL_UP=true ;;
        nginx/*|nginx.conf)                       RELOAD_NGINX=true ;;
        frontend/*)                               : ;;  # bind-mounted ro — live immediately
        database/migrations/*)                    echo "NOTE: new migration $f — apply manually" ;;
    esac
done <<< "$CHANGED"

if [ "$FULL_UP" = true ]; then
    echo "Compose config changed — tagging rollback image and rebuilding stack..."
    CURRENT_IMAGE=$(docker compose $COMPOSE_FILES images api -q 2>/dev/null | head -1 || true)
    [ -n "$CURRENT_IMAGE" ] && docker tag "$CURRENT_IMAGE" flooring-api:rollback 2>/dev/null || true
    docker compose $COMPOSE_FILES up --build -d --remove-orphans
elif [ "$REBUILD_API" = true ]; then
    echo "Backend dependencies changed — tagging rollback image and rebuilding api..."
    CURRENT_IMAGE=$(docker compose $COMPOSE_FILES images api -q 2>/dev/null | head -1 || true)
    [ -n "$CURRENT_IMAGE" ] && docker tag "$CURRENT_IMAGE" flooring-api:rollback 2>/dev/null || true
    docker compose $COMPOSE_FILES up --build -d api
elif [ "$RESTART_API" = true ]; then
    echo "Backend code changed — restarting api (bind-mounted, no rebuild)..."
    docker compose $COMPOSE_FILES restart api
else
    echo "No backend changes — api untouched."
fi

if [ "$RELOAD_NGINX" = true ] && [ "$FULL_UP" != true ]; then
    echo "Nginx config changed — reloading..."
    docker compose $COMPOSE_FILES exec -T frontend nginx -s reload
fi

# Health check whenever the api was touched
if [ "$FULL_UP" = true ] || [ "$REBUILD_API" = true ] || [ "$RESTART_API" = true ]; then
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

    if [ "$HEALTHY" != true ]; then
        echo "ERROR: Health check failed after $MAX_ATTEMPTS attempts"
        echo ""
        echo "=== ROLLBACK ==="
        echo "  git reset --hard $BEFORE && docker compose $COMPOSE_FILES restart api"
        echo "  (or: docker tag flooring-api:rollback flooring-api:latest && docker compose $COMPOSE_FILES up -d api)"
        exit 1
    fi
fi

docker image prune -f > /dev/null 2>&1 || true
echo "Deploy successful! ($BEFORE -> $AFTER)"
echo "Completed at $(date)"
