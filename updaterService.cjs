const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { app } = require('electron');
const { spawn } = require('child_process');

let activeDownloadReq = null;
let downloadedInstallerPath = null;

/**
 * Robust SemVer comparison
 */
function compareSemver(v1, v2) {
  const parse = (v) => {
    if (!v) return [0, 0, 0];
    const clean = String(v).trim().replace(/^v/i, '').split('-')[0];
    return clean.split('.').map(p => parseInt(p, 10) || 0);
  };
  const p1 = parse(v1);
  const p2 = parse(v2);
  const maxLen = Math.max(p1.length, p2.length);
  for (let i = 0; i < maxLen; i++) {
    const num1 = p1[i] !== undefined ? p1[i] : 0;
    const num2 = p2[i] !== undefined ? p2[i] : 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * Check for updates against backend API
 */
async function checkForUpdates(backendUrl, currentVersion = null) {
  const appVersion = currentVersion || app.getVersion() || '1.0.0';
  const cleanBase = (backendUrl || 'http://localhost:5005').replace(/\/+$/, '');
  const checkUrl = `${cleanBase}/api/version/check?platform=windows&current_version=${encodeURIComponent(appVersion)}`;

  console.log(`[AutoUpdater] Checking for updates at: ${checkUrl} (Current Version: ${appVersion})`);

  return new Promise((resolve, reject) => {
    const lib = checkUrl.startsWith('https:') ? https : http;
    const req = lib.get(checkUrl, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`Update server responded with HTTP ${res.statusCode}`));
          }
          const response = JSON.parse(data);
          console.log('[AutoUpdater] Check result:', response.update_available ? `Update available: v${response.latest_version}` : 'Up to date');
          resolve({
            ...response,
            installed_version: appVersion
          });
        } catch (err) {
          reject(new Error(`Failed to parse update server response: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Update check request timed out'));
    });

    req.on('error', (err) => {
      reject(new Error(`Failed to connect to update server: ${err.message}`));
    });
  });
}

/**
 * Download update package in background with progress and SHA-256 verification
 */
async function downloadUpdate(updateInfo, onProgress) {
  const downloadUrl = updateInfo.direct_api_url || updateInfo.download_url;
  if (!downloadUrl) {
    throw new Error('No download URL provided in update package info.');
  }

  const tempDir = app.getPath('temp');
  const targetFileName = `Ariso_Retail_POS_Setup_${updateInfo.latest_version || Date.now()}.exe`;
  const targetFilePath = path.join(tempDir, targetFileName);

  console.log(`[AutoUpdater] Starting background download from: ${downloadUrl}`);
  console.log(`[AutoUpdater] Destination: ${targetFilePath}`);

  return new Promise((resolve, reject) => {
    // If previous download request is running, abort it
    if (activeDownloadReq) {
      try { activeDownloadReq.destroy(); } catch (_) {}
      activeDownloadReq = null;
    }

    const fileStream = fs.createWriteStream(targetFilePath);
    const hash = crypto.createHash('sha256');

    let totalBytes = updateInfo.file_size || 0;
    let receivedBytes = 0;
    let startTime = Date.now();

    function followRedirect(targetUrl, maxRedirects = 5) {
      if (maxRedirects <= 0) {
        fileStream.close();
        return reject(new Error('Too many redirects while downloading update package'));
      }

      const lib = targetUrl.startsWith('https:') ? https : http;
      const req = lib.get(targetUrl, (res) => {
        // Handle 301, 302, 307 redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          console.log(`[AutoUpdater] Following redirect to: ${res.headers.location}`);
          return followRedirect(res.headers.location, maxRedirects - 1);
        }

        if (res.statusCode !== 200) {
          fileStream.close();
          try { fs.unlinkSync(targetFilePath); } catch (_) {}
          return reject(new Error(`Failed to download update package: HTTP ${res.statusCode}`));
        }

        const headerLength = parseInt(res.headers['content-length'], 10);
        if (headerLength && !isNaN(headerLength)) {
          totalBytes = headerLength;
        }

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          hash.update(chunk);

          const percent = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
          const elapsedSec = (Date.now() - startTime) / 1000;
          const bytesPerSec = elapsedSec > 0 ? Math.round(receivedBytes / elapsedSec) : 0;

          if (typeof onProgress === 'function') {
            onProgress({
              percent,
              receivedBytes,
              totalBytes,
              bytesPerSec
            });
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(async () => {
            activeDownloadReq = null;
            const downloadedHash = hash.digest('hex');
            console.log(`[AutoUpdater] Download completed (${receivedBytes} bytes). SHA256: ${downloadedHash}`);

            // Verify checksum integrity if provided by backend
            if (updateInfo.checksum_sha256) {
              const expectedHash = updateInfo.checksum_sha256.toLowerCase().trim();
              if (downloadedHash.toLowerCase() !== expectedHash) {
                try { fs.unlinkSync(targetFilePath); } catch (_) {}
                const mismatchErr = new Error(`Checksum verification failed! Expected ${expectedHash}, but got ${downloadedHash}. Update file rejected for security.`);
                console.error('[AutoUpdater Error]', mismatchErr.message);
                return reject(mismatchErr);
              }
              console.log('[AutoUpdater] ✅ SHA256 checksum verified successfully!');
            }

            downloadedInstallerPath = targetFilePath;
            resolve({
              success: true,
              installerPath: targetFilePath,
              fileSize: receivedBytes,
              checksum: downloadedHash
            });
          });
        });
      });

      req.on('error', (err) => {
        fileStream.close();
        try { fs.unlinkSync(targetFilePath); } catch (_) {}
        activeDownloadReq = null;
        reject(new Error(`Download failed: ${err.message}`));
      });

      activeDownloadReq = req;
    }

    followRedirect(downloadUrl);
  });
}

/**
 * Silently execute installer and restart application
 * Preserves user database, local storage, login session and settings
 */
function installAndRestart(customInstallerPath = null) {
  const installerPath = customInstallerPath || downloadedInstallerPath;

  if (!installerPath || !fs.existsSync(installerPath)) {
    throw new Error('Downloaded update installer package not found.');
  }

  console.log(`[AutoUpdater] Launching update installer: ${installerPath}`);

  // Create an automated runner batch script in temp dir to execute silent installer and relaunch app
  const tempDir = app.getPath('temp');
  const runnerBatchPath = path.join(tempDir, `ariso_update_runner_${Date.now()}.bat`);
  const appExecutablePath = process.execPath;

  // Batch runner: Wait 2s for current Electron app to cleanly release file locks, run NSIS silent /S, wait 1s, restart app
  const batchScript = `@echo off
timeout /t 2 /nobreak >nul
start /wait "" "${installerPath}" /S
timeout /t 1 /nobreak >nul
start "" "${appExecutablePath}"
del "%~f0"
exit
`;

  try {
    fs.writeFileSync(runnerBatchPath, batchScript, 'utf8');

    const subprocess = spawn('cmd.exe', ['/c', runnerBatchPath], {
      detached: true,
      stdio: 'ignore'
    });
    subprocess.unref();

    console.log('[AutoUpdater] Silent installer runner spawned. Gracefully exiting current Ariso Retail POS application...');

    // Gracefully exit current Electron app so NSIS installer can replace files
    setTimeout(() => {
      app.isQuitting = true;
      app.quit();
    }, 1000);

    return { success: true };
  } catch (err) {
    console.warn('[AutoUpdater] Batch runner spawn failed, falling back to direct spawn:', err.message);
    try {
      const subprocess = spawn(installerPath, ['/S'], {
        detached: true,
        stdio: 'ignore'
      });
      subprocess.unref();

      setTimeout(() => {
        app.isQuitting = true;
        app.quit();
      }, 1000);

      return { success: true };
    } catch (fallbackErr) {
      console.error('[AutoUpdater] Failed to launch installer:', fallbackErr);
      throw new Error(`Failed to launch installer: ${fallbackErr.message}`);
    }
  }
}

module.exports = {
  compareSemver,
  checkForUpdates,
  downloadUpdate,
  installAndRestart
};
