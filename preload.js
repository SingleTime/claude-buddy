const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("buddy", {
  init: () => ipcRenderer.invoke("app:init"),

  newSession: (cwd) => ipcRenderer.invoke("session:new", cwd),
  loadSession: (id) => ipcRenderer.invoke("session:load", id),
  deleteSession: (id) => ipcRenderer.invoke("session:delete", id),
  send: (id, text) => ipcRenderer.invoke("session:send", { id, text }),
  stop: (id) => ipcRenderer.invoke("session:stop", id),

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
});
