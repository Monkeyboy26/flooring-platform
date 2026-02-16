#!/bin/sh
set -eu

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups"
BACKUP_FILE="flooring_pim_backup_${TIMESTAMP}.sql.gz"
LOCAL_RETENTION_DAYS=7
S3_RETENTION_DAYS=30

echo "=== Database Backup — $TIMESTAMP ==="

# Create backup
echo "Dumping database..."
pg_dump -h "${DB_HOST}" -U "${DB_USER}" -d "${DB_NAME}" | gzip > "${BACKUP_DIR}/${BACKUP_FILE}"
echo "Backup created: ${BACKUP_FILE} ($(du -h "${BACKUP_DIR}/${BACKUP_FILE}" | cut -f1))"

# Upload to S3
if [ -n "${S3_BACKUP_BUCKET:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
    echo "Uploading to S3..."
    aws s3 cp "${BACKUP_DIR}/${BACKUP_FILE}" \
        "s3://${S3_BACKUP_BUCKET}/backups/${BACKUP_FILE}" \
        --storage-class STANDARD_IA
    echo "S3 upload complete"

    # Clean up old S3 backups
    echo "Cleaning S3 backups older than ${S3_RETENTION_DAYS} days..."
    CUTOFF_DATE=$(date -d "-${S3_RETENTION_DAYS} days" +%Y-%m-%d 2>/dev/null || date -v-${S3_RETENTION_DAYS}d +%Y-%m-%d)
    aws s3 ls "s3://${S3_BACKUP_BUCKET}/backups/" | while read -r line; do
        FILE_DATE=$(echo "$line" | awk '{print $1}')
        FILE_NAME=$(echo "$line" | awk '{print $4}')
        if [ -n "$FILE_NAME" ] && [ "$FILE_DATE" \< "$CUTOFF_DATE" ]; then
            echo "Deleting old S3 backup: $FILE_NAME"
            aws s3 rm "s3://${S3_BACKUP_BUCKET}/backups/${FILE_NAME}"
        fi
    done
else
    echo "S3 not configured — skipping upload"
fi

# Clean up old local backups
echo "Cleaning local backups older than ${LOCAL_RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "flooring_pim_backup_*.sql.gz" -mtime +${LOCAL_RETENTION_DAYS} -delete

echo "Backup complete"
