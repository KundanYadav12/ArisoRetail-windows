const { contextBridge, ipcRenderer } = require('electron');

// Secure IPC bridge between React and native Electron window
const electronBridge = {
  printThermalReceipt: (printerName, orderData, cartItems, restaurantData, receiptSettings) => ipcRenderer.invoke('print-thermal-receipt', printerName, orderData, cartItems, restaurantData, receiptSettings),
  printThermalKot: (printerName, orderData, cartItems, kotSettings) => ipcRenderer.invoke('print-thermal-kot', printerName, orderData, cartItems, kotSettings),
  printWindowsRaw: (printerName, base64Payload) => ipcRenderer.invoke('print-windows-raw', printerName, base64Payload),
  printLanRaw: (ip, port, base64Payload) => ipcRenderer.invoke('print-lan-raw', ip, port, base64Payload),
  printSystemSilent: (htmlContent, printerName, options) => ipcRenderer.invoke('print-system-silent', htmlContent, printerName, options),
  printStickers: (htmlContent, printerName, options) => ipcRenderer.invoke('print-system-silent', htmlContent, printerName, options),
  getPrinters: () => ipcRenderer.invoke('get-system-printers'),
  testPrinterConnection: (printerName) => ipcRenderer.invoke('test-windows-printer-connection', printerName),
  startGateway: (config) => ipcRenderer.invoke('start-print-gateway', config),
  stopGateway: () => ipcRenderer.invoke('stop-print-gateway'),
  getGatewayStatus: () => ipcRenderer.invoke('get-gateway-status'),
  onGatewayJobStatus: (callback) => {
    ipcRenderer.removeAllListeners('gateway-job-status');
    ipcRenderer.on('gateway-job-status', (event, data) => callback(data));
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkAppUpdate: (backendUrl) => ipcRenderer.invoke('check-app-update', backendUrl),
  downloadAppUpdate: (updateInfo) => ipcRenderer.invoke('download-app-update', updateInfo),
  installAppUpdate: () => ipcRenderer.invoke('install-app-update'),
  onUpdateProgress: (callback) => {
    ipcRenderer.removeAllListeners('update-download-progress');
    ipcRenderer.on('update-download-progress', (event, data) => callback(data));
  },
  isDesktop: true
};

contextBridge.exposeInMainWorld('electron', electronBridge);
contextBridge.exposeInMainWorld('electronAPI', electronBridge);

