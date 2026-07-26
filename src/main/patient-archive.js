"use strict";

const fs=require("fs");
const path=require("path");
const mime=require("mime-types");
const crypto=require("crypto");

const IMAGE_EXTENSIONS=new Set([".png",".jpg",".jpeg",".bmp",".webp",".tif",".tiff"]);
const FOLDERS=["Panorama","Sensor","Other","TreatmentPlans"];
const FOLDER_ALIASES={
  Panorama:["01 - صور بانوراما","Panorama"],
  Sensor:["02 - صور أشعة وسينسور","Sensor"],
  Other:["07 - صور أخرى","Other"],
  TreatmentPlans:["TreatmentPlans","08 - خطط العلاج"]
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
    if(plan.sourcePath&&fs.existsSync(plan.sourcePath)){const ext=IMAGE_EXTENSIONS.has(path.extname(plan.sourcePath).toLowerCase())?path.extname(plan.sourcePath).toLowerCase():".png";normalized.sourceArchivePath=path.join(dir,`source${ext}`);if(path.resolve(plan.sourcePath)!==path.resolve(normalized.sourceArchivePath))fs.copyFileSync(plan.sourcePath,normalized.sourceArchivePath);}
    const annotatedPath=saveDataUrl(plan.annotatedImageDataUrl,path.join(dir,"annotated-panorama"));if(annotatedPath)normalized.annotatedImagePath=annotatedPath;delete normalized.annotatedImageDataUrl;delete normalized.displayImageDataUrl;
    normalized.stages=(normalized.stages||[]).map((stage,index)=>{
      const item={...stage},prefix=`stage-${String(index+1).padStart(2,"0")}`;
      const illustrationPath=saveDataUrl(stage.illustrationDataUrl,path.join(dir,`${prefix}-illustration`));
      if(illustrationPath)item.illustrationPath=illustrationPath;
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
  listPlans(){const dir=this.plansDir();return fs.readdirSync(dir,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.name.startsWith(".")).map(entry=>{try{const plan=JSON.parse(fs.readFileSync(path.join(dir,entry.name,"plan.json"),"utf8"));return{id:plan.id,title:plan.title||"خطة علاج",createdAt:plan.createdAt,updatedAt:plan.updatedAt,totalCost:plan.totalCost,currency:plan.currency,stagesCount:plan.stages?.length||0};}catch{return null;}}).filter(Boolean).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));}
  loadPlan(id,includeAssets=false){const file=path.join(this.plansDir(),safePart(id),"plan.json");if(!fs.existsSync(file))throw new Error("الخطة غير موجودة");const plan=JSON.parse(fs.readFileSync(file,"utf8"));if(!includeAssets)return plan;const source=plan.sourceArchivePath||plan.sourcePath||plan.panoramaPath;return{...plan,sourceDataUrl:fileDataUrl(source),annotatedImageDataUrl:fileDataUrl(plan.annotatedImagePath),stages:(plan.stages||[]).map(stage=>({...stage,illustrationDataUrl:fileDataUrl(stage.illustrationPath)}))};}
  saveLivePresentation(dataUrl){this.requirePatient();const parsed=dataUrlParts(dataUrl);if(!parsed)throw new Error("صورة العرض غير صالحة");const file=path.join(this.plansDir(),`.live-presentation${parsed.ext}`);fs.writeFileSync(file,parsed.buffer);return file;}
  planHtml(plan){
    const stages=Array.isArray(plan.stages)?plan.stages:[],annotated=plan.annotatedImagePath?path.basename(plan.annotatedImagePath):"";
    const rows=stages.map((stage,index)=>{const illustration=stage.illustrationPath?`<img src="${html(path.basename(stage.illustrationPath))}" alt="">`:"";return`<article style="border-right-color:${html(stage.color||"#19b8f2")}">${illustration}<div><b>${index+1}. ${html(stage.title)}</b><p>${html(stage.description||"")}</p><small>الأسنان: ${html((stage.teeth||[]).join("، ")||"—")} · الأولوية: ${html(stage.priority||"—")} · الإنذار: ${html(stage.prognosis||"—")}</small><strong>${html(stage.sessions||1)} جلسة · ${html(stage.duration||"")} · ${html(stage.cost||0)} ${html(plan.currency||"")}</strong></div></article>`;}).join("");
    return`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>${html(plan.title||"خطة علاج")}</title><style>body{font-family:Tahoma,Arial;background:#f3f8fc;color:#16354a;margin:0;padding:40px}main{max-width:1100px;margin:auto}.hero{padding:30px;border-radius:28px;background:linear-gradient(135deg,#10b9d6,#225cff);color:white}.panorama{width:100%;max-height:520px;object-fit:contain;background:#020609;border-radius:22px;margin:18px 0}article{display:grid;grid-template-columns:150px 1fr;gap:18px;background:white;margin:14px 0;padding:18px;border-radius:18px;border-right:8px solid #19b8f2;box-shadow:0 8px 24px #16426018}article img{width:150px;height:120px;object-fit:cover;border-radius:14px}article b,article strong{display:block;font-size:20px}article strong{margin-top:12px;color:#0b6c87}.total{font-size:27px;background:#102e45;color:white;padding:22px;border-radius:18px}</style><main><section class="hero"><small>DENTAL CHAIN · خطة علاج بصرية</small><h1>${html(plan.patient?.fullName||"")}</h1><p>${html(plan.title||"خطة العلاج المقترحة")}</p></section>${annotated?`<img class="panorama" src="${html(annotated)}" alt="">`:""}${rows}<div class="total">الإجمالي المتوقع: <b>${html(plan.totalCost||0)} ${html(plan.currency||"")}</b> · ${html(plan.totalSessions||0)} جلسة</div><p>${html(plan.closingNote||"خطة تقديرية قابلة للتعديل بحسب الفحص والاستجابة السريرية.")}</p></main></html>`;
  }
}

module.exports={PatientArchive,IMAGE_EXTENSIONS,FOLDER_ALIASES};
