"use strict";
const path=require("path");
const {
  app,BrowserWindow,dialog,globalShortcut,ipcMain,Tray,Menu,nativeImage
}=require("electron");
const {SettingsStore}=require("./settings-store");
const {ImageLibrary}=require("./image-library");
const {ChairServer}=require("./server");
const {DiscoveryBroadcaster}=require("./discovery");

let win,tray,settings,images,server,discovery,quitting=false;
let pendingProtocolUrl=null;
const state={settings:{},images:{},network:{},display:{mode:"home",imageVisible:false}};

function emit(){if(win&&!win.isDestroyed())win.webContents.send("state:changed",state);}
function notice(message,type="info"){if(win&&!win.isDestroyed())win.webContents.send("notice",{message,type,at:Date.now()});}
function setDisplay(patch){state.display={...state.display,...patch};emit();}

async function showImageItem(item,kind="image"){
  if(!item){notice("لا توجد صورة متاحة","error");return;}
  const url=server.registerMedia(item.path,true);
  server.send({type:"image",url,name:item.name,position:images.index+1,total:images.items.length,kind});
  setDisplay({mode:"image",imageVisible:true});
  enableViewerKeys();
}

function showFile(file,type,optimizeImage=false){
  if(!file)return;
  const url=server.registerMedia(file,optimizeImage);
  server.send({type,url,name:path.basename(file)});
  setDisplay({mode:type,imageVisible:type==="image"});
  if(type==="image")enableViewerKeys(); else disableViewerKeys();
}

function chooseFile(filters,type,optimizeImage=false){
  const r=dialog.showOpenDialogSync(win,{properties:["openFile"],filters});
  if(r?.[0])showFile(r[0],type,optimizeImage);
}

function showHome(){server.send({type:"home"},false);setDisplay({mode:"home",imageVisible:false});disableViewerKeys();}
function showBlack(){server.send({type:"black"},false);setDisplay({mode:"black",imageVisible:false});disableViewerKeys();}
function hide(){server.send({type:"hide"},false);setDisplay({imageVisible:false});disableViewerKeys();}

function enableViewerKeys(){
  disableViewerKeys();
  const map=[
    ["Escape",hide],["Left",()=>showImageItem(images.previous())],["Right",()=>showImageItem(images.next())],
    ["Up",()=>server.send({type:"transform",dx:0,dy:-70},false)],
    ["Down",()=>server.send({type:"transform",dx:0,dy:70},false)],
    ["+",()=>server.send({type:"transform",zoom:0.15},false)],
    ["-",()=>server.send({type:"transform",zoom:-0.15},false)],
    ["0",()=>server.send({type:"reset_view"},false)]
  ];
  for(const [k,fn] of map){try{globalShortcut.register(k,fn);}catch{}}
}
function disableViewerKeys(){
  for(const k of ["Escape","Left","Right","Up","Down","+","-","0"]){try{globalShortcut.unregister(k);}catch{}}
}


function decodeBase64UrlUtf8(value){
  try{
    let base64=String(value||"").replace(/-/g,"+").replace(/_/g,"/");
    while(base64.length%4)base64+="=";
    return Buffer.from(base64,"base64").toString("utf8");
  }catch{return ""}
}

function handleProtocolUrl(rawUrl){
  try{
    const url=new URL(String(rawUrl||""));
    if(url.protocol!=="dentalchair:")return false;
    const encoded=url.searchParams.get("data")||"";
    const decoded=decodeBase64UrlUtf8(encoded);
    const payload=JSON.parse(decoded||"{}");

    if(payload.action==="show_patient"){
      const displayName=String(payload.displayName||payload.fullName||"ضيفنا الكريم").trim();
      const doctorName=String(payload.doctorName||"").trim();
      server?.send({type:"patient",displayName,doctorName});
      setDisplay({mode:"patient",imageVisible:false});
      disableViewerKeys();
      notice(`تم إرسال المريض إلى الشاشة: ${displayName}`,"success");
      if(win){win.show();win.focus();}
      return true;
    }
  }catch(error){
    notice(`تعذر قراءة أمر شاشة الكرسي: ${error.message}`,"error");
  }
  return false;
}

function findProtocolUrl(argv){
  return (argv||[]).find(arg=>String(arg).startsWith("dentalchair://"))||null;
}

function registerGlobalKeys(){
  globalShortcut.unregisterAll();
  globalShortcut.register("CommandOrControl+`",()=>showImageItem(images.latest()));
  globalShortcut.register("F1",showHome);
  globalShortcut.register("F2",()=>server.send({type:"services"},false));
  globalShortcut.register("F4",()=>chooseFile([{name:"Images",extensions:["png","jpg","jpeg","bmp","webp","tif","tiff"]}],"image",true));
  globalShortcut.register("F5",showBlack);
}

function createWindow(){
  win=new BrowserWindow({
    width:980,height:860,minWidth:820,minHeight:720,
    show:!settings.get("startMinimized"),
    backgroundColor:"#eef7fb",
    webPreferences:{preload:path.join(__dirname,"preload.js"),contextIsolation:true,nodeIntegration:false}
  });
  win.loadFile(path.join(__dirname,"..","renderer","index.html"));
  win.on("close",e=>{if(!quitting){e.preventDefault();win.hide();}});
  win.webContents.on("did-finish-load",emit);
}

function createTray(){
  tray=new Tray(nativeImage.createEmpty());
  tray.setToolTip("Dental Chain Chair Controller");
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:"فتح",click:()=>{win.show();win.focus();}},
    {label:"أحدث صورة",click:()=>showImageItem(images.latest())},
    {label:"ترحيب",click:showHome},
    {label:"شاشة سوداء",click:showBlack},
    {type:"separator"},
    {label:"خروج",click:()=>{quitting=true;app.quit();}}
  ]));
}

function ipc(){
  ipcMain.handle("state:get",()=>state);
  ipcMain.handle("sensor:choose",async()=>{
    const r=await dialog.showOpenDialog(win,{properties:["openDirectory"],defaultPath:settings.get("sensorFolder")});
    if(!r.canceled&&r.filePaths[0]){
      settings.patch({sensorFolder:r.filePaths[0]});state.settings=settings.all();
      await images.watch(r.filePaths[0]);emit();
    }
    return state;
  });
  ipcMain.handle("sensor:reindex",()=>images.scan(settings.get("sensorFolder")));
  ipcMain.handle("image:latest",()=>showImageItem(images.latest()));
  ipcMain.handle("image:previous",()=>showImageItem(images.previous()));
  ipcMain.handle("image:next",()=>showImageItem(images.next()));
  ipcMain.handle("media:temp-image",()=>chooseFile([{name:"Images",extensions:["png","jpg","jpeg","bmp","webp","tif","tiff"]}],"image",true));
  ipcMain.handle("media:gif",()=>chooseFile([{name:"GIF",extensions:["gif","webp"]}],"gif",false));
  ipcMain.handle("media:video",()=>chooseFile([{name:"Video",extensions:["mp4","webm","mkv"]}],"video",false));
  ipcMain.handle("media:pdf",()=>chooseFile([{name:"PDF",extensions:["pdf"]}],"pdf",false));
  ipcMain.handle("display:patient",(_e,p)=>{
    server.send({type:"patient",displayName:String(p?.displayName||"").trim()||"ضيفنا الكريم",doctorName:String(p?.doctorName||"").trim()});
    setDisplay({mode:"patient",imageVisible:false});disableViewerKeys();
  });
  ipcMain.handle("display:home",showHome);
  ipcMain.handle("display:black",showBlack);
  ipcMain.handle("display:hide",hide);
  ipcMain.handle("display:transform",(_e,p)=>server.send({type:"transform",...p},false));
  ipcMain.handle("display:reset",()=>server.send({type:"reset_view"},false));
  ipcMain.handle("settings:save",(_e,p)=>{
    settings.patch(p||{});state.settings=settings.all();
    app.setLoginItemSettings({openAtLogin:Boolean(settings.get("launchAtLogin"))});emit();return state;
  });
}


const gotSingleInstanceLock=app.requestSingleInstanceLock();
if(!gotSingleInstanceLock){
  app.quit();
}else{
  app.on("second-instance",(_event,argv)=>{
    const url=findProtocolUrl(argv);
    if(url){
      if(server)handleProtocolUrl(url);
      else pendingProtocolUrl=url;
    }
    if(win){win.show();win.focus();}
  });
}

if(process.defaultApp){
  if(process.argv.length>=2){
    app.setAsDefaultProtocolClient("dentalchair",process.execPath,[path.resolve(process.argv[1])]);
  }
}else{
  app.setAsDefaultProtocolClient("dentalchair");
}

app.on("open-url",(event,url)=>{
  event.preventDefault();
  if(server)handleProtocolUrl(url);
  else pendingProtocolUrl=url;
});

pendingProtocolUrl=findProtocolUrl(process.argv);

app.whenReady().then(async()=>{
  settings=new SettingsStore(app);state.settings=settings.all();
  images=new ImageLibrary({onState:s=>{state.images=s;emit();},onNotice:notice});
  server=new ChairServer({
    port:settings.get("wsPort"),maxWidth:settings.get("mediaMaxWidth"),maxHeight:settings.get("mediaMaxHeight"),
    onState:s=>{state.network=s;emit();},onNotice:notice
  });
  discovery=new DiscoveryBroadcaster({
    port:settings.get("discoveryPort"),wsPort:settings.get("wsPort"),clinicName:settings.get("clinicName"),onNotice:notice
  });
  ipc();createWindow();createTray();
  await server.start();discovery.start();await images.watch(settings.get("sensorFolder"));
  registerGlobalKeys();
  if(pendingProtocolUrl){handleProtocolUrl(pendingProtocolUrl);pendingProtocolUrl=null;}
  app.setLoginItemSettings({openAtLogin:Boolean(settings.get("launchAtLogin"))});
  emit();
});
app.on("before-quit",()=>{quitting=true;discovery?.stop();globalShortcut.unregisterAll();});
app.on("window-all-closed",()=>{});
