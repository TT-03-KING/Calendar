const { contextBridge, ipcRenderer } = require('electron');

// 注意：Electron 20+ 的 preload 默认在沙箱里运行，
// 只能 require('electron' | 'events' | 'timers' | 'url')，不要引入 path / fs 等 Node 模块，
// 否则整个 preload 会注入失败，页面里 electronAPI 变成 undefined（按钮全部静默失效）。
contextBridge.exposeInMainWorld('electronAPI', {
  // 日程数据
  getCalendarData: () => ipcRenderer.invoke('get-calendar-data'),
  onRefresh: (callback) => {
    ipcRenderer.on('refresh-calendar', callback);
  },
  refreshCache: () => ipcRenderer.send('refresh-cache'),
  getLinkErrors: () => ipcRenderer.invoke('get-link-errors'),

  // 窗口
  openManageLinks: () => ipcRenderer.send('open-manage-links'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  // 首屏渲染完成 → 主进程再 show 窗口，避免启动时闪两下
  panelReady: () => ipcRenderer.send('panel-ready'),
  // 显隐：整页透明度归零（窗口不 hide，避免重建合成表面）
  onPanelHidden: (callback) => {
    ipcRenderer.on('panel-hidden-changed', callback);
  },

  // 主题（两个窗口共用同一个）
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  onThemeChanged: (callback) => {
    ipcRenderer.on('theme-changed', callback);
  },

  // 磨砂强度（0-100）：bg = 背景，card = 日程条
  setFrost: (frost) => ipcRenderer.send('set-frost', frost),
  onFrostChanged: (callback) => {
    ipcRenderer.on('frost-changed', callback);
  },

  // 设置：单列布局 / 置顶 / 快捷键 / 主题 / 磨砂
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setCompact: (on) => ipcRenderer.send('set-compact', on),
  setAlwaysOnTop: (on) => ipcRenderer.send('set-always-on-top', on),
  setHotkey: (action, accel) => ipcRenderer.send('set-hotkey', action, accel),
  onHotkeyResult: (callback) => {
    ipcRenderer.on('hotkey-result', callback);
  },
  onSettingsChanged: (callback) => {
    ipcRenderer.on('settings-changed', callback);
  },

  // 自定义背景图
  getBgImage: () => ipcRenderer.invoke('get-bg-image'),
  chooseBgImage: () => ipcRenderer.invoke('choose-bg-image'),
  clearBgImage: () => ipcRenderer.invoke('clear-bg-image'),
  onBgImageChanged: (callback) => {
    ipcRenderer.on('bg-image-changed', callback);
  },

  // 导入导出配置
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
});
