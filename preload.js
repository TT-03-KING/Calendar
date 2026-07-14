const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 原有方法
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

  // 新增：导入导出配置
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),

  // 新增：获取链接错误
  getLinkErrors: () => ipcRenderer.invoke('get-link-errors'),

  // 新增：透明度设置
  setCapsuleOpacity: (opacity) => ipcRenderer.send('set-capsule-opacity', opacity),
  onCapsuleOpacityChanged: (callback) => {
    ipcRenderer.on('capsule-opacity-changed', callback);
  },
});