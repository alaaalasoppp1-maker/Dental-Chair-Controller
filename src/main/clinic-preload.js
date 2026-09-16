'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('DCOSController',Object.freeze({
  openExternal:url=>ipcRenderer.invoke('clinic:external',url),
  session:payload=>ipcRenderer.invoke('clinic:session',payload),
  chairCommand:payload=>ipcRenderer.invoke('clinic:command',payload),
  clinicalEvents:query=>ipcRenderer.invoke('clinic:events',query),
  alert:message=>ipcRenderer.sendSync('clinic:alert',message),
  confirm:message=>ipcRenderer.sendSync('clinic:confirm',message),
  prompt:(message,value)=>ipcRenderer.sendSync('clinic:prompt',message,value),
  close:()=>ipcRenderer.invoke('clinic-pane:toggle',false)
}));
let start=null;
window.addEventListener('pointerdown',event=>{start={x:event.clientX,y:event.clientY};},true);
window.addEventListener('pointerup',event=>{if(start&&start.x<35&&event.clientX-start.x>110&&Math.abs(event.clientY-start.y)<70)void ipcRenderer.invoke('clinic-pane:toggle',false);start=null;},true);
window.addEventListener('pagehide',()=>{void ipcRenderer.invoke('clinic:session',null);});
