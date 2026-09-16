'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const {planRequest,externalURL,clinicURL}=require('../src/main/clinic-pane-policy');
const sourceRequire=require('node:module').createRequire(path.join(__dirname,'../src/main/clinic-pane.js'));
test('plan routing requires exact clinic, patient, plan and chair session',()=>{
  const patient={selected:true,clinicId:'A',patientId:'same',sessionId:'s'},plans=[{planId:'plan',title:'Plan'}],payload={...patient,planId:'plan'};
  assert.equal(planRequest(payload,patient,plans).planId,'plan');for(const field of ['clinicId','patientId','sessionId','planId'])assert.throws(()=>planRequest({...payload,[field]:'other'},patient,plans));
  for(const url of ['file:///secret','javascript:alert(1)','https://u:p@example.invalid'])assert.throws(()=>externalURL(url));assert.throws(()=>clinicURL('http://clinic.invalid'));assert.equal(clinicURL('https://clinic.invalid'),'https://clinic.invalid/');
});
function paneFixture(){
  const handlers=new Map(),listeners=new Map(),opened=[],windows=[];
  class Contents extends EventEmitter{constructor(){super();this.mainFrame={url:'https://clinic.invalid/'};this.session={setPermissionRequestHandler:fn=>this.permission=fn};this.calls=[];this.navigationHistory={canGoBack:()=>true,canGoForward:()=>true,goBack:()=>{},goForward:()=>{}};}getURL(){return this.url||'';}loadURL(url){this.url=url;return Promise.resolve();}setWindowOpenHandler(fn){this.popup=fn;}focus(){}send(channel,data){this.calls.push([channel,data]);}executeJavaScript(js){this.calls.push(['execute',js]);return Promise.resolve(true);}print(){this.calls.push(['print']);}close(){this.dead=true;}isDestroyed(){return !!this.dead;}reload(){}savePage(){return Promise.resolve();}}
  class Window extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new Contents();this.contentView={addChildView:v=>this.child=v,removeChildView:()=>this.child=null};windows.push(this);}getContentSize(){return [980,860];}isDestroyed(){return !!this.dead;}loadFile(){return Promise.resolve();}show(){}close(){this.dead=true;this.emit('closed');}}
  class View{constructor(options){this.options=options;this.webContents=new Contents();}setBackgroundColor(){}setBounds(bounds){this.bounds=bounds;}}
  const electron={WebContentsView:View,BrowserWindow:Window,ipcMain:{handle:(k,fn)=>handlers.set(k,fn),on:(k,fn)=>listeners.set(k,fn),removeListener:k=>listeners.delete(k)},dialog:{showMessageBoxSync:()=>0,showSaveDialog:async()=>({canceled:true})},shell:{openExternal:async url=>opened.push(url)}};
  const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main/clinic-pane.js'),'utf8'),{module,exports:module.exports,__dirname:path.join(__dirname,'../src/main'),require:name=>name==='electron'?electron:sourceRequire(name),URL});
  const window=new Window(),sessions=[],commands=[],pane=new module.exports.ClinicPane({window,url:'https://clinic.invalid/',onSession:v=>sessions.push(v),onCommand:p=>{commands.push(p);return true;}}),wc=pane.view.webContents,event={sender:wc,senderFrame:wc.mainFrame};return {pane,wc,window,handlers,listeners,opened,windows,sessions,commands,event};
}
test('embedded browser isolates privileges, opens Google externally and rejects foreign frames',async()=>{
  const f=paneFixture();assert.equal(f.pane.view.options.webPreferences.nodeIntegration,false);assert.equal(f.pane.view.options.webPreferences.sandbox,true);f.pane.show(true);assert.equal(f.pane.view.bounds.height,802);assert.equal(f.window.child,f.pane.view);
  assert.equal(f.wc.popup({url:'https://accounts.google.com/o/oauth2/v2/auth'}).action,'deny');await Promise.resolve();assert.equal(f.opened.length,1);
  await assert.rejects(f.handlers.get('clinic:command')({sender:f.wc,senderFrame:{url:'https://clinic.invalid/'}},{action:'select_patient'}),/command_denied/);
  assert.equal((await f.handlers.get('clinic:command')(f.event,{action:'select_patient'})).ok,true);assert.equal(f.commands.length,1);
  f.pane.show(false);assert.equal(f.window.child,null);f.pane.close();assert.equal(f.wc.isDestroyed(),true);assert.equal(f.sessions.at(-1),null);
});
test('confirm/prompt return input; Ctrl+S/P work while Ctrl+Alt+P reaches the app',async()=>{
  const f=paneFixture();f.pane.show(true);f.listeners.get('clinic:confirm')(f.event,'sure');assert.equal(f.event.returnValue,true);
  f.listeners.get('clinic:prompt')(f.event,'name','initial');const child=f.windows.at(-1);child.webContents.emit('did-finish-load');f.listeners.get('clinic-prompt:answer')({sender:child.webContents},'entered');assert.equal(f.event.returnValue,'entered');assert.equal(child.dead,true);
  let prevented=0;const event={preventDefault:()=>prevented++};f.wc.emit('before-input-event',event,{type:'keyDown',key:'p',control:true,alt:true});assert.equal(prevented,0);
  f.wc.emit('before-input-event',event,{type:'keyDown',key:'p',control:true});f.wc.emit('before-input-event',event,{type:'keyDown',key:'s',control:true});await Promise.resolve();assert.equal(prevented,2);assert(f.wc.calls.some(x=>x[0]==='print'));assert(f.wc.calls.some(x=>x[0]==='execute'&&x[1].includes('await window.saveAll')));
});
test('health is independent of the patient archive; native failures retain their real reason',async()=>{
  const f=paneFixture();
  f.pane.onCommand=()=>{throw Error('يوجد أرشيف قديم مشابه دون هوية عيادة مؤكدة.');};
  const health=f.handlers.get('clinic:health')(f.event);assert.equal(health.product,'DentalChairController');assert.equal(health.ok,true);
  assert.throws(()=>f.handlers.get('clinic:health')({...f.event,senderFrame:{url:'https://clinic.invalid/'}}),/sender_denied/);
  const result=await f.handlers.get('clinic:command')(f.event,{action:'select_patient'});assert.equal(result.ok,false);assert.match(result.error,/أرشيف قديم/);
  f.pane.onEvents=()=>{throw Error('clinical_scope_mismatch');};assert.equal(f.handlers.get('clinic:events')(f.event,{clinicId:'A',patientId:'p'}).error,'clinical_scope_mismatch');
});
