'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {WebContentsView,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const {clinicURL,ownPage,externalURL}=require('./clinic-pane-policy');
const {version:controllerVersion}=require('../../package.json');
const edgeSwipeSource=fs.readFileSync(path.join(__dirname,'../shared/edge-swipe.js'),'utf8');
class ClinicPane {
  constructor({window,url,google=null,cloudQueue=null,onToggle=()=>{},onSession=()=>{},onCloudQueueAll=async()=>({queued:0}),onCommand=()=>{},onEvents=()=>{}}){
    this.window=window;this.url=clinicURL(url);this.origin=new URL(this.url).origin;this.onToggle=onToggle;this.onSession=onSession;this.open=false;this.pendingPrompt=null;
    this.onCommand=onCommand;this.onEvents=onEvents;this.onCloudQueueAll=onCloudQueueAll;this.google=google;this.cloudQueue=cloudQueue;this.bridgeReady=false;
    this.view=new WebContentsView({webPreferences:{preload:path.join(__dirname,'clinic-preload.js'),partition:'persist:dtdc-clinic',contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    this.view.setBackgroundColor('#f4f8fc');
    const wc=this.view.webContents;
    wc.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    wc.setWindowOpenHandler(({url})=>{this.external(url).catch(()=>{});return {action:'deny'};});
    wc.on('will-navigate',(event,url)=>{if(!ownPage(url,this.origin)){event.preventDefault();this.external(url).catch(()=>{});}});
    wc.on('will-redirect',(event,url)=>{if(!ownPage(url,this.origin)){event.preventDefault();this.external(url).catch(()=>{});}});
    wc.on('did-start-navigation',(_event,_url,isInPlace,isMainFrame)=>{if(isMainFrame){this.onSession(null);if(!isInPlace)this.bridgeReady=false;}});
    wc.on('did-fail-load',(_event,code)=>{if(code!==-3)this.emit('تعذر تحميل موقع العيادة. تحقق من الإنترنت ثم أعد التحميل.');});
    wc.on('preload-error',()=>this.emit('تعذر تجهيز الربط الداخلي. أغلق الكونترولر بالكامل ثم شغّل النسخة المحدّثة.'));
    wc.on('did-finish-load',()=>{if(ownPage(wc.getURL(),this.origin)){
      wc.executeJavaScript(edgeSwipeSource+"\nwindow.__dtdcRemoveSwipe?.();window.__dtdcRemoveSwipe=window.DTDCEdgeSwipe.install({window,edge:'left',onSwipe:()=>window.DCOSController.close()});window.DCOSController.health();").then(result=>{this.bridgeReady=!!result?.ok;this.emit(this.bridgeReady?'':'تعذر تجهيز الربط الداخلي. أعد تشغيل الكونترولر.');}).catch(()=>this.emit('تعذر تجهيز الربط الداخلي. أعد تشغيل الكونترولر بعد تثبيت التحديث.'));
    }});
    wc.on('before-input-event',(event,input)=>{
      if(input.type!=='keyDown')return;
      if(input.key==='Escape'&&(input.control||input.meta)){event.preventDefault();this.show(false);}
      if((input.control||input.meta)&&!input.alt&&!input.shift&&input.key.toLowerCase()==='p'){event.preventDefault();void this.print();}
      if((input.control||input.meta)&&!input.alt&&!input.shift&&input.key.toLowerCase()==='s'){event.preventDefault();void wc.executeJavaScript("(async()=>{if(typeof window.saveAll==='function'){await window.saveAll();return true}return false})()").then(saved=>{if(!saved)return this.savePage();}).catch(()=>this.emit('تعذر إتمام الحفظ. راجع حالة المزامنة داخل البرنامج.'));}
    });
    window.on('resize',()=>this.bounds());window.on('closed',()=>this.close());
    this.installIPC();
  }
  valid(event){return event.sender===this.view.webContents&&event.senderFrame===this.view.webContents.mainFrame&&ownPage(event.senderFrame?.url||'',this.origin);}
  emit(message){if(!this.window.isDestroyed())this.window.webContents.send('clinic-pane:state',{open:this.open,url:this.url,message:message||(this.bridgeReady?`متصل داخلياً · ${controllerVersion}`:'')});}
  bounds(){if(!this.open)return;const [width,height]=this.window.getContentSize();this.view.setBounds({x:0,y:58,width,height:Math.max(0,height-58)});}
  show(open=true){
    if(open===this.open)return;this.open=open;
    if(open){this.window.contentView.addChildView(this.view);this.bounds();if(!this.view.webContents.getURL())this.view.webContents.loadURL(this.url).catch(()=>{});this.view.webContents.focus();}
    else{this.window.contentView.removeChildView(this.view);this.window.webContents.focus();}
    this.onToggle(open);this.emit('');
  }
  async external(url){return shell.openExternal(externalURL(url));}
  async print(){if(ownPage(this.view.webContents.getURL(),this.origin))this.view.webContents.print({printBackground:true},()=>{});}
  async savePage(){const choice=await dialog.showSaveDialog(this.window,{title:'حفظ الصفحة',defaultPath:'clinic-page.html',filters:[{name:'HTML',extensions:['html']}]});if(!choice.canceled&&choice.filePath)await this.view.webContents.savePage(choice.filePath,'HTMLComplete');}
  installIPC(){
    ipcMain.handle('clinic:health',event=>{if(!this.valid(event))throw new Error('sender_denied');return {ok:true,product:'DentalChairController',protocol:5,controllerVersion,transport:'embedded'};});
    ipcMain.handle('clinic:command',async(event,payload)=>{
      if(!this.valid(event)||!['select_patient','show_patient','clear_patient','open_plan_details','show_appointment_qr'].includes(payload?.action)||JSON.stringify(payload).length>1000000)throw new Error('command_denied');
      try{return await this.onCommand(payload)?{ok:true}:{ok:false,error:'unsupported_command'};}catch(error){return {ok:false,error:String(error?.message||'command_failed')};}
    });
    ipcMain.handle('clinic:events',(event,query)=>{if(!this.valid(event)||!query||JSON.stringify(query).length>3000)throw new Error('events_denied');try{return this.onEvents(query);}catch(error){return {ok:false,error:String(error?.message||'events_failed')};}});
    ipcMain.handle('clinic-pane:toggle',(event,open)=>{if(event.sender!==this.window.webContents&&!this.valid(event))throw new Error('sender_denied');this.show(typeof open==='boolean'?open:!this.open);});
    ipcMain.handle('clinic-pane:action',(event,action)=>{
      if(event.sender!==this.window.webContents)throw new Error('sender_denied');const wc=this.view.webContents;
      if(action==='reload')wc.reload();else if(action==='back'&&wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();else if(action==='forward'&&wc.navigationHistory.canGoForward())wc.navigationHistory.goForward();else if(action==='print')return this.print();else if(action==='save')return this.savePage();else if(action==='external')return this.external(this.url);
    });
    ipcMain.handle('clinic:external',(event,url)=>{if(!this.valid(event))throw new Error('sender_denied');return this.external(url);});
    ipcMain.handle('clinic:session',(event,payload)=>{if(!this.valid(event))throw new Error('sender_denied');this.onSession(payload);return true;});
    ipcMain.handle('clinic:cloud-queue-all',event=>{if(!this.valid(event))throw new Error('sender_denied');return this.onCloudQueueAll();});
    ipcMain.handle('clinic:google-status',event=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return {...this.google.status(),uploadQueue:this.cloudQueue?.summary(this.google.session?.clinicId||'')?.count||0};});
    ipcMain.handle('clinic:google-connect',event=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return this.google.connect();});
    ipcMain.handle('clinic:google-disconnect',event=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return this.google.disconnect();});
    ipcMain.handle('clinic:google-test-drive',event=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return this.google.testDrive();});
    ipcMain.handle('clinic:google-test-people',event=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return this.google.testPeople();});
    ipcMain.handle('clinic:google-test-upload',event=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return this.google.testUpload();});
    ipcMain.handle('clinic:google-contacts-enable',(event,enabled)=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return this.google.setContactsEnabled(enabled===true);});
    ipcMain.handle('clinic:google-contacts-queue-clinic',(event,clinicId)=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return this.google.queueClinic(String(clinicId||''));});
    ipcMain.handle('clinic:google-contacts-queue-patient',(event,patient)=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return this.google.queuePatient(patient||{});});
    ipcMain.handle('clinic:google-contacts-report',(event,clinicId)=>{if(!this.valid(event)||!this.google)throw new Error('sender_denied');return this.google.contactReport(String(clinicId||''));});
    ipcMain.handle('clinic:google-upload-bytes',(event,payload)=>{if(!this.valid(event)||!this.cloudQueue||!payload?.spec||!payload?.bytes)throw new Error('sender_denied');return this.cloudQueue.enqueueBytes(Buffer.from(payload.bytes),payload.spec);});
    ipcMain.handle('clinic:google-list-media',(event,payload)=>{if(!this.valid(event)||!this.google||!payload?.clinicId||!payload?.patientId)throw new Error('sender_denied');return this.google.listMedia(String(payload.clinicId),String(payload.patientId));});
    ipcMain.handle('clinic:google-download-media',async(event,fileId)=>{if(!this.valid(event)||!this.google||!fileId)throw new Error('sender_denied');const b=await this.google.downloadFile(String(fileId));return b;});
    ipcMain.handle('clinic:cloud-queue-summary',event=>{if(!this.valid(event)||!this.cloudQueue)throw new Error('sender_denied');return this.cloudQueue.summary(this.google?.session?.clinicId||'');});
    ipcMain.on('clinic:alert',(event,message)=>{if(!this.valid(event)){event.returnValue=null;return;}dialog.showMessageBoxSync(this.window,{type:'info',title:'العيادة',message:String(message).slice(0,10000),buttons:['حسناً']});event.returnValue=null;});
    ipcMain.on('clinic:confirm',(event,message)=>{if(!this.valid(event)){event.returnValue=false;return;}event.returnValue=dialog.showMessageBoxSync(this.window,{type:'question',title:'تأكيد',message:String(message).slice(0,10000),buttons:['نعم','لا'],defaultId:1,cancelId:1})===0;});
    ipcMain.on('clinic:prompt',(event,message,value)=>{
      if(!this.valid(event)||this.pendingPrompt){event.returnValue=null;return;}
      const child=new BrowserWindow({parent:this.window,modal:true,width:520,height:270,resizable:false,show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'prompt-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
      this.pendingPrompt=child;let answered=false;
      const finish=value=>{if(answered)return;answered=true;try{event.returnValue=value;}catch{}this.pendingPrompt=null;ipcMain.removeListener('clinic-prompt:answer',answer);if(!child.isDestroyed())child.close();};
      const answer=(e,text)=>{if(e.sender===child.webContents)finish(text===null?null:String(text).slice(0,10000));};
      ipcMain.on('clinic-prompt:answer',answer);child.once('closed',()=>finish(null));
      child.webContents.once('did-finish-load',()=>{child.webContents.send('clinic-prompt:data',{message:String(message).slice(0,5000),value:String(value||'').slice(0,10000)});child.show();});
      child.loadFile(path.join(__dirname,'..','renderer','prompt.html'));
    });
  }
  close(){this.pendingPrompt?.close();this.onSession(null);if(!this.view.webContents.isDestroyed())this.view.webContents.close();}
}
module.exports={ClinicPane};
