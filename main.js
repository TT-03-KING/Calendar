const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, dialog, screen, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ical = require('ical');
const axios = require('axios');
const { RRule } = require('rrule');

// ==================== 配置 ====================
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const COLOR_PALETTE = [
  '#4facfe', '#f093fb', '#4fdf7f', '#f7b731', '#ff6b6b',
  '#a29bfe', '#fd79a8', '#00cec9', '#fdcb6e', '#e17055'
];
const PRESET_THEMES = ['dark', 'light'];

// 系统亚克力（Windows 11 22H2 / build 22621+）：这是 Windows 上唯一能真正高斯模糊
// 「窗口背后桌面内容」的方式 —— CSS 的 backdrop-filter 在 transparent 窗口里做不到。
// 但 transparent + acrylic 会丢失窗口圆角（DWM 铺满整个矩形），胶囊会变成方角。
// 因此默认关闭，保持圆角；想要真模糊可设 TT_CALENDAR_ACRYLIC=1 试用。
const USE_SYSTEM_ACRYLIC = process.env.TT_CALENDAR_ACRYLIC === '1';
function supportsAcrylic() {
  if (process.platform !== 'win32') return false;
  const build = parseInt(os.release().split('.')[2], 10); // 10.0.22621 -> 22621
  return Number.isFinite(build) && build >= 22621;
}
// 启用系统亚克力时的布局适配：DWM 会铺满整个窗口（且会吃掉圆角），
// 因此去掉留白与会被裁掉的投影，模糊交给 DWM（页面内的磨砂层必须让位，否则双层模糊）。
const ACRYLIC_OVERRIDE_CSS = `
  html, body { padding: 0 !important; background: transparent !important; }
  /* 面板内自带底图 + 磨砂层，开了 DWM 亚克力就得关掉，否则既重复模糊又留方角 */
  #bg, #glass { display: none !important; }
  #edge {
    border-radius: 0 !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }
  .capsule, .container {
    width: 100% !important; height: 100% !important;
    max-width: none !important; max-height: none !important;
    /* DWM 亚克力会吃掉系统窗口圆角，DOM 同步变方并去掉边框/投影 */
    border-radius: 0 !important;
    border-color: transparent !important;
    box-shadow: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    /* 底图关掉后靠这层淡色保证文字对比度 */
    background-color: var(--tint) !important;
  }
`;

// 窗口尺寸预设：单列(compact)与双列
const WIN_SIZE = {
  normal:  { width: 692, height: 350 },
  compact: { width: 360, height: 300 },
};
// 快捷键默认值；用户可在设置里改
const DEFAULT_HOTKEYS = {
  refresh: 'CommandOrControl+E',
  toggleTop: 'CommandOrControl+T',
  togglePanel: 'F10',
};

// 自动刷新间隔：默认 30 分钟一次（以前是 30 秒，网络和 CPU 都被白刷）
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

let config = {
  links: [],
  theme: 'dark',                    // 两个窗口共用同一套深浅色（不再分开配置）
  frost: { bg: 0, card: 55 },       // 磨砂强度 0-100：分别对应 背景 / 日程条
  compact: false,                   // 单列显示
  alwaysOnTop: false,               // 固定在顶部
  autoLaunch: false,                // 开机自启动（以系统登录项为准，这里只是镜像）
  hotkeys: { ...DEFAULT_HOTKEYS },
  bgImage: '',                      // 自定义背景图（userData 内的文件名）
};

// 0-100 百分比收敛，非法值回落到 fallback
function clampPct(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// 背景图：读到内存后压成 JPEG dataURL 交给渲染层。
// 关键点：图片必须画在页面内部，backdrop-filter 才有东西可模糊 —— 这才是「真磨砂」。
const BG_MAX_WIDTH = 1920;
function bgFilePath(name) {
  return name ? path.join(app.getPath('userData'), name) : '';
}
// 生成压缩后的 dataURL；失败返回 ''（渲染层回退到内置渐变）
// 结果缓存：三个窗口都会各自 invoke 一次，不缓存的话每开一个窗口就要重新解码+编码一张大图。
let bgDataUrlCache = '';
function invalidateBgCache() { bgDataUrlCache = ''; }

function buildBgDataUrl() {
  if (bgDataUrlCache) return bgDataUrlCache;
  const p = bgFilePath(config.bgImage);
  if (!p || !fs.existsSync(p)) return '';
  try {
    let img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return '';
    const { width } = img.getSize();
    if (width > BG_MAX_WIDTH) img = img.resize({ width: BG_MAX_WIDTH, quality: 'good' });
    const jpeg = img.toJPEG(82);
    bgDataUrlCache = 'data:image/jpeg;base64,' + jpeg.toString('base64');
    return bgDataUrlCache;
  } catch (e) {
    console.warn('读取背景图失败:', e.message);
    return '';
  }
}
let capsuleWindow = null;
let manageWindow = null;
let tray = null;
let refreshInterval = null;
let cachedEvents = [];
let isFetching = false;
let hasFetchedOnce = false;   // 是否已经完成过一次拉取（避免空列表被反复触发）
let lastError = null;
let linkErrors = {};       // key → 诊断对象（名称/原因/建议/连续失败次数）
let failCounts = {};       // key → 连续失败次数
let errorWindow = null;    // 同步失败报告窗口

// ==================== 配置读写 ====================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      config.links = parsed.links || [];
      // 主题统一为一个：旧配置里 capsuleTheme / manageTheme 各自独立，迁移时优先取 capsuleTheme
      const legacyTheme = parsed.theme !== undefined ? parsed.theme : parsed.capsuleTheme;
      config.theme = legacyTheme === 'light' ? 'light' : 'dark';
      config.frost = {
        bg: clampPct(parsed.frost && parsed.frost.bg, 0),
        card: clampPct(parsed.frost && parsed.frost.card, 55),
      };
      config.compact = parsed.compact === true;
      config.alwaysOnTop = parsed.alwaysOnTop === true;
      config.hotkeys = { ...DEFAULT_HOTKEYS, ...(parsed.hotkeys || {}) };
      config.bgImage = typeof parsed.bgImage === 'string' ? parsed.bgImage : '';
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
  const wins = [capsuleWindow, manageWindow, errorWindow];
  for (const w of wins) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  }
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
    return { ok: true, events };
  } catch (e) {
    console.error('❌ 获取 chinese-days 失败:', e.message);
    return { ok: false, error: e };
  }
}

async function fetchLocalICS(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: { message: '本地 ICS 文件不存在或已被移动' } };
  }
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 90);
    return { ok: true, events: parseICSData(data, now, end) };
  } catch (e) {
    console.error(`❌ 读取本地 ICS 失败: ${filePath}`, e.message);
    return { ok: false, error: e };
  }
}

// 下拉 ICS 的公共会话配置。
// family: 4 是关键 —— 强制走 IPv4。iCloud 这类双栈域名在部分网络下会先试 IPv6，
// 没有 IPv6 出口时会一直挂着直到超时，表现就是"每次都 timeout"。
// keepAlive 让多次请求复用 TLS 连接，首次之后的刷新会快很多。
function buildHttpsAgent() {
  return new (require('https').Agent)({
    keepAlive: true,
    keepAliveMsecs: 1000,
    family: 4,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  });
}

// 只对"网络抖动类"错误重试：超时、连接被重置、DNS 临时失败。
// 证书错误、4xx 绝不重试（重试也不会变好，还拖慢整体时间）。
function isRetryableError(e) {
  const raw = `${(e && e.code) || ''} ${(e && e.message) || ''}`;
  return /ETIMEDOUT|ECONNABORTED|ECONNRESET|EAI_AGAIN|EPIPE|socket hang up|timeout/i.test(raw);
}

async function getWithRetry(url, cfg, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, cfg);
    } catch (e) {
      lastErr = e;
      if (!isRetryableError(e) || attempt === retries) throw e;
      console.warn(`↻ 请求失败，${600}ms 后重试 (${attempt + 1}/${retries}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

// ---- 用 Chromium 的网络栈抓取（首选通道） ----
// 为什么不用 Node 的 https：Node 不读系统代理设置，也不走系统证书库。
// 挂着代理/VPN 时就会出现"浏览器能打开订阅链接、程序一直 timeout"。
// Chromium 栈会走系统代理、用系统证书、自带 Happy Eyeballs（IPv6 不通自动回落 IPv4），
// 还能自动解 gzip/br —— 这几条正好覆盖了订阅超时的常见原因。
function netErrorToError(e) {
  const raw = String((e && e.message) || e || '');
  const map = [
    [/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/i, 'ETIMEDOUT', '连接超时'],
    [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_DNS/i, 'ENOTFOUND', '域名解析失败'],
    [/ERR_CONNECTION_REFUSED/i, 'ECONNREFUSED', '连接被拒绝'],
    [/ERR_CERT|ERR_SSL/i, 'CERT_INVALID', '证书校验不通过'],
    [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE/i, 'ENETUNREACH', '网络不可用'],
    [/ERR_PROXY|ERR_TUNNEL/i, 'EPROXY', '代理连接失败'],
    [/ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET/i, 'ECONNRESET', '连接被对方断开'],
  ];
  for (const [re, code, msg] of map) {
    if (re.test(raw)) return Object.assign(new Error(msg), { code, raw });
  }
  return Object.assign(new Error(raw || '网络请求失败'), { code: 'ENET', raw });
}

function fetchViaChromium(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { if (request) request.abort(); } catch {}
      finish(reject, Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    try {
      request = net.request({ method: 'GET', url, redirect: 'follow' });
    } catch (e) {
      finish(reject, netErrorToError(e));
      return;
    }

    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    request.setHeader('Accept', 'text/calendar,application/octet-stream,*/*');

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        finish(resolve, {
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', (e) => finish(reject, netErrorToError(e)));
    });
    request.on('error', (e) => finish(reject, netErrorToError(e)));
    request.end();
  });
}

async function fetchRemoteICS(url) {
  try {
    let requestUrl = url.startsWith('https://') ? url : url.replace(/^webcal:\/\//, 'https://');

    // ---- 通道 1：Chromium 网络栈（走系统代理 / 系统证书 / 自动回落 IPv4） ----
    let res = null;
    try {
      res = await fetchViaChromium(requestUrl, 25000);
    } catch (e) {
      console.warn(`⚠️ 系统网络栈失败（${e.code || 'ENET'} ${e.message}），回退到 Node 直连`);
    }

    // ---- 通道 2：Node https 直连（强制 IPv4 + 失败重试一次） ----
    if (!res) {
      const config = {
        timeout: 25000,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/calendar,application/octet-stream,*/*',
        },
        // 默认校验证书。之前无条件 rejectUnauthorized:false 会让任意中间人都能篡改日程数据。
        httpsAgent: buildHttpsAgent(),
      };
      let response;
      try {
        response = await getWithRetry(requestUrl, config);
      } catch (e) {
        // 只在「协议层不兼容」时降级到 HTTP。
        // 证书错误（过期/自签/域名不符）必须直接失败，否则等于把校验又关掉了。
        const isCertError = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALT_NAME|HOSTNAME/i.test(e.code || '') ||
                            /certificate|self.signed/i.test(e.message || '');
        if (!isCertError && (e.code === 'EPROTO' || e.message.includes('TLS') || e.message.includes('SSL'))) {
          const httpUrl = requestUrl.replace(/^https:\/\//, 'http://');
          console.log(`🔄 降级到 HTTP: ${httpUrl}`);
          response = await getWithRetry(httpUrl, { ...config, httpsAgent: null });
        } else throw e;
      }
      res = {
        status: response.status,
        body: typeof response.data === 'string' ? response.data : String(response.data || ''),
      };
    }

    // 4xx / 5xx 统一按状态码处理，交给 diagnoseFetchError 翻译
    if (res.status && (res.status < 200 || res.status >= 300)) {
      return {
        ok: false,
        error: Object.assign(new Error(`服务器返回 ${res.status}`), {
          code: `HTTP_${res.status}`,
          response: { status: res.status },
        }),
      };
    }

    // 校验拿到的到底是不是日历：不少订阅地址失效后会返回一个 HTML 登录页，
    // 以前这种情况会被当成「无日程」悄悄吞掉，用户完全不知道原因。
    const body = res.body || '';
    if (!/BEGIN:VCALENDAR/i.test(body)) {
      const looksHtml = /<html|<!doctype/i.test(body);
      return {
        ok: false,
        error: {
          message: looksHtml
            ? '服务器返回的是网页而不是日历（内容不是日历数据）'
            : '服务器返回的内容不是日历数据',
          code: looksHtml ? 'NOT_ICAL_HTML' : 'NOT_ICAL',
        },
      };
    }

    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 90);
    return { ok: true, events: parseICSData(body, now, end) };
  } catch (e) {
    console.error(`❌ 下载 ICS 失败 (${url}):`, e.message);
    return { ok: false, error: e };
  }
}

async function fetchCalendarFromURL(link) {
  if (link.type === 'local') return await fetchLocalICS(link.filePath);
  if (link.url === 'https://cdn.jsdelivr.net/npm/chinese-days/dist/holidays.ics') {
    return await fetchChineseDaysJSON();
  }
  return await fetchRemoteICS(link.url);
}

// ==================== 抓取失败诊断 ====================
// 把一个底层错误翻译成「人话」：标题（发生了什么）+ 详情（技术信息）+ 建议（怎么办）。
// 报告窗口直接用这三段，避免把 axios 的英文堆栈丢给用户。
function diagnoseFetchError(err) {
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || err || '未知错误');
  const status = err && err.response && err.response.status;
  const raw = code + ' ' + msg;

  if (status === 401 || status === 403) {
    return {
      title: '没有访问权限',
      detail: `服务器返回 ${status}`,
      hint: '这个日历地址可能需要登录，或订阅已过期。请到日历服务商处重新获取「私有/订阅」链接后再替换。',
    };
  }
  if (status === 404) {
    return {
      title: '链接不存在',
      detail: '服务器返回 404',
      hint: '订阅地址可能已经被删除或改过。请回到日历服务商重新复制一份订阅链接。',
    };
  }
  if (status >= 500) {
    return {
      title: '对方服务器出错',
      detail: `服务器返回 ${status}`,
      hint: '这是日历服务端的问题，通常过一会儿会自己恢复。可以稍后点「重新同步」再试。',
    };
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return {
      title: '域名解析失败',
      detail: code || 'ENOTFOUND',
      hint: '域名找不到，可能是链接写错了，或者当前网络无法解析该域名（试试关掉代理/VPN）。',
    };
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return {
      title: '连接被拒绝',
      detail: 'ECONNREFUSED',
      hint: '对方服务器没有接受连接。可能是地址端口不对，或该服务已停用。',
    };
  }
  if (/ETIMEDOUT|ECONNABORTED|timeout/i.test(raw)) {
    return {
      title: '连接超时',
      detail: '请求 25 秒内没有完成（已自动重试 1 次）',
      hint: '常见于代理/VPN 拦截、IPv6 出口不通，或对方服务器响应慢。可以关掉代理再试，或稍后点「重新同步」。',
    };
  }
  if (/EPROXY|ERR_PROXY|ERR_TUNNEL/i.test(raw)) {
    return {
      title: '代理连接失败',
      detail: code || 'EPROXY',
      hint: '系统代理/VPN 没能把请求送出去。检查代理是否在运行，或先退出代理再试。',
    };
  }
  if (/ENETUNREACH|ERR_INTERNET_DISCONNECTED/i.test(raw)) {
    return {
      title: '网络不可用',
      detail: code || 'ENETUNREACH',
      hint: '系统当前没有可用的网络连接，联网后会自动恢复。',
    };
  }
  if (/ECONNRESET|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED/i.test(raw)) {
    return {
      title: '连接被中断',
      detail: code || 'ECONNRESET',
      hint: '对方服务器提前关闭了连接，多半是临时的。点「重新同步」再试一次。',
    };
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALT_NAME|HOSTNAME|self.signed/i.test(raw)) {
    return {
      title: '证书校验不通过',
      detail: code || 'CERT 错误',
      hint: '对方用的 HTTPS 证书无效或与域名不匹配。出于安全考虑不会自动跳过校验，建议换用官方提供的订阅地址。',
    };
  }
  if (/EPROTO|SSL|TLS/i.test(raw)) {
    return {
      title: '安全连接建立失败',
      detail: code || 'TLS 错误',
      hint: 'TLS 握手失败，常见于老旧的服务器或中间网络干扰。',
    };
  }
  if (/内容不是日历|not ical/i.test(msg)) {
    return {
      title: '返回的不是日历数据',
      detail: msg,
      hint: '地址可能指向了一个普通网页或登录页。请在浏览器里打开这个链接，确认能下载到 .ics 文件。',
    };
  }
  return {
    title: '获取失败',
    detail: msg.slice(0, 200),
    hint: '检查网络后可以点「重新同步」重试；多次失败可考虑重新复制订阅链接。',
  };
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
    // 清掉已删除日历的失败计数，避免配置改来改去后残留一堆无用 key
    const validKeys = new Set(config.links.map(l => l.url || l.filePath || `link-${l.name}`));
    Object.keys(failCounts).forEach((k) => { if (!validKeys.has(k)) delete failCounts[k]; });

    // 并行拉取：多个订阅时总耗时取"最慢那个"，而不是一个个排队累加
    const settled = await Promise.all(config.links.map(async (link) => {
      const key = link.url || link.filePath || `link-${link.name}`;
      let res;
      try {
        res = await fetchCalendarFromURL(link);
      } catch (e) {
        res = { ok: false, error: e };
      }
      return { link, key, res };
    }));

    const allEvents = [];
    for (const { link, key, res } of settled) {
      if (!res || !res.ok) {
        // 连续失败计数：连续 2 次才认定「确实有问题」，避免偶发网络抖动就弹窗
        failCounts[key] = (failCounts[key] || 0) + 1;
        const diag = diagnoseFetchError(res && res.error);
        linkErrors[key] = {
          key,
          name: link.name || '未命名',
          url: link.type === 'local' ? (link.filePath || '') : (link.url || ''),
          type: link.type,
          title: diag.title,
          detail: diag.detail,
          hint: diag.hint,
          count: failCounts[key],
          at: Date.now(),
        };
        console.warn(`⚠️ 日历「${link.name}」失败(${failCounts[key]}): ${diag.title}`);
        continue;
      }

      failCounts[key] = 0;
      const events = res.events || [];
      if (events.length > 0) {
        events.forEach(ev => {
          ev.color = link.color;
          ev.calendarName = link.name || '未命名';
        });
        allEvents.push(...events);
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
    maybeShowErrorReport();
  } catch (e) {
    console.error('❌ 更新缓存异常:', e);
    lastError = e.message;
  } finally {
    isFetching = false;
    hasFetchedOnce = true;
  }
}

// ==================== IPC 处理 ====================
ipcMain.handle('get-calendar-data', async () => {
  // 只在"一次都没成功取过"时主动拉一次。
  // 之前用 cachedEvents.length === 0 判断：当天没有日程时列表本来就空，
  // 于是每次渲染都触发一次网络请求 —— 这就是"一直在刷"的来源。
  if (!hasFetchedOnce && !isFetching) await updateCache();
  return { events: cachedEvents, theme: config.theme, error: lastError };
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
    // 只允许删除位于 userData 目录内的文件，防止配置被篡改后误删/恶删任意路径
    const safeRoot = path.resolve(app.getPath('userData'));
    const target = path.resolve(link.filePath);
    if (target === safeRoot || target.startsWith(safeRoot + path.sep)) {
      try { fs.unlinkSync(target); console.log(`🗑️ 已删除本地 ICS: ${target}`); }
      catch (err) { console.warn(`⚠️ 删除文件失败: ${target}`, err); }
    } else {
      console.warn(`⚠️ 拒绝删除 userData 之外的文件: ${target}`);
    }
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

// ---------- 主题（两窗共用） / 磨砂强度 ----------
function applyTheme(theme) {
  if (!PRESET_THEMES.includes(theme)) return;
  config.theme = theme;
  saveConfig();
  sendToRenderer('theme-changed', config.theme);
}
ipcMain.on('set-theme', (e, theme) => applyTheme(theme));
// 旧渲染层/旧配置残留的通道，一并指向统一主题，避免出现两套状态
ipcMain.on('set-capsule-theme', (e, theme) => applyTheme(theme));

ipcMain.on('set-frost', (e, frost) => {
  if (!frost || typeof frost !== 'object') return;
  config.frost = {
    bg: clampPct(frost.bg, config.frost.bg),
    card: clampPct(frost.card, config.frost.card),
  };
  saveConfig();
  sendToRenderer('frost-changed', { ...config.frost });
});

ipcMain.on('refresh-cache', () => updateCache());
ipcMain.on('open-manage-links', () => openManageLinks());
// 面板没有任务栏入口（skipTaskbar），所以"最小化"等于隐藏，否则窗口会缩到无处可寻
ipcMain.on('minimize-window', () => {
  if (!capsuleWindow || capsuleWindow.isDestroyed()) return;
  setPanelHidden(true);
});

// ---------- 设置（布局 / 置顶 / 快捷键） ----------
ipcMain.handle('get-settings', () => publicSettings());

// ---------- 自定义背景图 ----------
ipcMain.handle('get-bg-image', () => buildBgDataUrl());

ipcMain.handle('choose-bg-image', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: '选择背景图',
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
  try {
    const src = result.filePaths[0];
    const ext = (path.extname(src) || '.jpg').toLowerCase();
    const fileName = 'bg' + ext;
    const dest = bgFilePath(fileName);
    fs.copyFileSync(src, dest);
    // 删掉旧扩展名的文件，避免 userData 里堆积
    if (config.bgImage && config.bgImage !== fileName) {
      try { fs.unlinkSync(bgFilePath(config.bgImage)); } catch {}
    }
    config.bgImage = fileName;
    invalidateBgCache();          // 换图了，缓存必须失效
    saveConfig();
    const dataUrl = buildBgDataUrl();
    sendToRenderer('bg-image-changed', dataUrl);
    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('clear-bg-image', () => {
  if (config.bgImage) {
    try { fs.unlinkSync(bgFilePath(config.bgImage)); } catch {}
  }
  config.bgImage = '';
  invalidateBgCache();
  saveConfig();
  sendToRenderer('bg-image-changed', '');
  return { success: true };
});

ipcMain.on('set-compact', (e, on) => setCompact(on));
ipcMain.on('set-always-on-top', (e, on) => setAlwaysOnTop(on));

const HOTKEY_ACTIONS = ['refresh', 'toggleTop', 'togglePanel'];

// 设置单个快捷键。accel 传空字符串表示「取消绑定」。
// 校验：新键既不能注册失败（无效/被系统占用），也不能把别的动作已经占用的键抢走。
ipcMain.on('set-hotkey', (e, action, accel) => {
  if (!HOTKEY_ACTIONS.includes(action)) return;
  const prev = config.hotkeys[action];
  const next = typeof accel === 'string' ? accel.trim() : '';

  config.hotkeys[action] = next;
  const failed = registerHotkeys();
  const stolen = Object.entries(config.hotkeys)
    .some(([k, v]) => k !== action && v && v === next);

  if (next && (failed.includes(action) || stolen)) {
    // 整体回滚，避免"新键抢了别人、别人悄悄失效"
    config.hotkeys[action] = prev;
    registerHotkeys();
    e.reply('hotkey-result', {
      success: false,
      msg: stolen ? '该组合键已被另一个动作占用' : '该组合键无效或已被其他程序占用',
      hotkeys: { ...config.hotkeys },
    });
    return;
  }

  saveConfig();
  sendToRenderer('settings-changed', publicSettings());
  e.reply('hotkey-result', { success: true, hotkeys: { ...config.hotkeys } });
});

ipcMain.on('reset-hotkeys', (e) => {
  config.hotkeys = { ...DEFAULT_HOTKEYS };
  const failed = registerHotkeys();   // 默认键理论上都能注册上，万一被占也只提示不阻断
  saveConfig();
  sendToRenderer('settings-changed', publicSettings());
  e.reply('hotkey-result', {
    success: true,
    hotkeys: { ...config.hotkeys },
    msg: failed.length ? '部分默认快捷键被其他程序占用' : '',
  });
});

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
    // 主题统一收敛；兼容旧配置文件里的 capsuleTheme / manageTheme
    const it = imported.theme !== undefined ? imported.theme : imported.capsuleTheme;
    if (it !== undefined) config.theme = it === 'light' ? 'light' : 'dark';
    if (imported.frost) {
      config.frost = {
        bg: clampPct(imported.frost.bg, config.frost.bg),
        card: clampPct(imported.frost.card, config.frost.card),
      };
    }
    if (imported.compact !== undefined) config.compact = imported.compact === true;
    if (imported.alwaysOnTop !== undefined) config.alwaysOnTop = imported.alwaysOnTop === true;
    config.links.forEach((l, i) => {
      if (!l.color) l.color = COLOR_PALETTE[i % COLOR_PALETTE.length];
      if (!l.name) l.name = `日历${i+1}`;
      if (!l.type) l.type = 'remote';
    });
    saveConfig();
    updateCache();
    sendToRenderer('config-imported', config);
    sendToRenderer('theme-changed', config.theme);
    sendToRenderer('frost-changed', { ...config.frost });
    sendToRenderer('settings-changed', publicSettings());
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// ==================== 窗口管理 ====================
function openManageLinks() {
  if (manageWindow && !manageWindow.isDestroyed()) { manageWindow.focus(); return; }
  // 设置面板比日历宽一些：单列卡片式布局需要横向空间，高度可取 640
  const MW = { width: 700, height: 640 };
  manageWindow = new BrowserWindow({
    width: MW.width, height: MW.height,
    minWidth: 520, minHeight: 440,
    transparent: true, frame: false, hasShadow: false,
    backgroundColor: '#00000000',
    resizable: true, alwaysOnTop: true,
    // 不设 parent：parent 隐藏时子窗口在 Windows 上会跟着不可见（从托盘打开设置就会踩到）
    // 同样先隐藏，等设置页首屏（主题/背景/磨砂）刷好再出现
    show: false,
    webPreferences: {
      // 与主窗口一致：关闭 nodeIntegration，隔离上下文，只通过 preload 暴露最小 API
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'manage-preload.js'),
    },
  });
  // 贴着日历面板打开，而不是屏幕正中（面板常被打到屏幕角落）
  if (capsuleWindow && !capsuleWindow.isDestroyed()) {
    const b = capsuleWindow.getBounds();
    const d = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(b.x + Math.round((b.width - MW.width) / 2), d.x + 12), d.x + d.width - MW.width - 12);
    const y = Math.min(Math.max(b.y, d.y + 12), d.y + d.height - MW.height - 12);
    manageWindow.setPosition(Math.round(x), Math.round(y));
  }
  manageWindow.loadFile('manage-links.html');
  manageWindow.setMenuBarVisibility(false);
  applyWindowMaterial(manageWindow);
  manageWindow.on('closed', () => { manageWindow = null; });
  // preload 一旦注入失败（例如沙箱里 require 了 Node 内置模块），
  // 页面里 window.ipcRenderer 会是 undefined，所有按钮静默失效。
  // 这里把原因打到控制台，别让它无声无息。
  manageWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error(`❌ 设置窗口 preload 注入失败: ${preloadPath}\n   ${error && error.message}`);
  });
  manageWindow.webContents.on('did-finish-load', () => {
    manageWindow.webContents.send('load-links', config.links);
    manageWindow.webContents.send('theme-changed', config.theme);
    manageWindow.webContents.send('settings-changed', publicSettings());
    manageWindow.webContents.send('link-errors-updated', linkErrors);
  });
  // 设置页首屏就绪后显示；兜底 1.5s
  clearTimeout(manageRevealTimer);
  manageRevealTimer = setTimeout(showManageWindow, 1500);
}

let manageRevealTimer = null;

function showManageWindow() {
  if (!manageWindow || manageWindow.isDestroyed() || manageWindow.isVisible()) return;
  clearTimeout(manageRevealTimer);
  manageWindow.show();
  manageWindow.focus();
}

ipcMain.on('manage-ready', showManageWindow);

// ==================== 面板显隐（F10） ====================
// 两个约束互相打架，最后这样取舍：
//   · 真 hide()/show() 会让 Windows 重建合成表面，出现一帧空白（就是那个"闪"）；
//   · 只把页面调透明则窗口还在，任务栏图标不会消失。
// 解法：窗口始终"显示"，隐藏 = 整页透明度归零 + 鼠标穿透；
//       任务栏图标问题用 skipTaskbar 解决（创建时就设好，运行期不再改窗口样式，
//       所以也不会因为改样式再闪一次）。
let panelHidden = false;

function setPanelHidden(hide, opts) {
  const win = capsuleWindow;
  if (!win || win.isDestroyed()) return;
  hide = !!hide;
  if (panelHidden === hide) return;
  panelHidden = hide;
  win.webContents.send('panel-hidden-changed', hide);
  if (hide) {
    // 透明时不要挡住下面的窗口，否则等于"看不见但还是挡路"
    win.setIgnoreMouseEvents(true);
  } else {
    win.setIgnoreMouseEvents(false);
    if (!opts || opts.focus !== false) win.focus();
  }
}


// ==================== 同步失败报告窗口 ====================
// 只有「连续失败 ≥2 次」才算真出问题，避免一次网络抖动就弹窗打扰；
// 同一轮问题 30 分钟内只弹一次。
const ERROR_REPORT_COOLDOWN = 30 * 60 * 1000;
let errorReportShownAt = 0;

function failingLinks() {
  return Object.values(linkErrors).filter(e => e && e.count >= 2);
}

function maybeShowErrorReport() {
  const list = failingLinks();
  if (!list.length) return;
  if (errorWindow && !errorWindow.isDestroyed()) return;
  if (Date.now() - errorReportShownAt < ERROR_REPORT_COOLDOWN) return;
  errorReportShownAt = Date.now();
  openErrorReport();
}

function openErrorReport() {
  if (errorWindow && !errorWindow.isDestroyed()) { errorWindow.focus(); return; }
  const MW = { width: 660, height: 560 };
  errorWindow = new BrowserWindow({
    width: MW.width, height: MW.height,
    minWidth: 520, minHeight: 360,
    transparent: true, frame: false, hasShadow: false,
    backgroundColor: '#00000000',
    resizable: true, alwaysOnTop: true, show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'manage-preload.js'),
    },
  });
  if (capsuleWindow && !capsuleWindow.isDestroyed()) {
    const b = capsuleWindow.getBounds();
    const d = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(b.x + Math.round((b.width - MW.width) / 2), d.x + 12), d.x + d.width - MW.width - 12);
    const y = Math.min(Math.max(b.y + Math.round((b.height - MW.height) / 2), d.y + 12), d.y + d.height - MW.height - 12);
    errorWindow.setPosition(Math.round(x), Math.round(y));
  }
  errorWindow.loadFile('error-report.html');
  errorWindow.setMenuBarVisibility(false);
  applyWindowMaterial(errorWindow);
  errorWindow.on('closed', () => { errorWindow = null; });
  // 等页面把诊断数据渲染完再显示，避免先闪一帧"没有问题"的空状态
  clearTimeout(errorRevealTimer);
  errorRevealTimer = setTimeout(showErrorWindow, 1200);
  errorWindow.webContents.on('did-finish-load', () => {
    if (!errorWindow || errorWindow.isDestroyed()) return;
    errorWindow.webContents.send('sync-errors', {
      errors: Object.values(linkErrors),
      total: config.links.length,
      at: Date.now(),
    });
    errorWindow.webContents.send('theme-changed', config.theme);
  });
}

ipcMain.handle('get-sync-errors', () => ({
  errors: Object.values(linkErrors),
  total: config.links.length,
  at: Date.now(),
}));

let errorRevealTimer = null;

function showErrorWindow() {
  if (!errorWindow || errorWindow.isDestroyed() || errorWindow.isVisible()) return;
  clearTimeout(errorRevealTimer);
  errorWindow.show();
  errorWindow.focus();
}

ipcMain.on('report-ready', showErrorWindow);

ipcMain.on('retry-sync', () => updateCache());
ipcMain.on('open-error-report', () => openErrorReport());
ipcMain.on('close-error-report', () => {
  if (errorWindow && !errorWindow.isDestroyed()) errorWindow.close();
});

// 透明窗口的材质策略：默认显式关掉 DWM 自动背景材质，
// 让 CSS 自己画的圆角胶囊 + 投影保持完整（不受系统 Mica/Acrylic 干扰）。
function applyWindowMaterial(win) {
  const useAcrylic = USE_SYSTEM_ACRYLIC && supportsAcrylic();
  if (typeof win.setBackgroundMaterial === 'function') {
    try {
      win.setBackgroundMaterial(useAcrylic ? 'acrylic' : 'none');
    } catch (e) {
      console.warn('设置窗口背景材质失败，沿用 CSS 材质:', e.message);
      return;
    }
  }
  if (useAcrylic) {
    // insertCSS 注入的是 author origin 末尾，配合 !important 可稳定压过页面 <style>。
    // 用 once 避免窗口 reload / 重新导航时重复叠加。
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) {
        win.webContents.insertCSS(ACRYLIC_OVERRIDE_CSS).catch(() => {});
      }
    });
  }
}

// 首次显示由渲染层「首屏已就绪」的信令触发，避免先出空白/白底再重绘
let capsuleRevealed = false;
let revealFallbackTimer = null;

function revealCapsule() {
  if (capsuleRevealed) return;
  if (!capsuleWindow || capsuleWindow.isDestroyed()) return;
  capsuleRevealed = true;
  if (revealFallbackTimer) { clearTimeout(revealFallbackTimer); revealFallbackTimer = null; }
  capsuleWindow.show();
  capsuleWindow.focus();
}

ipcMain.on('panel-ready', revealCapsule);

function createCapsuleWindow() {
  const size = config.compact ? WIN_SIZE.compact : WIN_SIZE.normal;
  capsuleRevealed = false;
  capsuleWindow = new BrowserWindow({
    width: size.width, height: size.height,
    // 不锁死最小尺寸：允许拖小，内容由页面自行精简
    minWidth: 240, minHeight: 150,
    transparent: true, frame: false, hasShadow: false,
    backgroundColor: '#00000000',
    // 关键：先不显示。等页面把主题/背景/磨砂都刷好再 show，
    // 否则会先出现一帧空白，再出现一帧成品 —— 也就是你看到的「闪两次」。
    show: false,
    // skipTaskbar 常开：这是个桌面浮窗，不是任务栏应用。
    // 常开也避免运行期改窗口样式（改样式同样会触发一次重绘/闪烁）。
    resizable: true, alwaysOnTop: config.alwaysOnTop, skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 隐藏时不要节流：F10 再次唤起时不必重新合成，避免二次闪烁
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  capsuleWindow.loadFile('capsule.html');
  capsuleWindow.setMenuBarVisibility(false);
  applyWindowMaterial(capsuleWindow);
  capsuleWindow.on('closed', () => {
    clearAllTimers();
    capsuleWindow = null;
    capsuleRevealed = false;
  });
  capsuleWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error(`❌ 主面板 preload 注入失败: ${preloadPath}\n   ${error && error.message}`);
  });
  capsuleWindow.webContents.on('did-finish-load', () => {
    // 页面已自行 invoke 拿到首屏状态，这里只同步可能变化的部分
    capsuleWindow.webContents.send('settings-changed', publicSettings());
    capsuleWindow.webContents.send('panel-hidden-changed', panelHidden);
  });
  // 被外部聚焦（Alt-Tab / 程序唤起）时，如果正处于隐藏态就顺便显示出来
  capsuleWindow.on('focus', () => {
    if (panelHidden) setPanelHidden(false, { focus: false });
  });
  // 兜底：页面若因异常没发信令，也不能一直不显示
  revealFallbackTimer = setTimeout(revealCapsule, 2500);
  refreshInterval = setInterval(updateCache, REFRESH_INTERVAL_MS);
  registerHotkeys();
}

// 暴露给渲染层的设置
function publicSettings() {
  return {
    compact: !!config.compact,
    alwaysOnTop: !!config.alwaysOnTop,
    // 以系统登录项为准：用户可能在任务管理器里直接改过
    autoLaunch: getAutoLaunch(),
    hotkeys: { ...config.hotkeys },
    theme: config.theme,
    frost: { ...config.frost },
  };
}

// 注册全局快捷键：先全部注销再按配置重挂，避免残留冲突
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const actions = {
    refresh: () => updateCache(),
    toggleTop: () => setAlwaysOnTop(!config.alwaysOnTop),
    togglePanel: () => togglePanel(),
  };
  const failed = [];
  for (const [key, accel] of Object.entries(config.hotkeys || {})) {
    if (!accel || !actions[key]) continue;
    try {
      if (!globalShortcut.register(accel, actions[key])) failed.push(key);
    } catch (e) {
      console.warn(`快捷键 ${accel} 注册失败:`, e.message);
      failed.push(key);
    }
  }
  return failed;
}

function togglePanel() {
  const win = capsuleWindow;
  if (!win || win.isDestroyed()) return;
  // 还没完成首屏，先走首次显示流程
  if (!capsuleRevealed) { revealCapsule(); return; }
  setPanelHidden(!panelHidden);
}

function setAlwaysOnTop(on) {
  config.alwaysOnTop = !!on;
  saveConfig();
  if (capsuleWindow && !capsuleWindow.isDestroyed()) capsuleWindow.setAlwaysOnTop(config.alwaysOnTop);
  sendToRenderer('settings-changed', publicSettings());
}

// 单列/双列：同时调整窗口宽度，让面板真正"缩小"
function setCompact(on) {
  config.compact = !!on;
  saveConfig();
  const size = config.compact ? WIN_SIZE.compact : WIN_SIZE.normal;
  if (capsuleWindow && !capsuleWindow.isDestroyed()) {
    capsuleWindow.setMinimumSize(240, 150);
    capsuleWindow.setSize(size.width, size.height, true);
  }
  sendToRenderer('settings-changed', publicSettings());
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
  tray.on('double-click', () => togglePanel());
  updateTrayMenu();
}

// 右键菜单只用系统原生（自绘的那版在 Windows 上焦点/关闭时机太脆）
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '设置…', click: openManageLinks },
    { type: 'separator' },
    { label: '退出', click: () => { clearAllTimers(); app.quit(); } },
  ]));
}

// ==================== 开机自启动 ====================
function getAutoLaunch() {
  try { return !!app.getLoginItemSettings().openAtLogin; } catch { return false; }
}

function setAutoLaunch(on) {
  config.autoLaunch = !!on;
  saveConfig();
  try {
    // 开发态（electron .）要把应用目录作为参数带上；打包后直接指 exe
    const args = app.isPackaged ? [] : [app.getAppPath()];
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args });
  } catch (e) {
    console.warn('设置开机自启动失败:', e.message);
  }
  sendToRenderer('settings-changed', publicSettings());
}

ipcMain.on('set-auto-launch', (e, on) => setAutoLaunch(on));

// ==================== 生命周期 ====================
app.whenReady().then(() => {
  loadConfig();
  // 开机自启动以系统登录项为准，配置里只是镜像（用户可能在任务管理器里改过）
  config.autoLaunch = getAutoLaunch();
  createTray();
  createCapsuleWindow();
  updateCache();
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createCapsuleWindow();
});