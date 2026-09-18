'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('DCOSController',Object.freeze({
  health:()=>ipcRenderer.invoke('clinic:health'),
  openExternal:url=>ipcRenderer.invoke('clinic:external',url),
  session:payload=>ipcRenderer.invoke('clinic:session',payload),
  queueAllCloudArchive:()=>ipcRenderer.invoke('clinic:cloud-queue-all'),
  migrateLegacyArchiveIdentities:()=>ipcRenderer.invoke('clinic:cloud-migrate-identities'),
  googleStatus:()=>ipcRenderer.invoke('clinic:google-status'),
  googleConnect:()=>ipcRenderer.invoke('clinic:google-connect'),
  googleDisconnect:()=>ipcRenderer.invoke('clinic:google-disconnect'),
  googleTestDrive:()=>ipcRenderer.invoke('clinic:google-test-drive'),
  googleTestPeople:()=>ipcRenderer.invoke('clinic:google-test-people'),
  googleTestUpload:()=>ipcRenderer.invoke('clinic:google-test-upload'),
  googleContactsEnable:enabled=>ipcRenderer.invoke('clinic:google-contacts-enable',enabled===true),
  googleContactsQueueClinic:clinicId=>ipcRenderer.invoke('clinic:google-contacts-queue-clinic',clinicId),
  googleContactsQueuePatient:patient=>ipcRenderer.invoke('clinic:google-contacts-queue-patient',patient),
  googleContactsReport:clinicId=>ipcRenderer.invoke('clinic:google-contacts-report',clinicId),
  googleUploadBytes:(spec,bytes)=>ipcRenderer.invoke('clinic:google-upload-bytes',{spec,bytes}),
  googleListMedia:payload=>ipcRenderer.invoke('clinic:google-list-media',payload),
  googleDownloadMedia:fileId=>ipcRenderer.invoke('clinic:google-download-media',fileId),
  cloudQueueSummary:()=>ipcRenderer.invoke('clinic:cloud-queue-summary'),
  chairCommand:payload=>ipcRenderer.invoke('clinic:command',payload),
  clinicalEvents:query=>ipcRenderer.invoke('clinic:events',query),
  alert:message=>ipcRenderer.sendSync('clinic:alert',message),
  confirm:message=>ipcRenderer.sendSync('clinic:confirm',message),
  prompt:(message,value)=>ipcRenderer.sendSync('clinic:prompt',message,value),
  close:()=>ipcRenderer.invoke('clinic-pane:toggle',false)
}));
// Older hosted pages still fetch loopback URLs. Route only our three endpoints
// through the same sender-validated IPC bridge, before page scripts start.
contextBridge.executeInMainWorld({func:()=>{
  const originalFetch=window.fetch.bind(window),bridge=window.DCOSController;
  window.fetch=async(input,init)=>{
    let url;try{url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href);}catch{return originalFetch(input,init);}
    if(url.origin!=='http://127.0.0.1:8765'||!['/health','/command','/clinical/events'].includes(url.pathname))return originalFetch(input,init);
    const request=new Request(input,init);
    const abort=()=>new DOMException('The operation was aborted.','AbortError');
    if(request.signal.aborted)throw abort();
    let operation;
    if(url.pathname==='/health'&&request.method==='GET')operation=()=>bridge.health();
    else if(url.pathname==='/command'&&request.method==='POST')operation=async()=>bridge.chairCommand(JSON.parse(await request.text()));
    else if(url.pathname==='/clinical/events'&&request.method==='GET')operation=()=>bridge.clinicalEvents(Object.fromEntries(url.searchParams));
    else return new Response(JSON.stringify({ok:false,error:'method_not_allowed'}),{status:405,headers:{'Content-Type':'application/json'}});
    return new Promise((resolve,reject)=>{
      const onAbort=()=>reject(abort());request.signal.addEventListener('abort',onAbort,{once:true});
      Promise.resolve().then(()=>{if(request.signal.aborted)throw abort();return operation();}).then(result=>{
        if(request.signal.aborted)throw abort();
        resolve(new Response(JSON.stringify(result),{status:result?.ok===false?400:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}));
      }).catch(reject).finally(()=>request.signal.removeEventListener('abort',onAbort));
    });
  };
  window.alert=m=>bridge.alert(String(m));window.confirm=m=>bridge.confirm(String(m));window.prompt=(m,d='')=>bridge.prompt(String(m),String(d));
}});
window.addEventListener('pagehide',()=>{void ipcRenderer.invoke('clinic:session',null);});
