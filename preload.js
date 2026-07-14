const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getCalendarData: () => ipcRenderer.invoke('get-calendar-data'),
  onRefresh: (callback) => {
    ipcRenderer.on('refresh-calendar', callback);
  },
  setCapsuleTheme: (theme) => ipcRenderer.send('set-capsule-theme', theme),
  onCapsuleThemeChanged: (callback) => {
    ipcRenderer.on('capsule-theme-changed', callback);
  },
  refreshCache: () => ipcRenderer.send('refresh-cache'),
  openManageLinks: () => ipcRenderer.send('open-manage-links'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),

  // 新增
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
  getLinkErrors: () => ipcRenderer.invoke('get-link-errors'),
  setCapsuleOpacity: (opacity) => ipcRenderer.send('set-capsule-opacity', opacity),
  onCapsuleOpacityChanged: (callback) => {
    ipcRenderer.on('capsule-opacity-changed', callback);
  },
});