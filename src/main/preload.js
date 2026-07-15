const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("chairAPI", {
  chooseSensorFolder: () => ipcRenderer.invoke("settings:choose-sensor-folder"),
  saveSettings: (values) => ipcRenderer.invoke("settings:save", values),
  getState: () => ipcRenderer.invoke("state:get"),
  reindex: () => ipcRenderer.invoke("images:reindex"),
  showLatest: () => ipcRenderer.invoke("images:latest"),
  showPrevious: () => ipcRenderer.invoke("images:previous"),
  showNext: () => ipcRenderer.invoke("images:next"),
  hideImage: () => ipcRenderer.invoke("display:hide-image"),
  resetView: () => ipcRenderer.invoke("display:reset-view"),
  transform: (payload) => ipcRenderer.invoke("display:transform", payload),
  showMode: (mode) => ipcRenderer.invoke("display:mode", mode),
  showPatient: (payload) => ipcRenderer.invoke("display:patient", payload),
  endSession: () => ipcRenderer.invoke("display:end-session"),
  onState: (callback) => ipcRenderer.on("state:changed", (_event, state) => callback(state)),
  onNotice: (callback) => ipcRenderer.on("notice", (_event, notice) => callback(notice))
});
