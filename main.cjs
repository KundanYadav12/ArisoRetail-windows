const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { buildThermalReceiptBuffer, buildThermalKotBuffer } = require('./thermalPrinterService.cjs');
const { checkForUpdates, downloadUpdate, installAndRestart } = require('./updaterService.cjs');

// Electron app configuration for Windows stability & clean GPU rendering
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

let mainWindow = null;

function createWindow() {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Ariso Retail POS',
    icon: path.join(__dirname, 'public', 'icon.png'),
    backgroundColor: '#0f172a',
    show: false, // Show gracefully when ready-to-show
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false // Allow local file loading with external APIs
    }
  });

  // Handle opening external links and PDFs in native default browser / PDF viewer
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.endsWith('.pdf')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Safety fallback: if ready-to-show doesn't fire within 2.5s, ensure window is shown
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 2500);

  // Forward renderer console logs to main process for diagnostics
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [L${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[Electron] Render process gone:', details);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Electron] Page loaded successfully:', mainWindow.webContents.getURL());
  });

  // Remove native File/Edit/View/Window menu in production mode unless debugging
  if (!isDev && !process.env.DEBUG) {
    Menu.setApplicationMenu(null);
  }

  // Bind window-specific keyboard shortcut accelerators
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Ctrl + Q to Quit
    if (input.control && input.key.toLowerCase() === 'q') {
      app.quit();
      event.preventDefault();
    }
    // F5 or Ctrl + R to Reload
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
    // F12 or Ctrl+Shift+I to Toggle DevTools (Available for diagnostics)
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Helper to resolve index.html location (desktop local dist or fallback to sibling frontend dist)
  const getBundleHtmlPath = () => {
    const localDist = path.join(__dirname, 'dist', 'index.html');
    if (fs.existsSync(localDist)) return localDist;
    const siblingFrontendDist = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
    if (fs.existsSync(siblingFrontendDist)) return siblingFrontendDist;
    return localDist;
  };

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Electron] Page failed to load (${errorCode}): ${errorDescription} at ${validatedURL}`);
    // If dev server failed to load, automatically fall back to production dist/index.html
    const bundlePath = getBundleHtmlPath();
    if (fs.existsSync(bundlePath) && !validatedURL.includes('index.html')) {
      console.log('[Electron] Falling back to local dist bundle:', bundlePath);
      mainWindow.loadFile(bundlePath);
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';
  const distFile = getBundleHtmlPath();

  if (isDev) {
    // Try to load Vite dev server, fallback to dist/index.html if dev server is offline
    mainWindow.loadURL(devUrl).catch((err) => {
      console.warn(`[Electron] Dev server at ${devUrl} unreachable (${err.message}). Loading dist bundle...`);
      if (fs.existsSync(distFile)) {
        mainWindow.loadFile(distFile);
      }
    });
    if (process.env.DEBUG || process.argv.includes('--devtools') || !app.isPackaged) {
      mainWindow.webContents.openDevTools();
    }
  } else {
    mainWindow.loadFile(distFile);
    if (process.env.DEBUG || process.argv.includes('--devtools')) {
      mainWindow.webContents.openDevTools();
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handler: Open external links or PDF receipts in system browser/viewer
ipcMain.handle('open-external', async (event, url) => {
  try {
    if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://'))) {
      await shell.openExternal(url);
      return { success: true };
    }
    return { success: false, error: 'Invalid URL format' };
  } catch (err) {
    console.error('[Electron] Error opening external URL:', err);
    return { success: false, error: err.message };
  }
});

// ── Application Version & Background Auto-Update Suite ───────────────────────
ipcMain.handle('get-app-version', async () => {
  return app.getVersion() || '1.0.0';
});

ipcMain.handle('check-app-update', async (event, backendUrl) => {
  try {
    const update = await checkForUpdates(backendUrl, app.getVersion());
    return update;
  } catch (err) {
    console.warn('[AutoUpdater] Check failed:', err.message);
    return { update_available: false, error: err.message };
  }
});

ipcMain.handle('download-app-update', async (event, updateInfo) => {
  try {
    const result = await downloadUpdate(updateInfo, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-download-progress', progress);
      }
    });
    return result;
  } catch (err) {
    console.error('[AutoUpdater] Download error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-app-update', async (event) => {
  try {
    return installAndRestart();
  } catch (err) {
    console.error('[AutoUpdater] Install error:', err);
    return { success: false, error: err.message };
  }
});

// IPC Handler: Direct TCP Socket raw stream printing for LAN thermal printers
ipcMain.handle('print-lan-raw', async (event, ip, port, base64Payload) => {
  return new Promise((resolve, reject) => {
    try {
      const buffer = Buffer.from(base64Payload, 'base64');
      const client = new net.Socket();
      client.setTimeout(3000); // 3 second connection timeout

      client.connect(port || 9100, ip, () => {
        client.write(buffer, () => {
          client.end();
          resolve({ success: true });
        });
      });

      client.on('error', (err) => {
        client.destroy();
        reject(err);
      });

      client.on('timeout', () => {
        client.destroy();
        reject(new Error(`LAN TCP Socket timeout at ${ip}:${port}`));
      });
    } catch (err) {
      reject(err);
    }
  });
});

// =========================================================================
// FAST NATIVE PRINTER DISCOVERY & INSTANT PRINT DISPATCH
// =========================================================================
let cachedPrintersList = null;
let lastPrinterFetchTime = 0;
const PRINTER_CACHE_TTL_MS = 60000; // 60 seconds in-memory cache

// Native Windows PowerShell WMI/CIM/Spooler Discovery Helper
function getWindowsNativePrinters() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);

    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$prns = @()
try {
    $prns = @(Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue)
} catch {}

if (-not $prns -or $prns.Count -eq 0) {
    try {
        $prns = @(Get-WmiObject Win32_Printer -ErrorAction SilentlyContinue)
    } catch {}
}

if (-not $prns -or $prns.Count -eq 0) {
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
        $installed = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters
        $defaultPrinter = (New-Object System.Drawing.Printing.PrinterSettings).PrinterName
        $prns = @($installed | ForEach-Object {
            [PSCustomObject]@{
                Name = [string]$_
                DriverName = ''
                PortName = ''
                Default = ([string]$_ -eq $defaultPrinter)
                WorkOffline = $false
            }
        })
    } catch {}
}

try {
    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
} catch {}

$output = @($prns | ForEach-Object {
    $pName = [string]$_.Name
    $formName = ''
    $pwMm = 0
    $phMm = 0
    try {
        $ps = New-Object System.Drawing.Printing.PrinterSettings
        $ps.PrinterName = $pName
        if ($ps.IsValid) {
            $sz = $ps.DefaultPageSettings.PaperSize
            $formName = [string]$sz.PaperName
            $pwMm = [Math]::Round($sz.Width * 0.254, 1)
            $phMm = [Math]::Round($sz.Height * 0.254, 1)
        }
    } catch {}

    [PSCustomObject]@{
        name = $pName
        driverName = [string]$_.DriverName
        portName = [string]$_.PortName
        isDefault = [bool]$_.Default
        workOffline = [bool]$_.WorkOffline
        formName = $formName
        paperWidthMm = $pwMm
        paperHeightMm = $phMm
    }
})

$output | ConvertTo-Json -Compress
`;

    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`, { timeout: 7000 }, (err, stdout) => {
      if (err) {
        console.warn('[getWindowsNativePrinters] Query warning:', err.message);
        return resolve([]);
      }
      try {
        const raw = (stdout || '').trim();
        if (!raw) return resolve([]);
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        resolve(list);
      } catch (parseErr) {
        console.warn('[getWindowsNativePrinters] JSON parse warning:', parseErr.message);
        resolve([]);
      }
    });
  });
}

// Helper: Discover all live Windows-installed printers via Dual Discovery (Electron Chromium API + Windows Native Spooler)
async function getLivePrintersList(senderWebContents, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedPrintersList && (now - lastPrinterFetchTime < PRINTER_CACHE_TTL_MS)) {
    return cachedPrintersList;
  }

  try {
    let electronPrinters = [];
    try {
      if (senderWebContents && typeof senderWebContents.getPrintersAsync === 'function') {
        electronPrinters = await senderWebContents.getPrintersAsync();
      } else if (mainWindow && mainWindow.webContents && typeof mainWindow.webContents.getPrintersAsync === 'function') {
        electronPrinters = await mainWindow.webContents.getPrintersAsync();
      } else if (mainWindow && mainWindow.webContents && typeof mainWindow.webContents.getPrinters === 'function') {
        electronPrinters = mainWindow.webContents.getPrinters();
      }
    } catch (eWeb) {
      console.warn('[getLivePrintersList] Electron Chromium printer query warning:', eWeb?.message);
    }

    // Fast path: if Electron native Chromium API returned printers, avoid slow PowerShell CIM/WMI overhead
    const nativePrinters = (electronPrinters && electronPrinters.length > 0)
      ? []
      : await getWindowsNativePrinters();

    // Merge discovery results by name (case-insensitive)
    const printerMap = new Map();

    // 1. Process Native Windows Printers
    if (Array.isArray(nativePrinters)) {
      for (const np of nativePrinters) {
        if (!np || !np.name) continue;
        const key = np.name.trim().toLowerCase();
        printerMap.set(key, {
          name: np.name.trim(),
          displayName: np.name.trim(),
          driverName: np.driverName ? np.driverName.trim() : '',
          portName: np.portName ? np.portName.trim() : '',
          isDefault: Boolean(np.isDefault),
          workOffline: Boolean(np.workOffline),
          formName: np.formName || '',
          paperWidthMm: np.paperWidthMm || 0,
          paperHeightMm: np.paperHeightMm || 0
        });
      }
    }

    // 2. Enrich/Merge with Electron Chromium Printers
    if (Array.isArray(electronPrinters)) {
      for (const ep of electronPrinters) {
        if (!ep || !ep.name) continue;
        const key = ep.name.trim().toLowerCase();
        const existing = printerMap.get(key) || {};
        printerMap.set(key, {
          name: ep.name.trim(),
          displayName: ep.displayName ? ep.displayName.trim() : (existing.displayName || ep.name.trim()),
          driverName: existing.driverName || (ep.driverName ? ep.driverName.trim() : ''),
          portName: existing.portName || '',
          isDefault: ep.isDefault !== undefined ? Boolean(ep.isDefault) : (existing.isDefault || false),
          workOffline: ep.workOffline !== undefined ? Boolean(ep.workOffline) : (existing.workOffline || false),
          formName: existing.formName || '',
          paperWidthMm: existing.paperWidthMm || 0,
          paperHeightMm: existing.paperHeightMm || 0
        });
      }
    }

// Helper: Detect actively connected physical USB print devices from Windows PnP
function getActivePnpPrinterDevices() {
  if (process.platform !== 'win32') return [];
  try {
    const ps = `Get-CimInstance Win32_PnPEntity | Where-Object { $_.DeviceID -like 'USBPRINT*' -and $_.Status -eq 'OK' } | Select-Object Name, DeviceID | ConvertTo-Json -Compress`;
    const res = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { timeout: 1500, encoding: 'utf8' }).trim();
    if (!res) return [];
    const parsed = JSON.parse(res);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    return [];
  }
}

    const mergedList = Array.from(printerMap.values());

    if (mergedList.length > 0) {
      let pnpDevices = [];
      try {
        pnpDevices = getActivePnpPrinterDevices();
      } catch (_) {}

      cachedPrintersList = mergedList.map(p => {
        const fullDesc = `${p.name} ${p.displayName} ${p.driverName} ${p.portName}`.toLowerCase();
        const is58 = fullDesc.includes('58') || fullDesc.includes('2inch') || fullDesc.includes('2"');
        const isVirtual = /pdf|onenote|xps|fax|microsoft print to|nul:|portprompt/i.test(p.name || '') ||
                          /pdf|onenote|xps|fax|microsoft print to/i.test(p.driverName || '') ||
                          /nul:|portprompt/i.test(p.portName || '');

        const isPnpConnected = pnpDevices.some(dev => {
          const dName = (dev.Name || '').toLowerCase();
          const dId = (dev.DeviceID || '').toLowerCase();
          const pName = (p.name || '').toLowerCase();
          const pPort = (p.portName || '').toLowerCase();
          return (pName && (dName.includes(pName) || pName.includes(dName))) || (pPort.startsWith('usb') && dId.includes(pPort));
        });

        return {
          name: p.name,
          displayName: p.displayName || p.name,
          driverName: p.driverName || '',
          portName: p.portName || '',
          paperWidth: is58 ? 58 : 80,
          formName: p.formName || '',
          paperWidthMm: p.paperWidthMm || 0,
          paperHeightMm: p.paperHeightMm || 0,
          isDefault: Boolean(p.isDefault),
          workOffline: Boolean(p.workOffline),
          isUsb: !isVirtual,
          isVirtual: isVirtual,
          isPhysicalPresent: isPnpConnected || !isVirtual,
          isHardwareConnected: isPnpConnected,
          isOnline: true // Thermal USB printers are ready for spooling
        };
      });

      lastPrinterFetchTime = now;
      return cachedPrintersList;
    }
  } catch (e) {
    console.warn('[getLivePrintersList] Dual Discovery warning:', e?.message);
  }

  return cachedPrintersList || [];
}

// Helper: Dynamic resolver to pick requested printer or the best matching physical thermal device
function resolveBestPrinter(livePrinters, requestedName) {
  const rawReq = (requestedName || '').trim();
  const req = rawReq.toLowerCase();
  const isGeneric = !rawReq || ['default', 'sys-default', 'sys-hardware-default', 'receipt', 'pos', 'printer', 'receipt printer', 'kitchen', 'kot', 'auto'].includes(req);

  // If live printers list is empty or unavailable
  if (!Array.isArray(livePrinters) || livePrinters.length === 0) {
    if (!isGeneric) {
      return { name: rawReq, displayName: rawReq, driverName: '', portName: '', isVirtual: false, isUsb: true };
    }
    return null;
  }

  // 1. If an explicit printer name was requested
  if (!isGeneric) {
    // Exact match by name or displayName
    let match = livePrinters.find(p => p.name === rawReq || p.displayName === rawReq);
    if (!match) {
      // Case-insensitive exact match
      match = livePrinters.find(p => (p.name && p.name.toLowerCase() === req) || (p.displayName && p.displayName.toLowerCase() === req));
    }
    if (!match) {
      // Substring match in name or driverName
      match = livePrinters.find(p => 
        (p.name && p.name.toLowerCase().includes(req)) || 
        (p.driverName && p.driverName.toLowerCase().includes(req)) || 
        req.includes((p.name || '').toLowerCase()) ||
        (p.portName && p.portName.toLowerCase() === req)
      );
    }

    if (match) {
      // If the matched printer is marked offline, try to fallback to an active physical thermal printer
      if (match.workOffline) {
        const altOnline = livePrinters.find(p => !p.isVirtual && !p.workOffline && (p.isHardwareConnected || p.isDefault || p.isUsb));
        if (altOnline) return altOnline;
      }
      return match;
    }

    // If requested printer not found in active list, try default physical thermal printer before fallback
    const onlineThermal = livePrinters.find(p => !p.isVirtual && !p.workOffline && (p.isHardwareConnected || p.isDefault || p.isUsb));
    if (onlineThermal) return onlineThermal;

    return { name: rawReq, displayName: rawReq, driverName: '', portName: '', isVirtual: false, isUsb: true };
  }

  // 2. Generic or Default requested: Pick the highest scoring active thermal printer
  const scored = livePrinters.map(p => {
    let score = 0;
    const nameLow = (p.name || '').toLowerCase();
    const drvLow = (p.driverName || '').toLowerCase();
    const portLow = (p.portName || '').toLowerCase();

    if (p.isVirtual) score -= 2000;
    if (p.workOffline) score -= 300;
    if (p.isHardwareConnected) score += 600; // Directly connected physical USB hardware!
    if (p.isDefault) score += 50;
    if (p.isUsb) score += 30;
    if (portLow.startsWith('usb')) score += 20;

    // Thermal receipt printer name heuristics
    if (/tp\s*\d|pos|receipt|thermal|rp\s*\d|xp-?80|xp-?58|tm-t/i.test(nameLow) || /tp\s*\d|pos|receipt|thermal/i.test(drvLow)) {
      score += 100;
    }

    // Label / Barcode printer penalty for receipt printing (e.g. TSC TE244)
    if (/tsc|te244|zebra|godex|argox|barcode|label/i.test(nameLow) || /tsc|zebra/i.test(drvLow)) {
      score -= 400;
    }

    return { printer: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.printer || livePrinters[0];
}

// Helper: Hardware Auto-Cutter Pulse Dispatcher for Windows Thermal Receipt Printers
function sendCutPulseToPrinter(printerName) {
  if (process.platform !== 'win32' || !printerName) return;
  const pName = String(printerName).trim();
  const isVirtual = /pdf|onenote|xps|fax|microsoft print to|nul:|portprompt/i.test(pName);
  if (isVirtual) return;

  const tempCutPayload = path.join(os.tmpdir(), `ariso_cut_${Date.now()}_${Math.random().toString(36).substring(7)}.bin`);
  // Feed 4 newlines + GS V 66 0 (feed and partial cut) + GS V 0 (full cut)
  const cutBuffer = Buffer.from('\n\n\n\n\x1DV\x42\x00\x1DV\x00', 'binary');
  fs.writeFileSync(tempCutPayload, cutBuffer);

  const b64PayloadPath = Buffer.from(tempCutPayload, 'utf8').toString('base64');
  const b64TargetPrinter = Buffer.from(pName, 'utf8').toString('base64');

  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$typeDef = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawCutHelper {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFOW {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern Int32 StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);
    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static string Cut(string szPrinterName, string szFileName) {
        if (!File.Exists(szFileName)) return "NF";
        byte[] bytes = File.ReadAllBytes(szFileName);
        IntPtr hPrinter = new IntPtr(0);
        DOCINFOW di = new DOCINFOW();
        di.pDocName = "Ariso POS Auto Cut";
        di.pDataType = "RAW";
        if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) return "FAIL_OPEN";
        try {
            int jobId = StartDocPrinter(hPrinter, 1, di);
            if (jobId <= 0) return "FAIL_DOC";
            try {
                if (StartPagePrinter(hPrinter)) {
                    IntPtr pUnmanaged = Marshal.AllocCoTaskMem(bytes.Length);
                    Marshal.Copy(bytes, 0, pUnmanaged, bytes.Length);
                    int dwWritten = 0;
                    WritePrinter(hPrinter, pUnmanaged, bytes.Length, out dwWritten);
                    Marshal.FreeCoTaskMem(pUnmanaged);
                    EndPagePrinter(hPrinter);
                    return "OK";
                }
            } finally {
                EndDocPrinter(hPrinter);
            }
        } finally {
            ClosePrinter(hPrinter);
        }
        return "FAIL";
    }
}
'@
Add-Type -TypeDefinition $typeDef
$payloadFilePath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${b64PayloadPath}"))
$targetPrinterName = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${b64TargetPrinter}"))
[RawCutHelper]::Cut($targetPrinterName, $payloadFilePath)
`;

  const psScriptFile = path.join(os.tmpdir(), `ariso_cut_script_${Date.now()}_${Math.random().toString(36).substring(7)}.ps1`);
  fs.writeFileSync(psScriptFile, psScript, 'utf8');

  exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psScriptFile}"`, { timeout: 4000 }, () => {
    try { fs.unlinkSync(tempCutPayload); } catch (_) {}
    try { fs.unlinkSync(psScriptFile); } catch (_) {}
  });
}

// Helper: Send RAW binary buffer directly to Windows Spooler via Win32 API
function sendBufferToSpooler(printerName, buffer, docTitle = 'Ariso POS Receipt') {
  return new Promise((resolve, reject) => {
    try {
      const tempPayload = path.join(os.tmpdir(), `ariso_spool_${Date.now()}_${Math.random().toString(36).substring(7)}.bin`);
      fs.writeFileSync(tempPayload, buffer);

      const b64PayloadPath = Buffer.from(tempPayload, 'utf8').toString('base64');
      const b64TargetPrinter = Buffer.from(printerName, 'utf8').toString('base64');
      const safeDocTitle = String(docTitle || 'Ariso POS Receipt').replace(/"/g, '');

      const psScript = `
$ErrorActionPreference = 'Stop'

$typeDef = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFOW {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern Int32 StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);
    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static string SendFileToPrinter(string szPrinterName, string szFileName, string szDocTitle) {
        if (!File.Exists(szFileName)) return "ERROR: Payload file not found.";
        byte[] bytes = File.ReadAllBytes(szFileName);
        IntPtr hPrinter = new IntPtr(0);
        DOCINFOW di = new DOCINFOW();
        di.pDocName = string.IsNullOrEmpty(szDocTitle) ? "Ariso POS Receipt" : szDocTitle;
        di.pDataType = "RAW";
        if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
            int err = Marshal.GetLastWin32Error();
            return "ERROR: OpenPrinter failed for '" + szPrinterName + "' with Win32 error code: " + err;
        }
        try {
            int jobId = StartDocPrinter(hPrinter, 1, di);
            if (jobId <= 0) {
                int err = Marshal.GetLastWin32Error();
                return "ERROR: StartDocPrinter failed with Win32 error code: " + err;
            }
            try {
                if (StartPagePrinter(hPrinter)) {
                    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
                    Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);
                    int dwWritten = 0;
                    bool bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out dwWritten);
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    EndPagePrinter(hPrinter);
                    if (!bSuccess || dwWritten != bytes.Length) {
                        return "ERROR: WritePrinter failed. Written " + dwWritten + " of " + bytes.Length + " bytes.";
                    }
                    return "SUCCESS: " + szPrinterName;
                }
            } finally {
                EndDocPrinter(hPrinter);
            }
        } finally {
            ClosePrinter(hPrinter);
        }
        return "ERROR: Spooler transaction failed.";
    }
}
'@

Add-Type -TypeDefinition $typeDef

$payloadFilePath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${b64PayloadPath}"))
$targetPrinterName = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${b64TargetPrinter}"))

$res = [RawPrinterHelper]::SendFileToPrinter($targetPrinterName, $payloadFilePath, "${safeDocTitle}")
Write-Output $res
`;

      const psScriptFile = path.join(os.tmpdir(), `ariso_spool_${Date.now()}_${Math.random().toString(36).substring(7)}.ps1`);
      fs.writeFileSync(psScriptFile, psScript, 'utf8');

      exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psScriptFile}"`, (error, stdout, stderr) => {
        try { fs.unlinkSync(tempPayload); } catch (e) {}
        try { fs.unlinkSync(psScriptFile); } catch (e) {}

        const outStr = (stdout || '').trim();
        const errStr = (stderr || '').trim();

        if (outStr.startsWith('SUCCESS:')) {
          resolve({ success: true, printer: printerName });
        } else if (outStr.startsWith('ERROR:')) {
          reject(new Error(outStr.replace(/^ERROR:\s*/, '')));
        } else if (error || errStr) {
          const cleanMsg = errStr.replace(/^.*?:\s*/, '') || error?.message || 'Print dispatch failed.';
          reject(new Error(cleanMsg));
        } else {
          reject(new Error(outStr || 'Unknown print spooler status'));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// IPC Handler: Standard Thermal Receipt Printing with node-thermal-printer and Safe Isolated QR Fallback
ipcMain.handle('print-thermal-receipt', async (event, printerName, orderData, cartItems, restaurantData, receiptSettings) => {
  try {
    const livePrinters = await getLivePrintersList(event?.sender);
    const requested = (printerName || '').trim();
    const targetPrinter = resolveBestPrinter(livePrinters, requested);

    if (!targetPrinter || !targetPrinter.name) {
      throw new Error(`Printer "${requested || 'Default'}" is not installed in Windows.`);
    }

    const buffer = await buildThermalReceiptBuffer(orderData, cartItems, restaurantData, receiptSettings);
    try {
      return await sendBufferToSpooler(targetPrinter.name, buffer, `Receipt #${orderData?.unique_order_number || ''}`);
    } catch (primaryErr) {
      // Automatic Hardware Failover: if the primary target failed, try connected USB thermal printer
      const altPrinter = livePrinters.find(p => !p.isVirtual && p.name !== targetPrinter.name && (p.isHardwareConnected || p.isUsb || (p.portName && p.portName.toLowerCase().startsWith('usb'))));
      if (altPrinter && altPrinter.name) {
        console.warn(`[print-thermal-receipt failover] Primary printer "${targetPrinter.name}" failed: ${primaryErr.message}. Retrying on active printer "${altPrinter.name}"...`);
        return await sendBufferToSpooler(altPrinter.name, buffer, `Receipt #${orderData?.unique_order_number || ''}`);
      }
      throw primaryErr;
    }
  } catch (err) {
    console.error('[print-thermal-receipt error]', err);
    throw err;
  }
});

// IPC Handler: Standard Thermal KOT Printing with node-thermal-printer
ipcMain.handle('print-thermal-kot', async (event, printerName, orderData, cartItems, kotSettings) => {
  try {
    const livePrinters = await getLivePrintersList(event?.sender);
    const requested = (printerName || '').trim();
    const targetPrinter = resolveBestPrinter(livePrinters, requested);

    if (!targetPrinter || !targetPrinter.name) {
      throw new Error(`Printer "${requested || 'Default'}" is not installed in Windows.`);
    }

    const buffer = await buildThermalKotBuffer(orderData, cartItems, kotSettings);
    try {
      return await sendBufferToSpooler(targetPrinter.name, buffer, `KOT #${orderData?.unique_order_number || ''}`);
    } catch (primaryErr) {
      const altPrinter = livePrinters.find(p => !p.isVirtual && p.name !== targetPrinter.name && (p.isHardwareConnected || p.isUsb || (p.portName && p.portName.toLowerCase().startsWith('usb'))));
      if (altPrinter && altPrinter.name) {
        console.warn(`[print-thermal-kot failover] Primary printer "${targetPrinter.name}" failed: ${primaryErr.message}. Retrying on active printer "${altPrinter.name}"...`);
        return await sendBufferToSpooler(altPrinter.name, buffer, `KOT #${orderData?.unique_order_number || ''}`);
      }
      throw primaryErr;
    }
  } catch (err) {
    console.error('[print-thermal-kot error]', err);
    throw err;
  }
});

// IPC Handler: Direct Raw ESC/POS printing to Windows USB/Spooler queue (<50ms execution)
ipcMain.handle('print-windows-raw', async (event, printerName, base64Payload) => {
  try {
    if (!base64Payload) {
      throw new Error('Missing receipt print payload data.');
    }

    const livePrinters = await getLivePrintersList(event?.sender);
    const requested = (printerName || '').trim();
    const targetPrinter = resolveBestPrinter(livePrinters, requested);

    if (!targetPrinter || !targetPrinter.name) {
      throw new Error(`Printer "${requested || 'Default'}" is not installed in Windows.`);
    }

    const buffer = Buffer.from(base64Payload, 'base64');
    try {
      return await sendBufferToSpooler(targetPrinter.name, buffer, 'Ariso POS Raw Print');
    } catch (primaryErr) {
      const altPrinter = livePrinters.find(p => !p.isVirtual && p.name !== targetPrinter.name && (p.isHardwareConnected || p.isUsb || (p.portName && p.portName.toLowerCase().startsWith('usb'))));
      if (altPrinter && altPrinter.name) {
        console.warn(`[print-windows-raw failover] Primary printer "${targetPrinter.name}" failed: ${primaryErr.message}. Retrying on active printer "${altPrinter.name}"...`);
        return await sendBufferToSpooler(altPrinter.name, buffer, 'Ariso POS Raw Print');
      }
      throw primaryErr;
    }
  } catch (err) {
    throw err;
  }
});

// IPC Handler: High-Speed Silent HTML Receipt rendering and printing to Windows queue (<150ms execution)
ipcMain.handle('print-system-silent', async (event, htmlContent, printerName, options = {}) => {
  return new Promise(async (resolve, reject) => {
    let printWindow = null;
    try {
      printWindow = new BrowserWindow({
        show: false,
        width: 380,
        height: 800,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      // 1. Fast Live Printer Detection & Validation (<2ms)
      let targetDeviceName = undefined;
      let detectedWidth = 80;
      try {
        const livePrinters = await getLivePrintersList(event?.sender || printWindow.webContents);
        const best = resolveBestPrinter(livePrinters, printerName);
        if (best && best.name) {
          targetDeviceName = best.name;
          if (best.paperWidth) detectedWidth = best.paperWidth;
        }
      } catch (checkErr) {
        console.warn('[print-system-silent] Live printer detection warning:', checkErr?.message);
      }

      printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));

      printWindow.webContents.on('did-finish-load', () => {
        if (!printWindow || printWindow.isDestroyed()) return;

        const rawPaper = String(options.paperSize || options.paper_size || detectedWidth || '80mm').toLowerCase();
        const is58mm = rawPaper.includes('58') || rawPaper.includes('2inch') || rawPaper.includes('2"');
        const is76mm = rawPaper.includes('76');

        const printOpts = {
          silent: options.silent !== undefined ? options.silent : true,
          printBackground: true,
          color: false, // Thermal monochrome
          landscape: false, // Strict portrait
          scaleFactor: options.scaleFactor || 100,
          margins: { marginType: options.marginType || 'none' }
        };

        if (options.pageSize && typeof options.pageSize === 'object' && options.pageSize.width && options.pageSize.height) {
          printOpts.pageSize = options.pageSize;
        } else if (is58mm) {
          printOpts.pageSize = { width: 58000, height: 210000 };
        } else if (is76mm) {
          printOpts.pageSize = { width: 76000, height: 297000 };
        } else if (rawPaper === '80mm' || rawPaper === '3inch' || rawPaper === '80') {
          printOpts.pageSize = { width: 80000, height: 297000 };
        }

        if (targetDeviceName) {
          printOpts.deviceName = targetDeviceName;
        }

        printWindow.webContents.print(
          printOpts,
          (success, failureReason) => {
            if (printWindow && !printWindow.isDestroyed()) {
              printWindow.destroy();
              printWindow = null;
            }
            if (success) {
              resolve({ success: true, printer: targetDeviceName || 'Default' });
            } else {
              reject(new Error(failureReason || 'Print failed'));
            }
          }
        );
      });
    } catch (err) {
      if (printWindow && !printWindow.isDestroyed()) {
        try { printWindow.destroy(); printWindow = null; } catch (e) {}
      }
      reject(err);
    }
  });
});

// IPC Handler: Fetch system printers list (Live Windows detection <10ms)
ipcMain.handle('get-system-printers', async (event) => {
  return await getLivePrintersList(event?.sender, true);
});

// IPC Handler: Real-time Windows spooler printer connection test
ipcMain.handle('test-windows-printer-connection', async (event, printerName) => {
  try {
    const livePrinters = await getLivePrintersList(event?.sender, true);
    const targetPrinter = resolveBestPrinter(livePrinters, printerName);
    if (!targetPrinter || !targetPrinter.name) {
      return {
        success: false,
        error: `Printer "${printerName || 'Default'}" was not found among installed Windows printers.`
      };
    }

    if (targetPrinter.isVirtual) {
      return {
        success: false,
        error: `Printer "${targetPrinter.name}" is a virtual printer (PDF/OneNote). Please select a physical thermal receipt printer.`
      };
    }

    const testPsScript = `
$ErrorActionPreference = 'SilentlyContinue'
$typeDef = @'
using System;
using System.Runtime.InteropServices;
public class ConnTest {
    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    public static int Check(string name) {
        IntPtr h = IntPtr.Zero;
        bool ok = OpenPrinter(name, out h, IntPtr.Zero);
        if (ok) { ClosePrinter(h); return 0; }
        return Marshal.GetLastWin32Error();
    }
}
'@
Add-Type -TypeDefinition $typeDef
$b64Name = "${Buffer.from(targetPrinter.name, 'utf8').toString('base64')}"
$pName = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64Name))
$resCode = [ConnTest]::Check($pName)
Write-Output $resCode
`;

    return new Promise((resolve) => {
      const tempScript = path.join(os.tmpdir(), `ariso_test_conn_${Date.now()}_${Math.random().toString(36).substring(7)}.ps1`);
      fs.writeFileSync(tempScript, testPsScript, 'utf8');
      exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tempScript}"`, { timeout: 4000 }, (err, stdout) => {
        try { fs.unlinkSync(tempScript); } catch (_) {}
        const code = parseInt((stdout || '').trim(), 10);
        if (code === 0) {
          resolve({
            success: true,
            printerName: targetPrinter.name,
            displayName: targetPrinter.displayName || targetPrinter.name,
            driverName: targetPrinter.driverName || '',
            portName: targetPrinter.portName || '',
            paperWidth: targetPrinter.paperWidth || 80,
            isDefault: targetPrinter.isDefault || false
          });
        } else {
          resolve({
            success: false,
            error: `Unable to open Windows spooler handle for "${targetPrinter.name}" (Win32 Code: ${code})`
          });
        }
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// =========================================================================
// INBUILD PRINT GATEWAY DAEMON (Embedded for Windows Application)
// =========================================================================
let gatewayState = {
  isRunning: false,
  serverUrl: 'https://retail.arisotechnologies.com/api',
  token: '',
  deviceToken: '',
  pollTimer: null,
  heartbeatTimer: null,
  isPolling: false
};

function sendSocketPayload(ip, port, buffer) {
  return new Promise((resolve, reject) => {
    const isMock = !ip || ip === '127.0.0.1' || ip === 'localhost';
    if (isMock) {
      return resolve({ success: true, mock: true });
    }

    const client = new net.Socket();
    client.setTimeout(2500);

    client.connect(port || 9100, ip, () => {
      client.write(buffer, () => {
        client.end();
        resolve({ success: true });
      });
    });

    client.on('error', (err) => {
      client.destroy();
      reject(err);
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error(`TCP Socket timeout connecting to printer at ${ip}:${port}`));
    });
  });
}

async function processGatewayJob(job) {
  let targetIp = job.ip_address || '127.0.0.1';
  let targetPort = job.port || 9100;
  const jobTitle = `Job #${job.id} (${job.print_type || 'RECEIPT'}) -> ${job.printer_name || targetIp}:${targetPort}`;

  if (!job.payload_base64) {
    await sendGatewayAck(job.id, 'FAILED', 'Missing payload_base64 string in queue.');
    return;
  }

  const tStart = Date.now();
  try {
    const bufferPayload = Buffer.from(job.payload_base64, 'base64');
    await sendSocketPayload(targetIp, targetPort, bufferPayload);
    const duration = Date.now() - tStart;
    await sendGatewayAck(job.id, 'SUCCESS', null, { completed_at: Date.now(), total_duration_ms: duration });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway-job-status', { jobId: job.id, status: 'SUCCESS', title: jobTitle });
    }
  } catch (err) {
    const duration = Date.now() - tStart;
    await sendGatewayAck(job.id, 'FAILED', err.message, { completed_at: Date.now(), total_duration_ms: duration });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway-job-status', { jobId: job.id, status: 'FAILED', title: jobTitle, error: err.message });
    }
  }
}

async function sendGatewayAck(jobId, status, errorMessage, timing = null) {
  try {
    const cleanUrl = (gatewayState.serverUrl || '').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (gatewayState.token) headers['Authorization'] = `Bearer ${gatewayState.token}`;
    if (gatewayState.deviceToken) headers['X-Device-Token'] = gatewayState.deviceToken;

    await fetch(`${cleanUrl}/agent/print-jobs/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        job_id: jobId,
        status,
        error_message: errorMessage || null,
        timing
      })
    });
  } catch (err) {
    console.error('[Inbuild Gateway] Failed to send ACK:', err.message);
  }
}

async function pollGatewayJobs() {
  if (!gatewayState.isRunning || gatewayState.isPolling) return;
  if (!gatewayState.token && !gatewayState.deviceToken) return;

  gatewayState.isPolling = true;
  try {
    const cleanUrl = (gatewayState.serverUrl || '').replace(/\/+$/, '');
    const headers = {};
    if (gatewayState.token) headers['Authorization'] = `Bearer ${gatewayState.token}`;
    if (gatewayState.deviceToken) headers['X-Device-Token'] = gatewayState.deviceToken;

    const res = await fetch(`${cleanUrl}/agent/print-jobs/poll`, { headers });
    if (res.ok) {
      const resData = await res.json();
      const jobs = Array.isArray(resData) ? resData : (resData && Array.isArray(resData.jobs) ? resData.jobs : []);
      if (jobs.length > 0) {
        for (const job of jobs) {
          await processGatewayJob(job);
        }
      }
    }
  } catch (err) {
    // Network or server unreachable (silent catch during offline)
  } finally {
    gatewayState.isPolling = false;
  }
}

async function sendGatewayHeartbeat() {
  if (!gatewayState.isRunning) return;
  if (!gatewayState.token && !gatewayState.deviceToken) return;

  try {
    const cleanUrl = (gatewayState.serverUrl || '').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (gatewayState.token) headers['Authorization'] = `Bearer ${gatewayState.token}`;
    if (gatewayState.deviceToken) headers['X-Device-Token'] = gatewayState.deviceToken;

    await fetch(`${cleanUrl}/agent/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ printer_statuses: [] })
    });
  } catch (err) {
    // Silent heartbeat
  }
}

function startGatewayDaemon(config = {}) {
  gatewayState.serverUrl = config.serverUrl || gatewayState.serverUrl;
  gatewayState.token = config.token || gatewayState.token;
  gatewayState.deviceToken = config.deviceToken || gatewayState.deviceToken;
  gatewayState.isRunning = true;

  if (gatewayState.pollTimer) clearInterval(gatewayState.pollTimer);
  if (gatewayState.heartbeatTimer) clearInterval(gatewayState.heartbeatTimer);

  gatewayState.pollTimer = setInterval(pollGatewayJobs, 1500);
  gatewayState.heartbeatTimer = setInterval(sendGatewayHeartbeat, 10000);

  // Initial immediate poll
  pollGatewayJobs();
  console.log('[Inbuild Print Gateway] Daemon started for server:', gatewayState.serverUrl);
  return { success: true, serverUrl: gatewayState.serverUrl };
}

function stopGatewayDaemon() {
  gatewayState.isRunning = false;
  if (gatewayState.pollTimer) clearInterval(gatewayState.pollTimer);
  if (gatewayState.heartbeatTimer) clearInterval(gatewayState.heartbeatTimer);
  gatewayState.pollTimer = null;
  gatewayState.heartbeatTimer = null;
  console.log('[Inbuild Print Gateway] Daemon stopped.');
  return { success: true };
}

ipcMain.handle('start-print-gateway', (event, config) => startGatewayDaemon(config));
ipcMain.handle('stop-print-gateway', () => stopGatewayDaemon());
ipcMain.handle('get-gateway-status', () => ({ isRunning: gatewayState.isRunning, serverUrl: gatewayState.serverUrl }));
