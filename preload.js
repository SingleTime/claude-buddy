const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("buddy", {
  init: () => ipcRenderer.invoke("app:init"),

  newSession: (cwd) => ipcRenderer.invoke("session:new", cwd),
  loadSession: (id) => ipcRenderer.invoke("session:load", id),
  deleteSession: (id) => ipcRenderer.invoke("session:delete", id),
  send: (id, text, attachments) => ipcRenderer.invoke("session:send", { id, text, attachments }),
  stop: (id) => ipcRenderer.invoke("session:stop", id),

  // 附件：选文件 / 导入已选路径 / 存粘贴的图 / 只读预览
  pickFiles: () => ipcRenderer.invoke("file:pick"),
  // Electron 20+ 删了 File.path，拖进来的文件只能从这里取真实路径
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  attachFiles: (sessionId, paths) => ipcRenderer.invoke("attachment:import", { sessionId, paths }),
  attachDataUrl: (sessionId, name, dataUrl) =>
    ipcRenderer.invoke("attachment:saveDataUrl", { sessionId, name, dataUrl }),
  previewFile: (p, sessionId) => ipcRenderer.invoke("file:preview", { path: p, sessionId }),
  thumb: (p) => ipcRenderer.invoke("attachment:thumb", p),

  searchSessions: (q) => ipcRenderer.invoke("session:search", q),

  listTasks: () => ipcRenderer.invoke("task:list"),
  saveTask: (input) => ipcRenderer.invoke("task:save", input),
  deleteTask: (id) => ipcRenderer.invoke("task:delete", id),
  toggleTask: (id, enabled) => ipcRenderer.invoke("task:toggle", { id, enabled }),
  runTask: (id) => ipcRenderer.invoke("task:run", id),
  stopTask: (id) => ipcRenderer.invoke("task:stop", id),

  updateConfig: (patch) => ipcRenderer.invoke("config:update", patch),
  pickDir: () => ipcRenderer.invoke("dialog:pickDir"),
  openPath: (p) => ipcRenderer.invoke("shell:openPath", p),

  onEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("evt", handler);
    return () => ipcRenderer.removeListener("evt", handler);
  },

  // 安装向导窗口用（主窗口也能拿到，但不会用）
  install: {
    start: (method) => ipcRenderer.invoke("install:start", method),
    close: () => ipcRenderer.invoke("install:close"),
    docs: () => ipcRenderer.invoke("install:docs"),
    recheck: () => ipcRenderer.invoke("install:recheck"),
    onLog: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("install:log", handler);
      return () => ipcRenderer.removeListener("install:log", handler);
    },
    onState: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("install:state", handler);
      return () => ipcRenderer.removeListener("install:state", handler);
    },
  },
});
