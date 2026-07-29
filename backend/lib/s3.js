import { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const S3_BUCKET = process.env.S3_BUCKET || 'trade-documents';

export let s3 = null;
// Client used only to SIGN GET URLs. Presigned URLs are opened by the browser,
// which cannot resolve the internal Docker host in S3_ENDPOINT (http://minio:9000).
// So sign against a browser-reachable endpoint: S3_PUBLIC_ENDPOINT if set,
// otherwise the same endpoint with the internal `minio` host swapped for localhost.
// getSignedUrl makes no network call, so this client never has to connect.
export let s3Presign = null;
const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT
  || (process.env.S3_ENDPOINT ? process.env.S3_ENDPOINT.replace('//minio:', '//localhost:') : null);

if (process.env.S3_ENDPOINT) {
  const creds = {
    accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin'
  };
  s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: creds,
    forcePathStyle: true
  });
  s3Presign = new S3Client({
    endpoint: publicEndpoint,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: creds,
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
  const client = s3Presign || s3;
  if (!client) throw new Error('S3 not configured');
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
  return getSignedUrl(client, command, { expiresIn: 3600 });
}
