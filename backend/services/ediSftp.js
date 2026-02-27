import SftpClient from 'ssh2-sftp-client';

/**
 * Create an SFTP connection from vendor edi_config.
 * @param {object} ediConfig - { sftp_host, sftp_port, sftp_user, sftp_pass }
 * @returns {SftpClient}
 */
export async function createSftpConnection(ediConfig) {
  const sftp = new SftpClient();
  await sftp.connect({
    host: ediConfig.sftp_host,
    port: ediConfig.sftp_port || 22,
    username: ediConfig.sftp_user,
    password: ediConfig.sftp_pass,
    readyTimeout: 30000,
    retries: 2,
    retry_minTimeout: 2000,
  });
  return sftp;
}

/**
 * Upload string content to a remote SFTP path.
 */
export async function uploadFile(sftp, remotePath, content) {
  const buf = Buffer.from(content, 'utf-8');
  await sftp.put(buf, remotePath);
}

/**
 * Download a remote file as a UTF-8 string.
 */
export async function downloadFile(sftp, remotePath) {
  const buf = await sftp.get(remotePath);
  return buf.toString('utf-8');
}

/**
 * Move a file to an archive directory (rename).
 * Creates the archive directory if it doesn't exist.
 */
export async function moveToArchive(sftp, sourcePath, archiveDir) {
  try {
    await sftp.mkdir(archiveDir, true);
  } catch (_) { /* already exists */ }
  const filename = sourcePath.split('/').pop();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = `${archiveDir}/${timestamp}_${filename}`;
  await sftp.rename(sourcePath, archivePath);
  return archivePath;
}

/**
 * List files in a remote directory, optionally filtered by extensions.
 */
export async function listFiles(sftp, remoteDir, extensions) {
  const listing = await sftp.list(remoteDir);
  let files = listing.filter(f => f.type === '-'); // regular files only
  if (extensions && extensions.length) {
    const exts = extensions.map(e => e.toLowerCase());
    files = files.filter(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      return exts.includes(ext) || exts.includes('.' + ext);
    });
  }
  return files.map(f => ({
    name: f.name,
    size: f.size,
    modifyTime: f.modifyTime,
    path: `${remoteDir}/${f.name}`,
  }));
}
