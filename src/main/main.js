"use strict";
const path=require("path");
const QRCode=require("qrcode");
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
function treatmentList(){return Array.isArray(settings?.get("treatments"))?settings.get("treatments"):[];}
function treatmentById(id){return treatmentList().find(item=>String(item.id)===String(id))||null;}
function normalizeTreatment(item){return {id:String(item?.id||Date.now()),name:String(item?.name||"").trim(),filePath:String(item?.filePath||"").trim()};}
function displayConfig(){
  return {
    chainName:settings?.get("chainName")||"DR TAHER DENTAL CHAIN",
    displayTitle:settings?.get("displayTitle")||"Clinic Display",
    clinicDisplayName:settings?.get("clinicDisplayName")||"DR TAHER CLINIC",
    clinicName:settings?.get("clinicName")||"عيادة د. طاهر",
    homeEyebrow:settings?.get("homeEyebrow")||"DENTAL CHAIN",
    specialty:settings?.get("specialty")||"DDS, PhD • Endodontics",
    welcomeText:settings?.get("welcomeText")||"WELCOME",
    comfortText:settings?.get("comfortText")||"نتمنى لك جلسة مريحة"
  };
}

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

function showHome(clearPatient=false){server.send({type:"home",clearPatient:clearPatient===true},false);setDisplay({mode:"home",imageVisible:false});disableViewerKeys();}
function showBlack(){server.send({type:"black"},false);setDisplay({mode:"black",imageVisible:false});disableViewerKeys();}
function hide(){server.send({type:"hide"},false);setDisplay({imageVisible:false});disableViewerKeys();}


function decodeBase64UrlUtf8(value){
  try{
    let s=String(value||"").replace(/-/g,"+").replace(/_/g,"/");
    while(s.length%4)s+="=";
    return Buffer.from(s,"base64").toString("utf8");
  }catch{return""}
}
function findProtocolUrl(argv){
  return (argv||[]).find(v=>String(v).startsWith("dentalchair://"))||null;
}
function pad2(v){return String(v).padStart(2,"0")}
function localIcsDate(d){return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`}
function icsEscape(v){return String(v??"").replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;")}
function buildAppointmentVevent(data){
  if(/^BEGIN:VEVENT[\s\S]*END:VEVENT\s*$/i.test(String(data?.vevent||"").trim()))return String(data.vevent).trim();
  const [y,mo,d]=String(data?.date||"").split("-").map(Number);
  const [h,mi]=String(data?.time||"").split(":").map(Number);
  if(!y||!mo||!d)throw new Error("تاريخ الموعد غير صالح");
  const start=new Date(y,mo-1,d,h||0,mi||0,0);
  const clinic=String(data?.clinicName||settings?.get("clinicName")||"عيادة د. طاهر").trim();
  return [
    "BEGIN:VEVENT",
    `SUMMARY:${icsEscape(`موعدك غداً في ${clinic}`)}`,
    `DTSTART:${localIcsDate(start)}`,
    "DESCRIPTION:شكراً لثقتكم.",
    "END:VEVENT"
  ].join("\r\n");
}
async function showAppointmentQr(data){
  const payload=buildAppointmentVevent(data||{});
  const qrDataUrl=await QRCode.toDataURL(payload,{errorCorrectionLevel:"M",width:760,margin:4,color:{dark:"#082f49",light:"#ffffff"}});
  server.send({type:"appointment_qr",qrDataUrl,patientName:String(data?.patientName||""),date:String(data?.date||""),time:String(data?.time||""),clinicName:String(data?.clinicName||"عيادة د. طاهر"),reminderHours:24});
  setDisplay({mode:"appointment_qr",imageVisible:false});disableViewerKeys();notice("تم عرض QR الموعد على الشاشة","success");return true;
}
function sendPatientToDisplay(payload={}){
  const fullName=String(payload.fullName||payload.displayName||"ضيفنا الكريم").trim();
  const displayName=String(payload.firstName||payload.displayName||fullName.split(/\s+/)[0]||"ضيفنا الكريم").trim();
  const gender=String(payload.gender||"male").toLowerCase()==="female"?"female":"male";
  const honorific=gender==="female"?"سيدة":"سيد";
  const doctorName=String(payload.doctorName||"").trim();
  const clinicName=String(payload.clinicName||settings?.get("clinicName")||"عيادة د. طاهر").trim();
  server?.send({type:"patient",displayName,fullName,gender,honorific,doctorName,clinicName,...displayConfig()});
  setDisplay({mode:"home",imageVisible:false});disableViewerKeys();notice(`تم إرسال الترحيب: ${honorific} ${displayName}`,"success");
  return true;
}
async function handleCommand(payload){
  if(payload?.action==="show_patient")return sendPatientToDisplay(payload);
  if(payload?.action==="show_appointment_qr")return await showAppointmentQr(payload);
  return false;
}
function handleProtocolUrl(raw){
  try{
    const url=new URL(String(raw||""));if(url.protocol!=="dentalchair:")return false;
    const payload=JSON.parse(decodeBase64UrlUtf8(url.searchParams.get("data")||"")||"{}");
    handleCommand(payload).catch(e=>notice(`تعذر تنفيذ الأمر: ${e.message}`,"error"));
    return ["show_patient","show_appointment_qr"].includes(payload?.action);
  }catch(e){notice(`تعذر قراءة أمر شاشة الكرسي: ${e.message}`,"error")}
  return false;
}

function safeRegister(accelerator,handler){
  try{
    globalShortcut.unregister(accelerator);
    globalShortcut.register(accelerator,()=>{
      try{handler();}catch(error){notice(`تعذر تنفيذ الاختصار: ${error.message}`,"error");}
    });
  }catch{}
}
function enableViewerKeys(){
  disableViewerKeys();
  const moves=[
    ["CommandOrControl+Left",()=>server.send({type:"transform",dx:-70,dy:0},false)],
    ["CommandOrControl+Right",()=>server.send({type:"transform",dx:70,dy:0},false)],
    ["CommandOrControl+Up",()=>server.send({type:"transform",dx:0,dy:-70},false)],
    ["CommandOrControl+Down",()=>server.send({type:"transform",dx:0,dy:70},false)],
    ["CommandOrControl+=",()=>server.send({type:"transform",zoom:0.15},false)],
    ["CommandOrControl+-",()=>server.send({type:"transform",zoom:-0.15},false)],
    ["CommandOrControl+0",()=>server.send({type:"reset_view"},false)],
    ["CommandOrControl+Shift+8",()=>server.send({type:"transform",rotate:20},false)],
    ["CommandOrControl+PageUp",()=>showImageItem(images.previous())],
    ["CommandOrControl+PageDown",()=>showImageItem(images.next())],
    ["CommandOrControl+Escape",hide]
  ];
  moves.forEach(([key,handler])=>safeRegister(key,handler));
}
function disableViewerKeys(){
  [
    "CommandOrControl+Left","CommandOrControl+Right","CommandOrControl+Up","CommandOrControl+Down",
    "CommandOrControl+=","CommandOrControl+-","CommandOrControl+0","CommandOrControl+Shift+8",
    "CommandOrControl+PageUp","CommandOrControl+PageDown","CommandOrControl+Escape"
  ].forEach(key=>{try{globalShortcut.unregister(key);}catch{}});
}
function registerGlobalKeys(){
  globalShortcut.unregisterAll();
  safeRegister("CommandOrControl+`",()=>showImageItem(images.latest()));
  safeRegister("CommandOrControl+H",showHome);
  safeRegister("CommandOrControl+B",showBlack);
  safeRegister("CommandOrControl+I",()=>chooseFile([{name:"Images",extensions:["png","jpg","jpeg","bmp","webp","tif","tiff"]}],"image",true));
  safeRegister("CommandOrControl+G",()=>{if(win){win.show();win.focus();win.webContents.send("ui:open-treatments");}});
  safeRegister("CommandOrControl+V",()=>chooseFile([{name:"Video",extensions:["mp4","webm","mkv"]}],"video",false));
  safeRegister("CommandOrControl+P",()=>chooseFile([{name:"PDF",extensions:["pdf"]}],"pdf",false));
  safeRegister("CommandOrControl+L",()=>server.send({type:"game"},false));
  safeRegister("CommandOrControl+Escape",hide);
}

function createWindow(){
  win=new BrowserWindow({
    width:980,height:860,minWidth:820,minHeight:720,
    show:!settings.get("startMinimized"),
    backgroundColor:"#071727",
    webPreferences:{preload:path.join(__dirname,"preload.js"),contextIsolation:true,nodeIntegration:false}
  });
  win.loadFile(path.join(__dirname,"..","renderer","index.html"));
  win.on("close",e=>{if(!quitting){e.preventDefault();win.hide();}});
  win.webContents.on("did-finish-load",emit);
}

function createTray(){
  const iconPath=path.join(__dirname,"..","..","assets","app-icon.png");
  let trayImage=nativeImage.createFromPath(iconPath);
  if(!trayImage.isEmpty())trayImage=trayImage.resize({width:20,height:20});
  tray=new Tray(trayImage.isEmpty()?nativeImage.createEmpty():trayImage);
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
    return sendPatientToDisplay(p||{});
  });
  ipcMain.handle("display:home",()=>showHome(false));
  ipcMain.handle("display:end",()=>showHome(true));
  ipcMain.handle("display:black",showBlack);
  ipcMain.handle("display:hide",hide);
  ipcMain.handle("display:transform",(_e,p)=>server.send({type:"transform",...p},false));
  ipcMain.handle("display:reset",()=>server.send({type:"reset_view"},false));
  ipcMain.handle("display:rotate",()=>server.send({type:"transform",rotate:20},false));
  
  ipcMain.handle("treatments:choose-gif",async()=>{
    const result=await dialog.showOpenDialog(win,{
      title:"اختر GIF المعالجة",
      properties:["openFile"],
      filters:[{name:"Animated Media",extensions:["gif","webp"]}]
    });
    return result.canceled?"":(result.filePaths[0]||"");
  });
  ipcMain.handle("treatments:save",(_e,item)=>{
    const normalized=normalizeTreatment(item);
    if(!normalized.name||!normalized.filePath){
      throw new Error("اسم المعالجة وملف GIF مطلوبان");
    }
    const list=treatmentList();
    const index=list.findIndex(x=>String(x.id)===normalized.id);
    if(index>=0)list[index]=normalized;else list.push(normalized);
    settings.patch({treatments:list});
    state.settings=settings.all();
    emit();
    return normalized;
  });
  ipcMain.handle("treatments:delete",(_e,id)=>{
    const list=treatmentList().filter(x=>String(x.id)!==String(id));
    settings.patch({treatments:list});
    state.settings=settings.all();
    emit();
    return true;
  });
  ipcMain.handle("treatments:play",(_e,id)=>{
    const item=treatmentById(id);
    if(!item)return false;
    const url=server.registerMedia(item.filePath,false);
    server.send({
      type:"treatment_gif",
      id:item.id,
      name:item.name,
      url
    });
    setDisplay({mode:"treatment_gif",imageVisible:false});
    disableViewerKeys();
    return true;
  });
    ipcMain.handle("appointment:show-qr",async(_e,data)=>{
    return await showAppointmentQr(data||{});
  });

  ipcMain.handle("display:game",()=>{
    server.send({type:"game"},false);
    setDisplay({mode:"game",imageVisible:false});
    disableViewerKeys();
    return true;
  });

  ipcMain.handle("display:theme",(_e,theme)=>{
    const normalized=["light","dark","auto"].includes(String(theme))?String(theme):"dark";
    settings.patch({displayTheme:normalized});
    state.settings=settings.all();
    server.send({type:"theme",theme:normalized},false);
    emit();
    notice(`تم تطبيق مظهر الشاشة: ${normalized}`,"success");
    return state;
  });
  ipcMain.handle("settings:save",(_e,p)=>{
    settings.patch(p||{});state.settings=settings.all();
    if(discovery)discovery.clinicName=settings.get("clinicName");
    server.send({type:"display_config",...displayConfig()},false);
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
    if(win&&!url){win.show();win.focus();}
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
    onState:s=>{state.network=s;emit();},onNotice:notice,
    getHelloPayload:displayConfig,onCommand:handleCommand
  });
  discovery=new DiscoveryBroadcaster({
    port:settings.get("discoveryPort"),wsPort:settings.get("wsPort"),clinicName:settings.get("clinicName"),onNotice:notice
  });
  ipc();createWindow();createTray();
  try{
    await server.start();
  }catch(error){
    if(error?.code==="EADDRINUSE"){
      dialog.showMessageBoxSync({
        type:"info",
        title:"Dental Chain Chair Controller",
        message:"وحدة التحكم تعمل بالفعل",
        detail:"تم العثور على نسخة أخرى تعمل في الخلفية. افتحها من الأيقونة بجانب الساعة."
      });
      quitting=true;
      app.quit();
      return;
    }
    throw error;
  }
  discovery.start();
  images.watch(settings.get("sensorFolder")).catch(error=>notice(`تعذر فهرسة الصور: ${error.message}`,"warning"));
  registerGlobalKeys();
  server.send({type:"theme",theme:settings.get("displayTheme")||"dark"},false);
  if(pendingProtocolUrl){handleProtocolUrl(pendingProtocolUrl);pendingProtocolUrl=null;}
  app.setLoginItemSettings({openAtLogin:Boolean(settings.get("launchAtLogin"))});
  emit();
});
app.on("before-quit",()=>{quitting=true;discovery?.stop();globalShortcut.unregisterAll();});
app.on("window-all-closed",()=>{});
