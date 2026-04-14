import { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const S3_BUCKET = process.env.S3_BUCKET || 'trade-documents';

export let s3 = null;

if (process.env.S3_ENDPOINT) {
  s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin'
    },
    forcePathStyle: true
  });
  // Ensure bucket exists
  (async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    } catch {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
        console.log(`[S3] Created bucket: ${S3_BUCKET}`);
      } catch (err) {
        console.error('[S3] Failed to create bucket:', err.message);
      }
    }
  })();
}

export async function uploadToS3(fileKey, buffer, mimeType) {
  if (!s3) throw new Error('S3 not configured');
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: fileKey,
    Body: buffer,
    ContentType: mimeType
  }));
  return fileKey;
}

export async function getPresignedUrl(fileKey) {
  if (!s3) throw new Error('S3 not configured');
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
  return getSignedUrl(s3, command, { expiresIn: 3600 });
}
