"use strict";

const fs=require("fs");
const path=require("path");
let mime;
try{mime=require("mime-types")}catch{mime={lookup(file){const ext=path.extname(String(file||"")).toLowerCase();return ext===".png"?"image/png":[".jpg",".jpeg"].includes(ext)?"image/jpeg":ext===".webp"?"image/webp":"application/octet-stream"}}}
const crypto=require("crypto");

const IMAGE_EXTENSIONS=new Set([".png",".jpg",".jpeg",".bmp",".webp",".tif",".tiff"]);
const FOLDERS=["Panorama","Sensor","Before","After","Intraoral","Photos","Other","TreatmentPlans","AssistantSessions"];
const FOLDER_ALIASES={
  Panorama:["01 - صور بانوراما","Panorama"],
  Sensor:["02 - صور أشعة وسينسور","Sensor"],
  Before:["03 - صور قبل العلاج","Before"],
  After:["04 - صور بعد العلاج","After"],
  Intraoral:["05 - صور داخل الفم","Intraoral"],
  Photos:["06 - صور فوتوغرافية","Photos"],
  Other:["07 - صور أخرى","Other"],
  TreatmentPlans:["TreatmentPlans","08 - خطط العلاج"],
  AssistantSessions:["09 - جلسات المساعد","AssistantSessions"]
};

function safePart(value,fallback="patient"){
  const cleaned=String(value||"").normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g," ").replace(/\s+/g," ").trim().replace(/[. ]+$/g,"");
  return(cleaned||fallback).slice(0,90);
}
function matchPart(value){return String(value||"").normalize("NFKC").toLocaleLowerCase().replace(/[\s_\-–—]+/g," ").trim();}
function sameValue(a,b){return Boolean(a&&b&&matchPart(a)===matchPart(b));}
function insideRoot(root,candidate){const relative=path.relative(path.resolve(root),path.resolve(candidate));return relative===""||(!relative.startsWith("..")&&!path.isAbsolute(relative));}
function readPatientManifest(dir){
  for(const name of ["_patient.json",".dtdc-patient.json","patient.json"]){
    const file=path.join(dir,name);if(!fs.existsSync(file))continue;
    try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{}
  }
  return null;
}
function patientDirectories(root){
  try{return fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>path.join(root,entry.name));}catch{return[];}
}
function explicitPatientDirectory(root,payload){
  const values=[payload.patientDir,payload.patientPath,payload.archivePatientPath,payload.patientFolderPath,payload.folderPath,payload.patientFolder].filter(Boolean);
  for(const value of values){const candidate=path.isAbsolute(String(value))?String(value):path.join(root,String(value));if(insideRoot(root,candidate)&&fs.existsSync(candidate)&&fs.statSync(candidate).isDirectory())return candidate;}
  return"";
}
function resolvePatientDirectory(root,payload,identity){
  const explicit=explicitPatientDirectory(root,payload);if(explicit)return{patientDir:explicit,manifest:readPatientManifest(explicit)};
  const dirs=patientDirectories(root),scored=[];
  for(const dir of dirs){
    const manifest=readPatientManifest(dir);if(!manifest)continue;
    const manifestId=String(manifest.patientId||manifest.id||""),manifestFileNo=String(manifest.fileNo||manifest.fileNumber||""),manifestName=String(manifest.fullName||manifest.name||"");let score=0;
    if(identity.fileNo&&sameValue(identity.fileNo,manifestFileNo))score+=120;
    if(identity.patientId&&sameValue(identity.patientId,manifestId))score+=100;
    if(identity.fullName&&sameValue(identity.fullName,manifestName))score+=30;
    if(score>=100)scored.push({patientDir:dir,manifest,score});
  }
  if(scored.length){scored.sort((a,b)=>b.score-a.score);return scored[0];}

  const exactNames=[];
  if(identity.fileNo&&identity.fullName)exactNames.push(`${identity.fileNo} - ${identity.fullName}`,`${identity.fullName} - ${identity.fileNo}`,`${identity.fileNo}_${identity.fullName}`,`${identity.fullName}_${identity.fileNo}`);
  for(const name of exactNames){const found=dirs.find(dir=>sameValue(path.basename(dir),name));if(found)return{patientDir:found,manifest:readPatientManifest(found)};}

  if(identity.fullName){const nameMatches=dirs.filter(dir=>matchPart(path.basename(dir)).includes(matchPart(identity.fullName)));if(nameMatches.length===1)return{patientDir:nameMatches[0],manifest:readPatientManifest(nameMatches[0])};}
  return null;
}
function patientFolder(dir,logicalName){
  const aliases=FOLDER_ALIASES[logicalName]||[logicalName];
  const existing=aliases.map(name=>path.join(dir,name)).find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isDirectory());
  const folder=existing||path.join(dir,aliases[0]);fs.mkdirSync(folder,{recursive:true});return folder;
}
function uniqueFile(dir,name){const ext=path.extname(name),base=path.basename(name,ext);let candidate=path.join(dir,name),index=2;while(fs.existsSync(candidate)){candidate=path.join(dir,`${base}-${index}${ext}`);index++;}return candidate;}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(value,null,2),"utf8");try{fs.renameSync(temp,file)}catch{try{fs.unlinkSync(file)}catch{}fs.renameSync(temp,file)}}
function html(value){return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));}
function dataUrlParts(value){const match=String(value||"").match(/^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i);if(!match)return null;const type=match[1].toLowerCase(),ext=type==="jpeg"||type==="jpg"?".jpg":`.${type}`;return{ext,buffer:Buffer.from(match[2],"base64")};}
function saveDataUrl(value,basePath){const parsed=dataUrlParts(value);if(!parsed)return"";const file=`${basePath}${parsed.ext}`;fs.writeFileSync(file,parsed.buffer);return file;}
function fileDataUrl(file){if(!file||!fs.existsSync(file))return"";return`data:${mime.lookup(file)||"image/png"};base64,${fs.readFileSync(file).toString("base64")}`;}
function walkFiles(dir,depth=0){
  if(depth>5||!fs.existsSync(dir))return[];const output=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name.startsWith("."))continue;const full=path.join(dir,entry.name);if(entry.isDirectory())output.push(...walkFiles(full,depth+1));else if(entry.isFile())output.push(full);}
  return output;
}

class PatientArchive{
  constructor({app,settings,onState,onNotice}){this.app=app;this.settings=settings;this.onState=onState||(()=>{});this.onNotice=onNotice||(()=>{});this.current=null;}
  root(){const configured=String(this.settings.get("patientArchiveRoot")||"").trim();return configured||path.join(this.app.getPath("documents"),"Dental Chain Patients");}
  setRoot(root){if(!root)return this.snapshot();fs.mkdirSync(root,{recursive:true});this.settings.patch({patientArchiveRoot:root});if(this.current)this.select(this.current);return this.snapshot();}
  snapshot(){return this.current?{...this.current,archiveRoot:this.root(),selected:true}:{archiveRoot:this.root(),selected:false};}
  select(payload={}){
    const root=this.root();fs.mkdirSync(root,{recursive:true});
    const suppliedFullName=safePart(payload.fullName||payload.name||"",""),suppliedFileNo=safePart(payload.fileNo||payload.fileNumber||"",""),suppliedPatientId=String(payload.patientId||payload.id||suppliedFileNo||"").trim();
    const resolved=resolvePatientDirectory(root,payload,{fullName:suppliedFullName,fileNo:suppliedFileNo,patientId:suppliedPatientId}),manifest=resolved?.manifest||{};
    const fullName=safePart(manifest.fullName||manifest.name||suppliedFullName,"مريض"),fileNo=safePart(manifest.fileNo||manifest.fileNumber||suppliedFileNo,""),patientId=String(manifest.patientId||manifest.id||suppliedPatientId||fileNo||fullName).trim();
    const stableCode=fileNo||(patientId&&!sameValue(patientId,fullName)?safePart(patientId,""):"");
    const folderName=safePart(stableCode?`${stableCode} - ${fullName}`:fullName),patientDir=resolved?.patientDir||path.join(root,folderName);fs.mkdirSync(patientDir,{recursive:true});
    const folders={};for(const name of FOLDERS)folders[name]=patientFolder(patientDir,name);
    const previousSame=this.current&&sameValue(this.current.patientId,patientId);
    const selectedAt=new Date().toISOString();
    this.current={
      patientId,
      fileNo,
      fullName,
      firstName:String(payload.firstName||payload.displayName||manifest.firstName||fullName.split(/\s+/)[0]||fullName),
      displayName:String(payload.firstName||payload.displayName||manifest.firstName||fullName.split(/\s+/)[0]||fullName),
      gender:["male","female"].includes(String(payload.gender||manifest.gender))?String(payload.gender||manifest.gender):"",
      doctorName:String(payload.doctorName||manifest.doctorName||""),
      clinicName:String(payload.clinicName||manifest.clinicName||""),
      sessionId:String(payload.sessionId||(previousSame?this.current.sessionId:"")||crypto.randomUUID()),
      patientDir,
      folders,
      selectedAt
    };
    writeJson(path.join(patientDir,"patient.json"),{
      schema:"dtdc-patient-archive-v3",
      patientId,
      fileNo,
      fullName,
      firstName:this.current.firstName,
      gender:this.current.gender,
      doctorName:this.current.doctorName,
      clinicName:this.current.clinicName,
      sessionId:this.current.sessionId,
      lastSelectedAt:selectedAt
    });
    this.onState(this.snapshot());return this.snapshot();
  }
  clear(){this.current=null;this.onState(this.snapshot());return this.snapshot();}
  requirePatient(){if(!this.current)throw new Error("افتح ملف المريض في البرنامج الرئيسي أولاً");return this.current;}
  panoramaFolder(){return this.requirePatient().folders.Panorama;}
  listPanoramas(){const dir=this.panoramaFolder();return fs.readdirSync(dir,{withFileTypes:true}).filter(entry=>entry.isFile()&&IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).map(entry=>{const filePath=path.join(dir,entry.name),stat=fs.statSync(filePath);return{name:entry.name,path:filePath,size:stat.size,modifiedAt:stat.mtimeMs};}).sort((a,b)=>b.modifiedAt-a.modifiedAt);}
  importPanorama(source){this.requirePatient();if(!source||!fs.existsSync(source))throw new Error("ملف الصورة غير موجود");if(!IMAGE_EXTENSIONS.has(path.extname(source).toLowerCase()))throw new Error("صيغة الصورة غير مدعومة");const destination=uniqueFile(this.panoramaFolder(),safePart(path.basename(source),"panorama.jpg"));fs.copyFileSync(source,destination);return{path:destination,name:path.basename(destination)};}
  plansDir(){return this.requirePatient().folders.TreatmentPlans;}
  savePlan(plan={}){
    const patient=this.requirePatient(),id=safePart(plan.id||`PLAN-${Date.now()}`),createdAt=plan.createdAt||new Date().toISOString(),dir=path.join(this.plansDir(),id);fs.mkdirSync(dir,{recursive:true});
    const normalized={...JSON.parse(JSON.stringify(plan)),id,schema:"dtdc-treatment-plan-v3-manual",createdAt,updatedAt:new Date().toISOString(),patient:{patientId:patient.patientId,fileNo:patient.fileNo,fullName:patient.fullName,doctorName:plan.doctorName||patient.doctorName}};
    if(plan.sourcePath&&fs.existsSync(plan.sourcePath)){
      normalized.panoramaFileName=path.basename(plan.sourcePath);
      normalized.panoramaPath=plan.sourcePath;
      normalized.sourcePath=plan.sourcePath;
      normalized.sourceArchivePath="";
      normalized.panoramaRelativePath=path.relative(patient.patientDir,plan.sourcePath);
    }
    const annotatedPath=saveDataUrl(plan.annotatedImageDataUrl,path.join(dir,"annotated-panorama"));if(annotatedPath)normalized.annotatedImagePath=annotatedPath;delete normalized.annotatedImageDataUrl;delete normalized.displayImageDataUrl;
    normalized.stages=(normalized.stages||[]).map((stage,index)=>{
      const item={...stage},prefix=`stage-${String(index+1).padStart(2,"0")}`;
      const illustrationPath=stage.illustrationMode==="none"?"":saveDataUrl(stage.illustrationDataUrl,path.join(dir,`${prefix}-illustration`));
      if(illustrationPath){item.illustrationPath=illustrationPath;item.illustrationMode="selected";}else{item.illustrationPath="";item.illustrationMode="none";}
      if(stage.backgroundPath&&fs.existsSync(stage.backgroundPath)){
        const ext=IMAGE_EXTENSIONS.has(path.extname(stage.backgroundPath).toLowerCase())?path.extname(stage.backgroundPath).toLowerCase():".jpg";
        const archivedBackground=path.join(dir,`${prefix}-background${ext}`);
        if(path.resolve(stage.backgroundPath)!==path.resolve(archivedBackground))fs.copyFileSync(stage.backgroundPath,archivedBackground);
        item.backgroundPath=archivedBackground;
      }
      delete item.illustrationDataUrl;
      delete item.backgroundDataUrl;
      return item;
    });
    writeJson(path.join(dir,"plan.json"),normalized);fs.writeFileSync(path.join(dir,"presentation.html"),this.planHtml(normalized),"utf8");return{...normalized,folder:dir};
  }
  listPlans(){const dir=this.plansDir();return fs.readdirSync(dir,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.name.startsWith(".")).map(entry=>{try{const plan=JSON.parse(fs.readFileSync(path.join(dir,entry.name,"plan.json"),"utf8"));return{id:plan.id,title:plan.title||"خطة علاج",createdAt:plan.createdAt,updatedAt:plan.updatedAt,totalCost:plan.totalCost,currency:plan.currency,stagesCount:plan.stages?.length||0,panoramaFileName:plan.panoramaFileName||path.basename(plan.panoramaPath||plan.sourcePath||"")};}catch{return null;}}).filter(Boolean).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));}
  deletePlan(id){const dir=path.join(this.plansDir(),safePart(id));if(!fs.existsSync(dir))throw new Error("الخطة غير موجودة");fs.rmSync(dir,{recursive:true,force:true});this.onNotice?.("تم حذف الخطة","success");return true;}
  resolvePlanPanorama(plan={}){
    const direct=[plan.panoramaPath,plan.sourcePath,plan.sourceArchivePath].find(file=>file&&fs.existsSync(file));
    if(direct)return direct;
    const patient=this.requirePatient();
    if(plan.panoramaRelativePath){const relative=path.join(patient.patientDir,plan.panoramaRelativePath);if(fs.existsSync(relative))return relative;}
    const name=String(plan.panoramaFileName||plan.sourceName||"").trim();
    if(name){const exact=path.join(this.panoramaFolder(),path.basename(name));if(fs.existsSync(exact))return exact;const sameBase=this.listPanoramas().find(item=>path.parse(item.name).name===path.parse(name).name);if(sameBase)return sameBase.path;}
    return "";
  }
  loadPlan(id,includeAssets=false){const file=path.join(this.plansDir(),safePart(id),"plan.json");if(!fs.existsSync(file))throw new Error("الخطة غير موجودة");const plan=JSON.parse(fs.readFileSync(file,"utf8"));const source=this.resolvePlanPanorama(plan);const resolved={...plan,panoramaPath:source||plan.panoramaPath||"",sourcePath:source||plan.sourcePath||"",panoramaMissing:!source};if(!includeAssets)return resolved;return{...resolved,sourceDataUrl:fileDataUrl(source),annotatedImageDataUrl:fileDataUrl(plan.annotatedImagePath),stages:(plan.stages||[]).map(stage=>({...stage,illustrationDataUrl:fileDataUrl(stage.illustrationPath)}))};}
  saveLivePresentation(dataUrl){this.requirePatient();const parsed=dataUrlParts(dataUrl);if(!parsed)throw new Error("صورة العرض غير صالحة");const file=path.join(this.plansDir(),`.live-presentation${parsed.ext}`);fs.writeFileSync(file,parsed.buffer);return file;}
  assistantSessionsDir(){return this.requirePatient().folders.AssistantSessions;}
  saveAssistantContext(context={}){const patient=this.requirePatient(),value={...JSON.parse(JSON.stringify(context)),archivedAt:new Date().toISOString(),patient:{...(context.patient||{}),patientId:patient.patientId,fileNo:patient.fileNo,fullName:patient.fullName}};writeJson(path.join(this.assistantSessionsDir(),"active-context.json"),value);return value;}
  saveAssistantSession(session={}){
    const patient=this.requirePatient(),sessionId=safePart(session.sessionId||`assistant-${Date.now()}`),planId=safePart(session.planId||"plan"),dir=path.join(this.assistantSessionsDir(),planId);fs.mkdirSync(dir,{recursive:true});
    const normalized={...JSON.parse(JSON.stringify(session)),schema:"dtdc-assistant-session-v1",sessionId,planId,patient:{patientId:patient.patientId,fileNo:patient.fileNo,fullName:patient.fullName},archivedAt:new Date().toISOString()};
    const file=uniqueFile(dir,`${safePart(normalized.completedAt||normalized.startedAt||new Date().toISOString()).replace(/[: ]/g,"-")}-${sessionId}.json`);writeJson(file,normalized);return{...normalized,file};
  }
  saveAssistantStage(stage={}){
    const patient=this.requirePatient(),planId=safePart(stage.planId||"plan"),dir=path.join(this.assistantSessionsDir(),planId);fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,"plan-progress.json");let progress={schema:"dtdc-plan-progress-v1",patientId:patient.patientId,fileNo:patient.fileNo,planId,stages:{},history:[]};
    try{if(fs.existsSync(file))progress={...progress,...JSON.parse(fs.readFileSync(file,"utf8"))}}catch{}
    progress.stages=progress.stages&&typeof progress.stages==="object"?progress.stages:{};
    progress.stages[String(stage.stageId)]={stageId:String(stage.stageId),status:String(stage.status||"completed"),completed:Boolean(stage.completed),completedAt:String(stage.completedAt||""),summary:String(stage.summary||""),updatedAt:new Date().toISOString()};
    progress.history=Array.isArray(progress.history)?progress.history:[];progress.history.push({...JSON.parse(JSON.stringify(stage)),archivedAt:new Date().toISOString()});progress.history=progress.history.slice(-500);progress.updatedAt=new Date().toISOString();writeJson(file,progress);return{...progress,file};
  }
  saveAssistantPlanClosure(closure={}){
    const patient=this.requirePatient(),planId=safePart(closure.planId||"plan"),dir=path.join(this.assistantSessionsDir(),planId);fs.mkdirSync(dir,{recursive:true});
    const value={schema:"dtdc-plan-closure-v1",patientId:patient.patientId,fileNo:patient.fileNo,planId:String(closure.planId||planId),status:"done",doctorName:String(closure.doctorName||""),reason:String(closure.reason||"closed_by_doctor"),closedAt:String(closure.closedAt||new Date().toISOString())};
    const file=path.join(dir,"plan-closed.json");writeJson(file,value);return{...value,file};
  }
  reconcileAssistantContext(context={}){
    this.requirePatient();const source=JSON.parse(JSON.stringify(context||{})),closedPlans=[];
    source.plans=(Array.isArray(source.plans)?source.plans:[]).filter(plan=>{
      const dir=path.join(this.assistantSessionsDir(),safePart(plan.planId||"plan")),closureFile=path.join(dir,"plan-closed.json"),progressFile=path.join(dir,"plan-progress.json");
      if(fs.existsSync(closureFile)){try{const closure=JSON.parse(fs.readFileSync(closureFile,"utf8"));closedPlans.push({...closure,planId:String(plan.planId),serviceId:plan.serviceId,serviceName:plan.serviceName,target:plan.target});return false}catch{}}
      if(fs.existsSync(progressFile)){try{const progress=JSON.parse(fs.readFileSync(progressFile,"utf8")),saved=progress.stages&&typeof progress.stages==="object"?progress.stages:{};(plan.stages||[]).forEach(stage=>{const item=saved[String(stage.stageId)];if(item){stage.done=Boolean(item.completed);stage.status=String(item.status||stage.status||"completed");stage.completedAt=String(item.completedAt||stage.completedAt||"");stage.summary=String(item.summary||stage.summary||"")}});const total=(plan.stages||[]).length,done=(plan.stages||[]).filter(stage=>stage.done).length;plan.progress=total?Math.round(done*100/total):0;plan.status=total&&done===total?"ready_to_close":done?"active":plan.status}catch{}}
      return true;
    });
    source.closedPlans=closedPlans;return source;
  }
  saveAssistantMedia(media={}){
    const patient=this.requirePatient(),buffer=Buffer.isBuffer(media.buffer)?media.buffer:null;if(!buffer||!buffer.length)throw new Error("ملف الوسيط فارغ");
    const planId=safePart(media.planId||"unassigned"),sessionId=safePart(media.sessionId||"session"),dir=path.join(this.assistantSessionsDir(),planId,sessionId,"media");fs.mkdirSync(dir,{recursive:true});
    const type=String(media.mimeType||"").toLowerCase(),fallbackExt=type.includes("png")?".png":type.includes("webp")?".webp":type.includes("jpeg")||type.includes("jpg")?".jpg":type.includes("mp4")?".mp4":type.includes("webm")?".webm":type.includes("audio")?".m4a":".bin";
    const rawName=safePart(media.fileName||`${media.kind||"media"}-${Date.now()}${fallbackExt}`),name=path.extname(rawName)?rawName:`${rawName}${fallbackExt}`,file=uniqueFile(dir,name);fs.writeFileSync(file,buffer);
    const metadata={schema:"dtdc-assistant-media-v1",patientId:patient.patientId,fileNo:patient.fileNo,planId,sessionId,kind:String(media.kind||"other"),mimeType:String(media.mimeType||"application/octet-stream"),fileName:path.basename(file),bytes:buffer.length,createdAt:new Date().toISOString()};writeJson(`${file}.json`,metadata);return{...metadata,file};
  }
  archiveCategories(){return[
    {id:"all",label:"الكل"},{id:"Panorama",label:"بانوراما"},{id:"Sensor",label:"أشعة وسينسور"},{id:"Before",label:"قبل العلاج"},{id:"After",label:"بعد العلاج"},{id:"Intraoral",label:"داخل الفم"},{id:"Photos",label:"صور عادية"},{id:"Other",label:"أخرى"},{id:"TreatmentPlans",label:"خطط العلاج"},{id:"AssistantSessions",label:"جلسات المساعد"}
  ];}
  listArchive(category="all"){
    const patient=this.requirePatient(),allowed=new Set(FOLDERS),requested=String(category||"all"),folders=requested==="all"?FOLDERS:(allowed.has(requested)?[requested]:[]),items=[];
    for(const logical of folders){for(const file of walkFiles(patient.folders[logical])){if(file.endsWith(".json")&&fs.existsSync(file.slice(0,-5)))continue;let stat;try{stat=fs.statSync(file)}catch{continue}const ext=path.extname(file).toLowerCase(),kind=IMAGE_EXTENSIONS.has(ext)?"image":ext===".json"?"record":logical==="TreatmentPlans"?"plan":"file";items.push({id:crypto.createHash("sha1").update(file).digest("hex").slice(0,16),category:logical,kind,name:path.basename(file),path:file,relativePath:path.relative(patient.patientDir,file),size:stat.size,modifiedAt:stat.mtimeMs,mimeType:mime.lookup(file)||"application/octet-stream"});}}
    return{patient:{patientId:patient.patientId,fileNo:patient.fileNo,fullName:patient.fullName},categories:this.archiveCategories(),items:items.sort((a,b)=>b.modifiedAt-a.modifiedAt)};
  }
  archivePreview(file){
    const patient=this.requirePatient(),target=path.resolve(String(file||""));if(!insideRoot(patient.patientDir,target)||!fs.existsSync(target)||!fs.statSync(target).isFile())throw new Error("الملف ليس ضمن أرشيف المريض");
    const ext=path.extname(target).toLowerCase(),type=mime.lookup(target)||"application/octet-stream";if(IMAGE_EXTENSIONS.has(ext))return{kind:"image",path:target,name:path.basename(target),mimeType:type,dataUrl:fileDataUrl(target)};
    if(ext===".json"){let value={};try{value=JSON.parse(fs.readFileSync(target,"utf8"))}catch{}return{kind:"record",path:target,name:path.basename(target),value};}
    return{kind:"file",path:target,name:path.basename(target),mimeType:type};
  }
  importArchive(source,category="Other"){
    const patient=this.requirePatient(),logical=FOLDERS.includes(String(category))&&!['TreatmentPlans','AssistantSessions'].includes(String(category))?String(category):"Other";if(!source||!fs.existsSync(source)||!fs.statSync(source).isFile())throw new Error("ملف الاستيراد غير موجود");
    const destination=uniqueFile(patient.folders[logical],safePart(path.basename(source),`import-${Date.now()}`));fs.copyFileSync(source,destination);return{path:destination,name:path.basename(destination),category:logical};
  }
  deleteArchive(file){
    const patient=this.requirePatient(),target=path.resolve(String(file||""));if(!insideRoot(patient.patientDir,target)||!fs.existsSync(target)||!fs.statSync(target).isFile())throw new Error("الملف ليس ضمن أرشيف المريض");fs.unlinkSync(target);try{if(fs.existsSync(`${target}.json`))fs.unlinkSync(`${target}.json`)}catch{}return true;
  }
  planHtml(plan){
    const stages=Array.isArray(plan.stages)?plan.stages:[];
    const panorama=plan.panoramaPath?path.basename(plan.panoramaPath):"";
    const annotated=plan.annotatedImagePath?path.basename(plan.annotatedImagePath):panorama;
    const stageRows=stages.map((stage,index)=>{
      const bg=stage.backgroundPath?path.basename(stage.backgroundPath):"";
      const priority=stage.priority||"مرحلة علاج";
      const title=stage.title||stage.subtitle||"";
      const thumb=annotated||panorama;
      return`<section class="slide stage-slide" style="--accent:${html(stage.color||"#2f8fe9")}">
        ${bg?`<img class="living-bg" src="${html(bg)}" alt="">`:""}<div class="shade"></div>
        ${stage.illustrationPath?`<div class="visual transparent"><img src="${html(path.basename(stage.illustrationPath))}" alt="الصورة التوضيحية للمرحلة"></div>`:""}
        <article class="glass-card"><small>المرحلة ${index+1}</small><h2>${html(priority)}</h2><h3>${html(title)}</h3><p>${html(stage.description||stage.notes||"")}</p>
          <div class="meta"><span>الأسنان ${html((stage.teeth||stage.toothIds||[]).join("، ")||"—")}</span><span>${html(stage.sessions||1)} جلسة</span><span>${html(stage.duration||"مدة مرنة")}</span>${stage.cost?`<span>${html(stage.cost)} ${html(plan.currency||"")}</span>`:""}</div>
          ${thumb?`<img class="thumb" src="${html(thumb)}" alt="صورة مصغرة للبانوراما">`:""}
        </article>
      </section>`;
    }).join("");
    const summary=stages.map((stage,index)=>`<div class="summary-item"><b style="color:${html(stage.color||"#2f8fe9")}">${index+1}. ${html(stage.priority||stage.title||"مرحلة")}</b><span>${html(stage.duration||"")} ${stage.cost?`· ${html(stage.cost)} ${html(plan.currency||"")}`:""}</span></div>`).join("");
    return`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${html(plan.title||"خطة علاج")}</title><style>
    *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#06131d;color:#123246;font-family:Tahoma,Arial,sans-serif}.slide{display:none;position:relative;width:100vw;height:100dvh;min-height:100vh;overflow:hidden}.slide.active{display:block}.intro{background:#000}.intro img{width:100%;height:100%;object-fit:contain;animation:ken 18s ease-in-out infinite alternate}.living-bg{position:absolute;inset:-5%;width:110%;height:110%;object-fit:cover;filter:saturate(.85) brightness(.95);animation:ken 18s ease-in-out infinite alternate}.shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(3,14,22,.12),rgba(235,247,251,.32) 48%,rgba(245,251,253,.96) 100%)}.visual{position:absolute;left:4vw;top:8vh;width:49vw;height:72vh;display:grid;place-items:center;border-radius:clamp(18px,2vw,34px);overflow:hidden;background:rgba(0,8,12,.92);box-shadow:0 24px 80px rgba(0,20,35,.28)}.visual img{width:100%;height:100%;object-fit:contain}.visual.transparent{background:transparent;box-shadow:none}.glass-card{position:absolute;right:4.5vw;top:50%;transform:translateY(-50%);width:min(39vw,720px);max-height:86vh;overflow:auto;padding:clamp(22px,3vw,48px);border-right:clamp(6px,.65vw,11px) solid var(--accent);border-radius:clamp(20px,2vw,36px);background:rgba(255,255,255,.88);box-shadow:0 24px 80px rgba(11,57,80,.18);backdrop-filter:blur(22px)}.glass-card small{color:var(--accent);font-weight:800}.glass-card h2{margin:.15em 0 .08em;color:var(--accent);font-size:clamp(42px,5.2vw,92px);line-height:.95}.glass-card h3{margin:0 0 .7em;font-size:clamp(21px,2vw,36px);font-weight:500}.glass-card p{margin:0;color:#496778;font-size:clamp(16px,1.25vw,24px);line-height:1.75}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.meta span{padding:7px 12px;border-radius:999px;background:#edf5f8;font-size:clamp(12px,.85vw,16px);font-weight:700}.thumb{display:block;width:100%;height:clamp(82px,12vh,150px);margin-top:20px;object-fit:contain;border-radius:16px;background:#02080c}.panorama-overlay{display:none;position:fixed;inset:0;z-index:20;background:#000}.panorama-overlay.open{display:grid;place-items:center}.panorama-overlay img{width:100%;height:100%;object-fit:contain}.final{background:radial-gradient(circle at 18% 20%,#176981 0,#0b4056 34%,#071b29 100%);color:white;padding:7vh 8vw}.final-inner{max-width:1180px;margin:auto}.final h1{font-size:clamp(38px,5vw,82px);margin:0 0 3vh}.summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.summary-item{display:flex;justify-content:space-between;gap:20px;padding:16px 18px;border-radius:18px;background:rgba(255,255,255,.09);font-size:clamp(15px,1.2vw,22px)}.total{margin-top:4vh;font-size:clamp(28px,3.6vw,62px);font-weight:900;opacity:0;transform:translateY(16px);transition:.5s}.final.completed .total{opacity:1;transform:none}.final.completed .summary-item:before{content:"✓";color:#56e6a8;margin-left:10px}.panorama-overlay img{transform:translate(var(--pan-x,0px),var(--pan-y,0px)) scale(var(--zoom,1));transition:transform .12s ease-out}@keyframes ken{from{transform:scale(1.02) translate3d(-1%,0,0)}to{transform:scale(1.09) translate3d(1.5%,-1%,0)}}
    @media(max-aspect-ratio:4/3),(max-width:900px){.visual{left:3vw;top:5vh;width:46vw;height:56vh}.glass-card{right:3vw;width:46vw;max-height:90vh}.shade{background:linear-gradient(90deg,rgba(3,14,22,.2),rgba(245,251,253,.94) 58%)}.summary{grid-template-columns:1fr}}
    @media(max-width:640px){.visual{left:4vw;top:4vh;width:92vw;height:38vh}.glass-card{right:4vw;top:auto;bottom:3vh;transform:none;width:92vw;max-height:53vh}.glass-card h2{font-size:clamp(34px,11vw,58px)}}
    @media(prefers-reduced-motion:reduce){.living-bg,.intro img{animation:none}}
    </style></head><body>
    <section class="slide intro active">${panorama?`<img src="${html(panorama)}" alt="بانوراما المريض">`:""}</section>${stageRows}
    <section class="slide final"><div class="final-inner"><small>DR TAHER DENTAL CHAIN</small><h1>${html(plan.title||"خطة العلاج المقترحة")}</h1><div class="summary">${summary}</div><div class="total" id="finalTotal">${html(plan.totalCost||0)} ${html(plan.currency||"")} · ${html(plan.totalSessions||0)} جلسة</div></div></section>
    <div class="panorama-overlay" id="overlay">${annotated?`<img src="${html(annotated)}" alt="البانوراما المرسوم عليها">`:""}</div>
    <script>const slides=[...document.querySelectorAll('.slide')],overlay=document.getElementById('overlay'),finalSlide=slides.at(-1);let i=0,finalCompleted=false,panX=0,panY=0,zoom=1;function resetView(){panX=panY=0;zoom=1;overlay.style.setProperty('--pan-x','0px');overlay.style.setProperty('--pan-y','0px');overlay.style.setProperty('--zoom','1')}function show(n){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach((s,x)=>s.classList.toggle('active',x===i));overlay.classList.remove('open');resetView()}function togglePanorama(){if(i===0)return;const opening=!overlay.classList.contains('open');overlay.classList.toggle('open',opening);if(!opening&&i===slides.length-1){finalCompleted=true;finalSlide.classList.add('completed')}}function pan(dx,dy){panX+=dx;panY+=dy;overlay.style.setProperty('--pan-x',panX+'px');overlay.style.setProperty('--pan-y',panY+'px')}addEventListener('keydown',e=>{if(overlay.classList.contains('open')){if(e.key==='ArrowRight')pan(28,0);else if(e.key==='ArrowLeft')pan(-28,0);else if(e.key==='ArrowUp')pan(0,-28);else if(e.key==='ArrowDown')pan(0,28);else if(e.key==='+'||e.key==='='){zoom=Math.min(5,zoom+.15);overlay.style.setProperty('--zoom',zoom)}else if(e.key==='-'){zoom=Math.max(.5,zoom-.15);overlay.style.setProperty('--zoom',zoom)}else if(e.key==='Enter')togglePanorama();else if(e.key==='Escape')overlay.classList.remove('open');return}if(e.key==='ArrowRight'||e.key==='PageDown')show(i+1);else if(e.key==='ArrowLeft'||e.key==='PageUp')show(i-1);else if(e.key==='ArrowUp')pan(0,-28);else if(e.key==='ArrowDown')pan(0,28);else if(e.key==='Enter')togglePanorama();else if(e.key==='Escape')overlay.classList.remove('open');else if(e.key==='Home')show(0);else if(e.key==='End')show(slides.length-1)});</script></body></html>`;
  }
}

module.exports={PatientArchive,IMAGE_EXTENSIONS,FOLDER_ALIASES};
