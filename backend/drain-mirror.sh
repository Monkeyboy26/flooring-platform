#!/bin/sh
# Recycling orchestrator for the one-time image-mirror bulk drain.
#
# libvips/sharp leak ~15-22MB of RSS per decode that glibc never returns to the
# OS, so a single long-lived mirror process OOM-kills itself after ~80 decodes
# inside the 2GB api cgroup (see imageMirror.js). The cure is process recycling:
# each iteration below is a FRESH node process bounded by --max-mirrors, so it
# exits and reclaims all leaked RSS long before the ceiling. --random keeps dead
# rows (mirrored_at stays NULL) from clustering at the front and stalling.
#
# Loops until MISS consecutive chunks mirror nothing (pool drained modulo
# unmirrorable rows). Idempotent + resumable — safe to kill and re-run.
#
#   sh drain-mirror.sh [max_mirrors=50] [concurrency=2] [extra backfill args...]
cd "$(dirname "$0")" || exit 1
MAXM="${1:-50}"; CONC="${2:-2}"
[ $# -ge 1 ] && shift; [ $# -ge 1 ] && shift
MISS=0; TOTAL=0; ITER=0
while [ "$MISS" -lt 5 ]; do
  OUT=$(MALLOC_ARENA_MAX=2 node mirror-images-backfill.mjs --max-mirrors "$MAXM" --concurrency "$CONC" --random "$@" 2>&1)
  N=$(printf '%s\n' "$OUT" | sed -n 's/^Done: \([0-9][0-9]*\) mirrored.*/\1/p')
  N="${N:-0}"
  TOTAL=$((TOTAL + N)); ITER=$((ITER + 1))
  if [ "$N" -eq 0 ]; then MISS=$((MISS + 1)); else MISS=0; fi
  echo "[drain] iter=$ITER chunk=$N total=$TOTAL miss=$MISS"
done
echo "[drain] DONE total=$TOTAL over $ITER iters"
