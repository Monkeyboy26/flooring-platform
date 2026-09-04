#!/usr/bin/env bash
# traffic-report.sh — server-side traffic dashboard from the nginx access logs.
#
# The nginx container (nginx:alpine) writes access logs to stdout, so `docker logs`
# is the log store. This pipes them through GoAccess (dockerized — nothing to
# install) and produces a standalone HTML report: top pages, visitors, referrers,
# status codes, bots, bandwidth. Catches everything client-side analytics misses
# (ad-block users, bots, scrapers, API hits).
#
# Usage:
#   ./scripts/traffic-report.sh                 # last 7 days -> traffic-report.html
#   SINCE=30d ./scripts/traffic-report.sh       # last 30 days
#   ./scripts/traffic-report.sh /tmp/report.html
#
# On prod: run on the EC2 box (same containers, same names).
set -euo pipefail

OUT="${1:-traffic-report.html}"
SINCE="${SINCE:-168h}"                 # docker-logs window (168h = 7 days)
CONTAINER="${CONTAINER:-flooring-frontend}"

# nginx default "main" log format = COMBINED + trailing "$http_x_forwarded_for"
LOG_FORMAT='%h - %e [%d:%t %^] "%r" %s %b "%R" "%u" "%^"'

# 2>&1: docker multiplexes nginx's access log onto the stderr stream here; the
# grep keeps only access-log lines (leading IP), dropping nginx error-log noise.
docker logs "$CONTAINER" --since "$SINCE" 2>&1 \
  | grep -E '^[0-9a-fA-F.:]+ - ' \
  | docker run --rm -i allinurl/goaccess:latest \
      - \
      --log-format="$LOG_FORMAT" \
      --date-format='%d/%b/%Y' \
      --time-format='%T' \
      --ignore-crawlers \
      --real-os \
      -a -o html \
  > "$OUT"

echo "Report written to $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
echo "Open it in a browser: open $OUT"
