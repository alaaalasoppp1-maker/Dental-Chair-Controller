'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('promptAPI',{onData:callback=>ipcRenderer.on('clinic-prompt:data',(_event,data)=>callback(data)),answer:value=>ipcRenderer.send('clinic-prompt:answer',value)});
