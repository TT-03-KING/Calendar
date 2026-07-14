const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, dialog } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');
const ical = require('ical');

// ---------- 配置 ----------
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
let config = {
  links: [],
  capsuleTheme: 'dark',
  manageTheme: 'dark',
  capsuleOpacity: 0.08,
};
let capsuleWindow = null;
let manageWindow = null;
let tray = null;
let refreshInterval = null;

const PRESET_THEMES = ['dark', 'light', 'warm', 'cool'];
let linkErrors = {};

const COLOR_PALETTE = [
  '#4facfe', '#f093fb', '#4fdf7f', '#f7b731', '#ff6b6b',
  '#a29bfe', '#fd79a8', '#00cec9', '#fdcb6e', '#e17055'
];

// ---------- 加载/保存配置 ----------
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      config.links = parsed.links || [];
      config.capsuleTheme = parsed.capsuleTheme || 'dark';
      config.manageTheme = parsed.manageTheme || 'dark';
      config.capsuleOpacity = typeof parsed.capsuleOpacity === 'number' ? parsed.capsuleOpacity : 0.08;
      config.links.forEach((link, index) => {
        if (!link.color) link.color = COLOR_PALETTE[index % COLOR_PALETTE.length];
        if (!link.name) link.name = `日历${index + 1}`;
      });
    } else {
      config.links = [];
      config.capsuleTheme = 'dark';
      config.manageTheme = 'dark';
      config.capsuleOpacity = 0.08;
    }
  } catch (e) {
    console.warn('配置加载失败，使用默认', e);
    config.links = [];
    config.capsuleTheme = 'dark';
    config.manageTheme = 'dark';
    config.capsuleOpacity = 0.08;
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('配置保存失败', e);
  }
}

// ---------- 窗口与缓存 ----------
let cachedEvents = [];
let isFetching = false;
let lastError = null;

function clearAllTimers() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = null;
}

function sendToRenderer(channel, ...args) {
  if (capsuleWindow && !capsuleWindow.isDestroyed()) {
    capsuleWindow.webContents.send(channel, ...args);
  }
  if (manageWindow && !manageWindow.isDestroyed()) {
    manageWindow.webContents.send(channel, ...args);
  }
}

// ---------- 从单个链接拉取 ICS ----------
function fetchCalendarFromURL(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const httpsUrl = url.startsWith('https://') ? url : url.replace(/^webcal:\/\//, 'https://');
    https.get(httpsUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const events = ical.parseICS(data);
          const now = new Date();
          const end = new Date(now);
          end.setDate(end.getDate() + 30);
          const futureEvents = [];
          for (const key in events) {
            const ev = events[key];
            if (ev.type === 'VEVENT' && ev.start) {
              const start = new Date(ev.start);
              if (start >= now && start <= end) {
                futureEvents.push({
                  summary: ev.summary || '无标题',
                  start: start,
                  end: ev.end ? new Date(ev.end) : null,
                  location: ev.location || '',
                });
              }
            }
          }
          futureEvents.sort((a, b) => a.start - b.start);
          resolve(futureEvents);
        } catch (err) {
          console.error('❌ 解析 ICS 失败:', err);
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error('❌ 下载 ICS 失败:', err);
      resolve(null);
    });
  });
}

async function updateCache() {
  if (isFetching) return;
  isFetching = true;
  lastError = null;
  linkErrors = {};
  try {
    if (config.links.length === 0) {
      lastError = '请添加至少一个日历链接（点击右上角 + 添加）';
      cachedEvents = [];
      isFetching = false;
      sendToRenderer('refresh-calendar');
      sendToRenderer('link-errors-updated', linkErrors);
      return;
    }
    const allEvents = [];
    for (let i = 0; i < config.links.length; i++) {
      const link = config.links[i];
      const events = await fetchCalendarFromURL(link.url);
      if (events && events.length > 0) {
        events.forEach(ev => {
          ev.color = link.color;
          ev.calendarName = link.name || '未命名';
        });
        allEvents.push(...events);
      } else {
        const errMsg = `日历 "${link.name || '未命名'}" 获取失败或无日程`;
        linkErrors[link.url] = errMsg;
        console.warn(`⚠️ ${errMsg}`);
      }
    }
    if (allEvents.length > 0) {
      allEvents.sort((a, b) => a.start - b.start);
      cachedEvents = allEvents;
      console.log(`✅ 合并后共 ${cachedEvents.length} 个日程`);
    } else {
      if (Object.keys(linkErrors).length === 0) {
        lastError = '所有链接均无日程，请检查链接';
      } else {
        lastError = '部分日历获取失败，请查看详情';
      }
      cachedEvents = [];
    }
    sendToRenderer('refresh-calendar');
    sendToRenderer('link-errors-updated', linkErrors);
  } catch (error) {
    console.error('❌ 更新缓存异常:', error);
    lastError = error.message;
  } finally {
    isFetching = false;
  }
}

// ---------- 提供给渲染进程的数据 ----------
async function getCalendarData() {
  if (cachedEvents.length === 0 && !isFetching) {
    await updateCache();
  }
  const result = {
    events: cachedEvents,
    theme: config.capsuleTheme,
    opacity: config.capsuleOpacity,
  };
  if (lastError) result.error = lastError;
  return result;
}

// ---------- 管理链接窗口 ----------
function openManageLinks() {
  if (manageWindow && !manageWindow.isDestroyed()) {
    manageWindow.focus();
    return;
  }
  manageWindow = new BrowserWindow({
    width: 620,
    height: 560,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    resizable: true,
    alwaysOnTop: true,
    parent: capsuleWindow,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  manageWindow.loadFile('manage-links.html');
  manageWindow.setMenuBarVisibility(false);
  manageWindow.on('closed', () => {
    manageWindow = null;
  });
  manageWindow.webContents.on('did-finish-load', () => {
    manageWindow.webContents.send('load-links', config.links);
    manageWindow.webContents.send('manage-theme-changed', config.manageTheme);
    manageWindow.webContents.send('capsule-theme-changed', config.capsuleTheme);
    manageWindow.webContents.send('capsule-opacity-changed', config.capsuleOpacity);
    manageWindow.webContents.send('link-errors-updated', linkErrors);
  });
}

// ---------- 托盘菜单 ----------
function createTray() {
  let trayIcon;
  const iconPath = path.join(__dirname, 'icon.ico');
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) throw new Error('Icon not found');
  } catch (e) {
    const base64Icon = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAZdEVYdFNvZnR3YXJlAHBhaW50Lm5ldCA0LjAuMTM0A1t6AAAAH0lEQVQ4T2P8//8/Ay0xTQAjzYBh4B0GfgMMMyABAAAA//8DAAv/A0bR2OH3AAAAAElFTkSuQmCC';
    trayIcon = nativeImage.createFromBuffer(Buffer.from(base64Icon, 'base64'));
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('TT-Calendar');
  updateTrayMenu();

  tray.on('double-click', () => {
    if (capsuleWindow && !capsuleWindow.isDestroyed()) {
      if (capsuleWindow.isVisible()) capsuleWindow.hide();
      else { capsuleWindow.show(); capsuleWindow.focus(); }
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示/隐藏', click: () => {
      if (capsuleWindow && !capsuleWindow.isDestroyed()) {
        if (capsuleWindow.isVisible()) capsuleWindow.hide();
        else { capsuleWindow.show(); capsuleWindow.focus(); }
      }
    }},
    { label: '刷新', click: () => { updateCache(); } },
    { label: '管理日历', click: () => { openManageLinks(); } },
    { label: '退出', click: () => { clearAllTimers(); app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

// ---------- IPC 事件 ----------
ipcMain.on('get-links', (event) => {
  event.reply('load-links', config.links);
});

ipcMain.on('add-link', (event, url, name, color) => {
  if (!url || !(url.startsWith('webcal://') || url.startsWith('https://'))) {
    event.reply('add-link-result', { success: false, msg: '链接必须以 webcal:// 或 https:// 开头' });
    return;
  }
  if (config.links.length >= 10) {
    event.reply('add-link-result', { success: false, msg: '最多支持10个链接' });
    return;
  }
  if (config.links.some(l => l.url === url)) {
    event.reply('add-link-result', { success: false, msg: '该链接已存在' });
    return;
  }
  const newColor = color || COLOR_PALETTE[config.links.length % COLOR_PALETTE.length];
  const newName = name || `日历${config.links.length + 1}`;
  config.links.push({ url, name: newName, color: newColor });
  saveConfig();
  updateCache();
  event.reply('add-link-result', { success: true, links: config.links });
});

ipcMain.on('update-link', (event, index, url, name, color) => {
  if (index < 0 || index >= config.links.length) {
    event.reply('update-link-result', { success: false, msg: '索引无效' });
    return;
  }
  if (!url || !(url.startsWith('webcal://') || url.startsWith('https://'))) {
    event.reply('update-link-result', { success: false, msg: '链接必须以 webcal:// 或 https:// 开头' });
    return;
  }
  if (config.links.some((l, i) => i !== index && l.url === url)) {
    event.reply('update-link-result', { success: false, msg: '该链接已存在' });
    return;
  }
  config.links[index].url = url;
  config.links[index].name = name || `日历${index+1}`;
  config.links[index].color = color || COLOR_PALETTE[index % COLOR_PALETTE.length];
  saveConfig();
  updateCache();
  event.reply('links-updated', config.links);
  event.reply('update-link-result', { success: true });
});

ipcMain.on('remove-link', (event, index) => {
  if (index >= 0 && index < config.links.length) {
    config.links.splice(index, 1);
    config.links.forEach((link, i) => {
      link.color = COLOR_PALETTE[i % COLOR_PALETTE.length];
      if (!link.name) link.name = `日历${i+1}`;
    });
    saveConfig();
    updateCache();
    event.reply('links-updated', config.links);
  }
});

ipcMain.on('move-link', (event, fromIndex, toIndex) => {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= config.links.length) return;
  if (toIndex < 0 || toIndex >= config.links.length) return;
  const [link] = config.links.splice(fromIndex, 1);
  config.links.splice(toIndex, 0, link);
  config.links.forEach((link, i) => {
    link.color = COLOR_PALETTE[i % COLOR_PALETTE.length];
    if (!link.name) link.name = `日历${i+1}`;
  });
  saveConfig();
  updateCache();
  event.reply('links-updated', config.links);
});

// 主题设置（胶囊）
ipcMain.on('set-capsule-theme', (event, theme) => {
  if (PRESET_THEMES.includes(theme)) {
    config.capsuleTheme = theme;
    saveConfig();
    if (capsuleWindow && !capsuleWindow.isDestroyed()) {
      capsuleWindow.webContents.send('capsule-theme-changed', theme);
    }
    if (manageWindow && !manageWindow.isDestroyed()) {
      manageWindow.webContents.send('capsule-theme-changed', theme);
    }
  }
});

// 透明度设置
ipcMain.on('set-capsule-opacity', (event, opacity) => {
  const val = Math.min(1, Math.max(0, opacity));
  config.capsuleOpacity = val;
  saveConfig();
  if (capsuleWindow && !capsuleWindow.isDestroyed()) {
    capsuleWindow.webContents.send('capsule-opacity-changed', val);
  }
  if (manageWindow && !manageWindow.isDestroyed()) {
    manageWindow.webContents.send('capsule-opacity-changed', val);
  }
});

// 管理窗口主题
ipcMain.on('set-manage-theme', (event, theme) => {
  if (theme === 'dark' || theme === 'light') {
    config.manageTheme = theme;
    saveConfig();
    if (manageWindow && !manageWindow.isDestroyed()) {
      manageWindow.webContents.send('manage-theme-changed', theme);
    }
  }
});

ipcMain.on('refresh-cache', () => {
  updateCache();
});

ipcMain.on('open-manage-links', () => {
  openManageLinks();
});

ipcMain.on('minimize-window', () => {
  if (capsuleWindow && !capsuleWindow.isDestroyed()) {
    capsuleWindow.minimize();
  }
});

// ---------- 导出配置（修复：直接使用 win 作为父窗口） ----------
ipcMain.handle('export-config', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return { success: false, error: '未找到窗口' };
  }
  const result = await dialog.showSaveDialog(win, {
    title: '导出配置',
    defaultPath: path.join(app.getPath('desktop'), 'tt-calendar-config.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!result.canceled && result.filePath) {
    try {
      fs.writeFileSync(result.filePath, JSON.stringify(config, null, 2));
      return { success: true, path: result.filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, canceled: true };
});

// ---------- 导入配置（修复：直接使用 win 作为父窗口） ----------
ipcMain.handle('import-config', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return { success: false, error: '未找到窗口' };
  }
  const result = await dialog.showOpenDialog(win, {
    title: '导入配置',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    try {
      const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
      const imported = JSON.parse(raw);
      if (imported.links) config.links = imported.links;
      if (imported.capsuleTheme) config.capsuleTheme = imported.capsuleTheme;
      if (imported.manageTheme) config.manageTheme = imported.manageTheme;
      if (typeof imported.capsuleOpacity === 'number') config.capsuleOpacity = imported.capsuleOpacity;
      config.links.forEach((link, index) => {
        if (!link.color) link.color = COLOR_PALETTE[index % COLOR_PALETTE.length];
        if (!link.name) link.name = `日历${index + 1}`;
      });
      saveConfig();
      updateCache();
      sendToRenderer('config-imported', config);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, canceled: true };
});

// ---------- 获取链接错误 ----------
ipcMain.handle('get-link-errors', () => {
  return linkErrors;
});

// ---------- 创建胶囊窗口 ----------
function createCapsuleWindow() {
  capsuleWindow = new BrowserWindow({
    width: 692,
    height: 350,
    minWidth: 692,
    minHeight: 350,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  capsuleWindow.loadFile('capsule.html');
  capsuleWindow.setMenuBarVisibility(false);
  capsuleWindow.on('closed', () => {
    clearAllTimers();
    capsuleWindow = null;
  });

  refreshInterval = setInterval(() => {
    updateCache();
  }, 30000);

  capsuleWindow.webContents.on('did-finish-load', () => {
    capsuleWindow.webContents.send('capsule-theme-changed', config.capsuleTheme);
    capsuleWindow.webContents.send('capsule-opacity-changed', config.capsuleOpacity);
  });

  // ---------- 全局快捷键 ----------
  globalShortcut.register('F10', () => {
    if (capsuleWindow && !capsuleWindow.isDestroyed()) {
      if (capsuleWindow.isVisible()) capsuleWindow.hide();
      else { capsuleWindow.show(); capsuleWindow.focus(); }
    }
  });
  globalShortcut.register('CommandOrControl+E', () => {
    updateCache();
  });
  // ESC 已在管理窗口内处理，不在此注册全局
}

// ---------- IPC 处理 ----------
ipcMain.handle('get-calendar-data', async () => await getCalendarData());

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  loadConfig();
  createTray();
  createCapsuleWindow();
  updateCache();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createCapsuleWindow();
  }
});