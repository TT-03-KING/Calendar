const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ical = require('ical');
const axios = require('axios');
const { RRule } = require('rrule');

// ==================== 配置 ====================
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const COLOR_PALETTE = [
  '#4facfe', '#f093fb', '#4fdf7f', '#f7b731', '#ff6b6b',
  '#a29bfe', '#fd79a8', '#00cec9', '#fdcb6e', '#e17055'
];
const PRESET_THEMES = ['dark', 'light', 'warm', 'cool'];

let config = {
  links: [],
  capsuleTheme: 'dark',
  manageTheme: 'dark',
  capsuleOpacity: 0.08,
  manageOpacity: 1.0,
};
let capsuleWindow = null;
let manageWindow = null;
let tray = null;
let refreshInterval = null;
let cachedEvents = [];
let isFetching = false;
let lastError = null;
let linkErrors = {};

// ==================== 配置读写 ====================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      config.links = parsed.links || [];
      config.capsuleTheme = parsed.capsuleTheme || 'dark';
      config.manageTheme = parsed.manageTheme || 'dark';
      config.capsuleOpacity = typeof parsed.capsuleOpacity === 'number' ? parsed.capsuleOpacity : 0.08;
      config.manageOpacity = typeof parsed.manageOpacity === 'number' ? parsed.manageOpacity : 1.0;
      config.links.forEach((link, i) => {
        if (!link.color) link.color = COLOR_PALETTE[i % COLOR_PALETTE.length];
        if (!link.name) link.name = `日历${i + 1}`;
        if (!link.type) link.type = 'remote';
      });
    }
  } catch (e) { console.warn('配置加载失败，使用默认', e); }
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } 
  catch (e) { console.error('配置保存失败', e); }
}

// ==================== 工具函数 ====================
function sendToRenderer(channel, ...args) {
  if (capsuleWindow && !capsuleWindow.isDestroyed()) capsuleWindow.webContents.send(channel, ...args);
  if (manageWindow && !manageWindow.isDestroyed()) manageWindow.webContents.send(channel, ...args);
}

function extractValue(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number') return String(obj);
  if (Array.isArray(obj)) return obj.length ? extractValue(obj[0]) : '';
  if (typeof obj === 'object') {
    for (const f of ['val', '_', '_text', 'value', 'text', 'summary']) {
      if (obj[f] !== undefined && obj[f] !== null) {
        const v = extractValue(obj[f]);
        if (v) return v;
      }
    }
    for (const k in obj) {
      if (obj.hasOwnProperty(k) && typeof obj[k] !== 'function') {
        const v = extractValue(obj[k]);
        if (v) return v;
      }
    }
    return '';
  }
  return String(obj);
}

// ==================== ICS 解析（支持 RRULE） ====================
function parseICSData(icsData, now, end) {
  const parsed = ical.parseICS(icsData);
  const events = [];
  for (const key in parsed) {
    const ev = parsed[key];
    if (ev.type !== 'VEVENT' || !ev.start) continue;

    let summary = '无标题';
    if (ev.summary) {
      const extracted = extractValue(ev.summary);
      summary = (extracted && typeof extracted === 'string' && extracted.trim()) 
        ? extracted.trim() 
        : (String(ev.summary) !== '[object Object]' ? String(ev.summary).trim() : '无标题');
    }

    let location = '';
    if (ev.location) {
      const loc = extractValue(ev.location);
      if (loc && typeof loc === 'string') location = loc;
    }

    const expandRRule = (rrule) => {
      let occurrences = [];
      if (typeof rrule.between === 'function') {
        occurrences = rrule.between(now, end, true);
      } else {
        let str = null;
        if (typeof rrule === 'string') str = rrule;
        else if (typeof rrule === 'object' && rrule.val) str = rrule.val;
        if (str) {
          const r = RRule.fromString(str);
          occurrences = r.between(now, end, true);
        }
      }
      return occurrences;
    };

    if (ev.rrule) {
      try {
        const occurrences = expandRRule(ev.rrule);
        for (const occ of occurrences) {
          const startDate = new Date(occ);
          let endDate = null;
          if (ev.end) {
            const diff = new Date(ev.end).getTime() - new Date(ev.start).getTime();
            if (diff > 0) endDate = new Date(startDate.getTime() + diff);
          }
          if (endDate && endDate <= now) continue;
          events.push({ summary, start: startDate, end: endDate, location });
        }
      } catch {
        // 展开失败，回退单个事件
        const startDate = new Date(ev.start);
        const endDate = ev.end ? new Date(ev.end) : null;
        if (startDate >= now && (!endDate || endDate > now) && startDate <= end) {
          events.push({ summary, start: startDate, end: endDate, location });
        }
      }
    } else {
      const startDate = new Date(ev.start);
      const endDate = ev.end ? new Date(ev.end) : null;
      if (startDate >= now && (!endDate || endDate > now) && startDate <= end) {
        events.push({ summary, start: startDate, end: endDate, location });
      }
    }
  }
  events.sort((a, b) => a.start - b.start);
  return events;
}

// ==================== 数据源拉取 ====================
async function fetchChineseDaysJSON() {
  try {
    const response = await axios.get('https://cdn.jsdelivr.net/npm/chinese-days/dist/chinese-days.json', { timeout: 15000 });
    const holidays = response.data.holidays || {};
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 90);
    const events = [];
    for (const dateStr in holidays) {
      const date = new Date(dateStr);
      if (isNaN(date.getTime()) || date < now || date > end) continue;
      events.push({
        summary: holidays[dateStr].name || '节假日',
        start: date,
        end: null,
        location: '',
      });
    }
    events.sort((a, b) => a.start - b.start);
    return events;
  } catch (e) {
    console.error('❌ 获取 chinese-days 失败:', e.message);
    return null;
  }
}

async function fetchLocalICS(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 90);
    return parseICSData(data, now, end);
  } catch (e) {
    console.error(`❌ 读取本地 ICS 失败: ${filePath}`, e.message);
    return null;
  }
}

async function fetchRemoteICS(url) {
  try {
    let requestUrl = url.startsWith('https://') ? url : url.replace(/^webcal:\/\//, 'https://');
    const config = {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/calendar,application/octet-stream',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
      }),
    };
    let response;
    try {
      response = await axios.get(requestUrl, config);
    } catch (e) {
      if (e.code === 'EPROTO' || e.message.includes('TLS') || e.message.includes('SSL')) {
        const httpUrl = requestUrl.replace(/^https:\/\//, 'http://');
        console.log(`🔄 降级到 HTTP: ${httpUrl}`);
        response = await axios.get(httpUrl, { ...config, httpsAgent: null });
      } else throw e;
    }
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 90);
    return parseICSData(response.data, now, end);
  } catch (e) {
    console.error(`❌ 下载 ICS 失败 (${url}):`, e.message);
    return null;
  }
}

async function fetchCalendarFromURL(link) {
  if (link.type === 'local') return await fetchLocalICS(link.filePath);
  if (link.url === 'https://cdn.jsdelivr.net/npm/chinese-days/dist/holidays.ics') {
    return await fetchChineseDaysJSON();
  }
  return await fetchRemoteICS(link.url);
}

// ==================== 缓存更新 ====================
async function updateCache() {
  if (isFetching) return;
  isFetching = true;
  lastError = null;
  linkErrors = {};
  try {
    if (config.links.length === 0) {
      lastError = '请添加至少一个日历链接';
      cachedEvents = [];
      sendToRenderer('refresh-calendar');
      sendToRenderer('link-errors-updated', linkErrors);
      return;
    }
    const allEvents = [];
    for (const link of config.links) {
      const events = await fetchCalendarFromURL(link);
      if (events && events.length > 0) {
        events.forEach(ev => {
          ev.color = link.color;
          ev.calendarName = link.name || '未命名';
        });
        allEvents.push(...events);
      } else {
        const key = link.url || link.filePath || 'unknown';
        linkErrors[key] = `日历 "${link.name}" 获取失败或无日程`;
        console.warn(`⚠️ ${linkErrors[key]}`);
      }
    }
    if (allEvents.length > 0) {
      const dedupMap = new Map();
      for (const ev of allEvents) {
        const key = `${ev.summary}|${ev.start.getMonth()+1}|${ev.start.getDate()}`;
        if (!dedupMap.has(key) || ev.start > dedupMap.get(key).start) {
          dedupMap.set(key, ev);
        }
      }
      cachedEvents = Array.from(dedupMap.values()).sort((a, b) => a.start - b.start);
      console.log(`✅ 去重前: ${allEvents.length} 个，去重后: ${cachedEvents.length} 个`);
    } else {
      cachedEvents = [];
      lastError = Object.keys(linkErrors).length ? '部分日历获取失败' : '所有链接均无日程';
    }
    sendToRenderer('refresh-calendar');
    sendToRenderer('link-errors-updated', linkErrors);
  } catch (e) {
    console.error('❌ 更新缓存异常:', e);
    lastError = e.message;
  } finally {
    isFetching = false;
  }
}

// ==================== IPC 处理 ====================
ipcMain.handle('get-calendar-data', async () => {
  if (cachedEvents.length === 0 && !isFetching) await updateCache();
  return { events: cachedEvents, theme: config.capsuleTheme, opacity: config.capsuleOpacity, error: lastError };
});

ipcMain.handle('get-link-errors', () => linkErrors);

// ---------- 链接管理 ----------
ipcMain.on('get-links', (e) => e.reply('load-links', config.links));

ipcMain.on('add-link', (e, url, name, color) => {
  if (!url || !/^(webcal|https):\/\//.test(url)) {
    return e.reply('add-link-result', { success: false, msg: '链接必须以 webcal:// 或 https:// 开头' });
  }
  if (config.links.length >= 10) return e.reply('add-link-result', { success: false, msg: '最多10个链接' });
  if (config.links.some(l => l.url === url)) return e.reply('add-link-result', { success: false, msg: '链接已存在' });
  const newLink = {
    url,
    name: name || `日历${config.links.length+1}`,
    color: color || COLOR_PALETTE[config.links.length % COLOR_PALETTE.length],
    type: 'remote',
  };
  config.links.push(newLink);
  saveConfig();
  updateCache();
  e.reply('add-link-result', { success: true, links: config.links });
});

ipcMain.on('update-link', (e, index, url, name, color) => {
  if (index < 0 || index >= config.links.length) return e.reply('update-link-result', { success: false, msg: '索引无效' });
  const link = config.links[index];
  if (link.type === 'local') {
    link.name = name || link.name;
    link.color = color || link.color;
    saveConfig();
    updateCache();
    e.reply('links-updated', config.links);
    return e.reply('update-link-result', { success: true });
  }
  if (!url || !/^(webcal|https):\/\//.test(url)) {
    return e.reply('update-link-result', { success: false, msg: '链接必须以 webcal:// 或 https:// 开头' });
  }
  if (config.links.some((l, i) => i !== index && l.url === url)) {
    return e.reply('update-link-result', { success: false, msg: '链接已存在' });
  }
  link.url = url;
  link.name = name || link.name;
  link.color = color || link.color;
  saveConfig();
  updateCache();
  e.reply('links-updated', config.links);
  e.reply('update-link-result', { success: true });
});

ipcMain.on('remove-link', (e, index) => {
  if (index < 0 || index >= config.links.length) return;
  const link = config.links[index];
  if (link.type === 'local' && link.filePath && fs.existsSync(link.filePath)) {
    try { fs.unlinkSync(link.filePath); console.log(`🗑️ 已删除本地 ICS: ${link.filePath}`); } 
    catch (err) { console.warn(`⚠️ 删除文件失败: ${link.filePath}`, err); }
  }
  config.links.splice(index, 1);
  config.links.forEach((l, i) => { l.color = COLOR_PALETTE[i % COLOR_PALETTE.length]; if (!l.name) l.name = `日历${i+1}`; });
  saveConfig();
  updateCache();
  e.reply('links-updated', config.links);
});

ipcMain.on('move-link', (e, from, to) => {
  if (from === to || from < 0 || from >= config.links.length || to < 0 || to >= config.links.length) return;
  const [link] = config.links.splice(from, 1);
  config.links.splice(to, 0, link);
  config.links.forEach((l, i) => { l.color = COLOR_PALETTE[i % COLOR_PALETTE.length]; if (!l.name) l.name = `日历${i+1}`; });
  saveConfig();
  updateCache();
  e.reply('links-updated', config.links);
});

// ---------- 导入 ICS 文件 ----------
ipcMain.handle('import-ics', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, error: '未找到窗口' };
  const result = await dialog.showOpenDialog(win, {
    title: '导入 ICS 日历文件',
    filters: [{ name: 'ICS 文件', extensions: ['ics'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
  const srcPath = result.filePaths[0];
  const fileName = path.basename(srcPath);
  const destPath = path.join(app.getPath('userData'), fileName);
  try {
    fs.copyFileSync(srcPath, destPath);
    const newLink = {
      name: path.basename(fileName, '.ics'),
      color: COLOR_PALETTE[config.links.length % COLOR_PALETTE.length],
      type: 'local',
      filePath: destPath,
    };
    config.links.push(newLink);
    saveConfig();
    updateCache();
    return { success: true, link: newLink };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------- 主题 & 透明度 ----------
ipcMain.on('set-capsule-theme', (e, theme) => {
  if (!PRESET_THEMES.includes(theme)) return;
  config.capsuleTheme = theme;
  saveConfig();
  sendToRenderer('capsule-theme-changed', theme);
});

ipcMain.on('set-manage-theme', (e, theme) => {
  if (!['dark', 'light'].includes(theme)) return;
  config.manageTheme = theme;
  saveConfig();
  if (manageWindow && !manageWindow.isDestroyed()) manageWindow.webContents.send('manage-theme-changed', theme);
});

ipcMain.on('set-capsule-opacity', (e, opacity) => {
  const val = Math.min(1, Math.max(0, opacity));
  config.capsuleOpacity = val;
  saveConfig();
  sendToRenderer('capsule-opacity-changed', val);
});

ipcMain.on('set-manage-opacity', (e, opacity) => {
  const val = Math.min(1, Math.max(0, opacity));
  config.manageOpacity = val;
  saveConfig();
  if (manageWindow && !manageWindow.isDestroyed()) manageWindow.webContents.send('manage-opacity-changed', val);
});

ipcMain.on('refresh-cache', () => updateCache());
ipcMain.on('open-manage-links', () => openManageLinks());
ipcMain.on('minimize-window', () => { if (capsuleWindow && !capsuleWindow.isDestroyed()) capsuleWindow.minimize(); });

// ---------- 导入/导出配置 ----------
ipcMain.handle('export-config', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, error: '未找到窗口' };
  const result = await dialog.showSaveDialog(win, {
    title: '导出配置',
    defaultPath: path.join(app.getPath('desktop'), 'tt-calendar-config.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(config, null, 2));
    return { success: true, path: result.filePath };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('import-config', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, error: '未找到窗口' };
  const result = await dialog.showOpenDialog(win, {
    title: '导入配置',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
  try {
    const imported = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
    if (imported.links) config.links = imported.links;
    if (imported.capsuleTheme) config.capsuleTheme = imported.capsuleTheme;
    if (imported.manageTheme) config.manageTheme = imported.manageTheme;
    if (typeof imported.capsuleOpacity === 'number') config.capsuleOpacity = imported.capsuleOpacity;
    if (typeof imported.manageOpacity === 'number') config.manageOpacity = imported.manageOpacity;
    config.links.forEach((l, i) => {
      if (!l.color) l.color = COLOR_PALETTE[i % COLOR_PALETTE.length];
      if (!l.name) l.name = `日历${i+1}`;
      if (!l.type) l.type = 'remote';
    });
    saveConfig();
    updateCache();
    sendToRenderer('config-imported', config);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// ==================== 窗口管理 ====================
function openManageLinks() {
  if (manageWindow && !manageWindow.isDestroyed()) { manageWindow.focus(); return; }
  manageWindow = new BrowserWindow({
    width: 660, height: 580,
    transparent: true, frame: false, hasShadow: false,
    backgroundColor: '#00000000',
    resizable: true, alwaysOnTop: true, parent: capsuleWindow,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  manageWindow.loadFile('manage-links.html');
  manageWindow.setMenuBarVisibility(false);
  manageWindow.on('closed', () => { manageWindow = null; });
  manageWindow.webContents.on('did-finish-load', () => {
    manageWindow.webContents.send('load-links', config.links);
    manageWindow.webContents.send('manage-theme-changed', config.manageTheme);
    manageWindow.webContents.send('capsule-theme-changed', config.capsuleTheme);
    manageWindow.webContents.send('capsule-opacity-changed', config.capsuleOpacity);
    manageWindow.webContents.send('manage-opacity-changed', config.manageOpacity);
    manageWindow.webContents.send('link-errors-updated', linkErrors);
  });
}

function createCapsuleWindow() {
  capsuleWindow = new BrowserWindow({
    width: 692, height: 350,
    minWidth: 692, minHeight: 350,
    transparent: true, frame: false, hasShadow: false,
    backgroundColor: '#00000000',
    resizable: true, alwaysOnTop: false, skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  capsuleWindow.loadFile('capsule.html');
  capsuleWindow.setMenuBarVisibility(false);
  capsuleWindow.on('closed', () => { clearAllTimers(); capsuleWindow = null; });
  capsuleWindow.webContents.on('did-finish-load', () => {
    capsuleWindow.webContents.send('capsule-theme-changed', config.capsuleTheme);
    capsuleWindow.webContents.send('capsule-opacity-changed', config.capsuleOpacity);
  });
  refreshInterval = setInterval(updateCache, 30000);
  // 全局快捷键
  globalShortcut.register('F10', () => {
    if (capsuleWindow && !capsuleWindow.isDestroyed()) {
      capsuleWindow.isVisible() ? capsuleWindow.hide() : (capsuleWindow.show(), capsuleWindow.focus());
    }
  });
  globalShortcut.register('CommandOrControl+E', updateCache);
}

function clearAllTimers() {
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
  globalShortcut.unregisterAll();
}

// ==================== 托盘 ====================
function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
    if (icon.isEmpty()) throw new Error();
  } catch {
    icon = nativeImage.createFromBuffer(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAZdEVYdFNvZnR3YXJlAHBhaW50Lm5ldCA0LjAuMTM0A1t6AAAAH0lEQVQ4T2P8//8/Ay0xTQAjzYBh4B0GfgMMMyABAAAA//8DAAv/A0bR2OH3AAAAAElFTkSuQmCC', 'base64'
    ));
  }
  tray = new Tray(icon);
  tray.setToolTip('TT-Calendar');
  tray.on('double-click', () => {
    if (capsuleWindow && !capsuleWindow.isDestroyed()) {
      capsuleWindow.isVisible() ? capsuleWindow.hide() : (capsuleWindow.show(), capsuleWindow.focus());
    }
  });
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示/隐藏', click: () => {
      if (capsuleWindow && !capsuleWindow.isDestroyed()) {
        capsuleWindow.isVisible() ? capsuleWindow.hide() : (capsuleWindow.show(), capsuleWindow.focus());
      }
    }},
    { label: '刷新', click: updateCache },
    { label: '管理日历', click: openManageLinks },
    { label: '退出', click: () => { clearAllTimers(); app.quit(); } }
  ]));
}

// ==================== 生命周期 ====================
app.whenReady().then(() => {
  loadConfig();
  createTray();
  createCapsuleWindow();
  updateCache();
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createCapsuleWindow();
});