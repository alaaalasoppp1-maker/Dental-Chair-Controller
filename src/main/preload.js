"use strict";
const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("chairAPI",{
  getState:()=>ipcRenderer.invoke("state:get"),
  chooseSensorFolder:()=>ipcRenderer.invoke("sensor:choose"),
  reindex:()=>ipcRenderer.invoke("sensor:reindex"),
  showLatest:()=>ipcRenderer.invoke("image:latest"),
  showPrevious:()=>ipcRenderer.invoke("image:previous"),
  showNext:()=>ipcRenderer.invoke("image:next"),
  chooseTemporaryImage:()=>ipcRenderer.invoke("media:temp-image"),
  chooseGif:()=>ipcRenderer.invoke("media:gif"),
  chooseVideo:()=>ipcRenderer.invoke("media:video"),
  choosePdf:()=>ipcRenderer.invoke("media:pdf"),
  showPatient:p=>ipcRenderer.invoke("display:patient",p),
  showHome:()=>ipcRenderer.invoke("display:home"),
  showBlack:()=>ipcRenderer.invoke("display:black"),
  hide:()=>ipcRenderer.invoke("display:hide"),
  transform:p=>ipcRenderer.invoke("display:transform",p),
  resetView:()=>ipcRenderer.invoke("display:reset"),
  setDisplayTheme:theme=>ipcRenderer.invoke("display:theme",theme),

  chooseTreatmentGif:()=>ipcRenderer.invoke("treatments:choose-gif"),
  saveTreatment:item=>ipcRenderer.invoke("treatments:save",item),
  deleteTreatment:id=>ipcRenderer.invoke("treatments:delete",id),
  playTreatment:id=>ipcRenderer.invoke("treatments:play",id),
  startGame:()=>ipcRenderer.invoke("display:game"),
  saveSettings:p=>ipcRenderer.invoke("settings:save",p),
  onState:cb=>ipcRenderer.on("state:changed",(_e,s)=>cb(s)),
  onNotice:cb=>ipcRenderer.on("notice",(_e,n)=>cb(n))
});
