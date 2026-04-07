import * as ftp from 'basic-ftp';

/**
 * Create a plain FTP connection from vendor edi_config.
 * Used for vendors like EF that use FTP (not SFTP).
 * @param {object} ediConfig - { ftp_host, ftp_port, ftp_user, ftp_pass, ftp_secure }
 * @returns {ftp.Client}
 */
export async function createFtpConnection(ediConfig) {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  await client.access({
    host: ediConfig.ftp_host,
    port: ediConfig.ftp_port || 21,
    user: ediConfig.ftp_user,
    password: ediConfig.ftp_pass,
    secure: ediConfig.ftp_secure || false,
  });
  return client;
}

/**
 * Upload string content to a remote FTP path.
 */
export async function uploadFile(client, remotePath, content) {
  const { Readable } = await import('stream');
  const stream = Readable.from(Buffer.from(content, 'utf-8'));
  await client.uploadFrom(stream, remotePath);
}

/**
 * Download a remote file as a UTF-8 string.
 */
export async function downloadFile(client, remotePath) {
  const { WritableStream } = await import('stream/web');
  const chunks = [];
  const { Writable } = await import('stream');
  const writable = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await client.downloadTo(writable, remotePath);
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Move a file to an archive directory (download + upload to archive + delete original).
 * Plain FTP doesn't have a reliable rename across directories on all servers,
 * so we download, re-upload to archive, then delete the original.
 */
export async function moveToArchive(client, sourcePath, archiveDir) {
  try {
    await client.ensureDir(archiveDir);
    await client.cd('/'); // reset to root after ensureDir
  } catch (_) { /* already exists */ }

  const filename = sourcePath.split('/').pop();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = `${archiveDir}/${timestamp}_${filename}`;

  // Try rename first (works on many FTP servers)
  try {
    await client.rename(sourcePath, archivePath);
    return archivePath;
  } catch (_) {
    // Fallback: download + re-upload + delete
    const content = await downloadFile(client, sourcePath);
    await uploadFile(client, archivePath, content);
    await client.remove(sourcePath);
    return archivePath;
  }
}

/**
 * List files in a remote directory, optionally filtered by extensions.
 */
export async function listFiles(client, remoteDir, extensions) {
  const listing = await client.list(remoteDir);
  let files = listing.filter(f => f.type === 1); // regular files (type 1 in basic-ftp)
  if (extensions && extensions.length) {
    const exts = extensions.map(e => e.toLowerCase().replace(/^\./, ''));
    files = files.filter(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      return exts.includes(ext);
    });
  }
  return files.map(f => ({
    name: f.name,
    size: f.size,
    modifyTime: f.rawModifiedAt,
    path: `${remoteDir}/${f.name}`,
  }));
}
