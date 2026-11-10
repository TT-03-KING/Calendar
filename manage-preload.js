// 管理窗口专用 preload。
// 之前该窗口是 nodeIntegration:true + contextIsolation:false，页面里直接 require('electron')，
// 一旦链接名/地址里带注入内容就等于把 Node 能力交给了远程数据。这里改为最小暴露：
// 只给页面它真正用到的三样东西（ipcRenderer 的 on/send/invoke，以及 basename）。
//
// ⚠️ 重要：Electron 20+ 渲染进程 preload 默认 sandbox: true，
// 沙箱里只能 require('electron' | 'events' | 'timers' | 'url')。
// 一旦 require('path') 这类 Node 内置模块，preload 会整体抛错、注入失败，
// 页面里 window.ipcRenderer 就是 undefined —— 表现是「按钮全都不响应、没有任何报错」。
// 所以这里不依赖 path，自己实现 basename。
const { contextBridge, ipcRenderer } = require('electron');

function basename(p) {
  if (!p) return '';
  const s = String(p).replace(/[\\/]+$/, '');        // 去掉结尾的分隔符（目录路径）
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

contextBridge.exposeInMainWorld('ipcRenderer', {
  on: (channel, listener) => {
    const wrapped = (event, ...args) => listener(event, ...args);
    ipcRenderer.on(channel, wrapped);
    return wrapped;
  },
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});

contextBridge.exposeInMainWorld('nodePath', { basename });
