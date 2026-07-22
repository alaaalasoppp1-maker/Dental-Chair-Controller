"use strict";

const fs=require("fs");
const path=require("path");
const crypto=require("crypto");

const IMAGE_EXTENSIONS=new Set([".png",".jpg",".jpeg",".bmp",".webp",".tif",".tiff"]);
const FOLDERS=["Panorama","Sensor","Other","TreatmentPlans","Annotations","Originals","Exports"];
const META_FILE=".dtdc-patient.json";

function safePart(value,fallback="patient"){
  const cleaned=String(value||"").normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g," ")
    .replace(/\s+/g," ").trim().replace(/[. ]+$/g,"");
  return (cleaned||fallback).slice(0,90);
}
function norm(value){return safePart(value,"").toLocaleLowerCase("ar").replace(/[\s_-]+/g,"");}
function uniqueFile(dir,name){
  const ext=path.extname(name),base=path.basename(name,ext);let candidate=path.join(dir,name),i=2;
  while(fs.existsSync(candidate)){candidate=path.join(dir,`${base}-${i}${ext}`);i++;}
  return candidate;
}
function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),"utf8");
  fs.renameSync(temp,file);
}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
function hashFile(file){
  const h=crypto.createHash("sha256");h.update(fs.readFileSync(file));return h.digest("hex");
}
function html(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}

class PatientArchive{
  constructor({app,settings,onState,onNotice}){
    this.app=app;this.settings=settings;this.onState=onState||(()=>{});this.onNotice=onNotice||(()=>{});this.current=null;
  }
  root(){
    const configured=String(this.settings.get("patientArchiveRoot")||"").trim();
    return configured||path.join(this.app.getPath("documents"),"Dental Chain Patients");
  }
  setRoot(root){
    if(!root)return this.snapshot();
    fs.mkdirSync(root,{recursive:true});this.settings.patch({patientArchiveRoot:root});
    if(this.current)this.select(this.current);
    return this.snapshot();
  }
  snapshot(){return this.current?{...this.current,archiveRoot:this.root(),selected:true}:{archiveRoot:this.root(),selected:false};}
  scanDirectories(){
    const root=this.root();fs.mkdirSync(root,{recursive:true});
    return fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>path.join(root,x.name));
  }
  findExisting({patientId,fileNo,fullName}){
    const pid=String(patientId||"").trim(),fno=norm(fileNo),name=norm(fullName);
    let fileNoMatch=null,nameMatch=null;
    for(const dir of this.scanDirectories()){
      const meta=readJson(path.join(dir,META_FILE))||readJson(path.join(dir,"patient.json"));
      if(meta&&pid&&String(meta.patientId||"")===pid)return dir;
      if(meta&&fno&&norm(meta.fileNo)===fno)fileNoMatch=fileNoMatch||dir;
      const folder=norm(path.basename(dir));
      if(fno&&folder.includes(fno))fileNoMatch=fileNoMatch||dir;
      if(name&&folder.includes(name))nameMatch=nameMatch||dir;
    }
    return fileNoMatch||nameMatch||null;
  }
  select(payload={}){
    const fullName=safePart(payload.fullName||payload.name||payload.displayName,"مريض");
    const firstName=safePart(payload.firstName||payload.displayName||fullName.split(/\s+/)[0]||fullName,"مريض");
    const fileNo=safePart(payload.fileNo||payload.fileNumber||"","");
    const patientId=String(payload.patientId||payload.id||fileNo||fullName).trim();
    const existing=this.findExisting({patientId,fileNo,fullName});
    const folderName=safePart(fileNo?`${fullName} - ${fileNo}`:`${fullName}`);
    const patientDir=existing||path.join(this.root(),folderName);
    fs.mkdirSync(patientDir,{recursive:true});
    const folders={};
    for(const name of FOLDERS){folders[name]=path.join(patientDir,name);fs.mkdirSync(folders[name],{recursive:true});}
    const selectedAt=new Date().toISOString();
    this.current={
      patientId,fileNo,fullName,firstName,
      gender:["male","female"].includes(String(payload.gender))?String(payload.gender):"",
      doctorName:String(payload.doctorName||""),clinicName:String(payload.clinicName||""),
      sessionId:String(payload.sessionId||crypto.randomUUID()),patientDir,folders,selectedAt
    };
    writeJson(path.join(patientDir,META_FILE),{
      schema:2,patientId,fileNo,fullName,firstName,gender:this.current.gender,
      doctorName:this.current.doctorName,clinicName:this.current.clinicName,
      linkedAt:(readJson(path.join(patientDir,META_FILE))||{}).linkedAt||selectedAt,lastSelectedAt:selectedAt
    });
    this.onState(this.snapshot());return this.snapshot();
  }
  clear(){this.current=null;this.onState(this.snapshot());return this.snapshot();}
  requirePatient(){if(!this.current)throw new Error("افتح ملف المريض في البرنامج الرئيسي أولًا");return this.current;}
  panoramaFolder(){return this.requirePatient().folders.Panorama;}
  listPanoramas(){
    const dir=this.panoramaFolder();
    return fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isFile()&&IMAGE_EXTENSIONS.has(path.extname(x.name).toLowerCase())).map(x=>{
      const filePath=path.join(dir,x.name),stat=fs.statSync(filePath);return{name:x.name,path:filePath,size:stat.size,modifiedAt:stat.mtimeMs,hash:hashFile(filePath)};
    }).sort((a,b)=>b.modifiedAt-a.modifiedAt);
  }
  importPanorama(source){
    this.requirePatient();if(!source||!fs.existsSync(source))throw new Error("ملف الصورة غير موجود");
    if(!IMAGE_EXTENSIONS.has(path.extname(source).toLowerCase()))throw new Error("صيغة الصورة غير مدعومة");
    const digest=hashFile(source),duplicate=this.listPanoramas().find(x=>x.hash===digest);
    if(duplicate)return{...duplicate,duplicate:true};
    const originalName=safePart(path.basename(source),"panorama.jpg");
    const destination=uniqueFile(this.panoramaFolder(),originalName);
    fs.copyFileSync(source,destination);
    const original=uniqueFile(this.current.folders.Originals,originalName);fs.copyFileSync(source,original);
    writeJson(`${destination}.meta.json`,{hash:digest,patientId:this.current.patientId,sessionId:this.current.sessionId,source,importedAt:new Date().toISOString(),originalPath:original});
    return{path:destination,name:path.basename(destination),hash:digest,duplicate:false};
  }
  plansDir(){return this.requirePatient().folders.TreatmentPlans;}
  savePlan(plan={}){
    const patient=this.requirePatient(),id=safePart(plan.id||`PLAN-${Date.now()}`),createdAt=plan.createdAt||new Date().toISOString();
    const normalized={...plan,id,schemaVersion:3,createdAt,updatedAt:new Date().toISOString(),sessionId:patient.sessionId,patient:{patientId:patient.patientId,fileNo:patient.fileNo,fullName:patient.fullName,firstName:patient.firstName,gender:patient.gender,doctorName:plan.doctorName||patient.doctorName,clinicName:patient.clinicName}};
    const dir=path.join(this.plansDir(),id);fs.mkdirSync(dir,{recursive:true});
    writeJson(path.join(dir,"plan.json"),normalized);
    writeJson(path.join(this.current.folders.Annotations,`${id}.annotations.json`),{planId:id,patientId:patient.patientId,panoramaPath:normalized.panoramaPath,annotations:normalized.annotations||[],savedAt:normalized.updatedAt});
    fs.writeFileSync(path.join(dir,"presentation.html"),this.planHtml(normalized),"utf8");
    return{...normalized,folder:dir};
  }
  listPlans(){
    const dir=this.plansDir();
    return fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>{
      try{const plan=JSON.parse(fs.readFileSync(path.join(dir,x.name,"plan.json"),"utf8"));return{id:plan.id,title:plan.title||"خطة علاج",createdAt:plan.createdAt,updatedAt:plan.updatedAt,totalCost:plan.totalCost,currency:plan.currency,stagesCount:plan.stages?.length||0};}catch{return null;}
    }).filter(Boolean).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  loadPlan(id){
    const file=path.join(this.plansDir(),safePart(id),"plan.json");
    if(!fs.existsSync(file))throw new Error("الخطة غير موجودة");return JSON.parse(fs.readFileSync(file,"utf8"));
  }
  exportComposite(dataUrl,name="annotated-panorama.png"){
    const patient=this.requirePatient();
    if(!/^data:image\/png;base64,/.test(String(dataUrl||"")))throw new Error("بيانات الصورة المدمجة غير صالحة");
    const file=uniqueFile(patient.folders.Exports,safePart(name,"annotated-panorama.png"));
    fs.writeFileSync(file,Buffer.from(dataUrl.split(",")[1],"base64"));return file;
  }
  planHtml(plan){
    const stages=Array.isArray(plan.stages)?plan.stages:[];
    const rows=stages.map((s,i)=>`<article style="border-right:8px solid ${html(s.color||"#0f82ff")}"><b>${i+1}. ${html(s.title)}</b><p>${html(s.description||s.notes||"")}</p><small>الأسنان: ${html((s.toothIds||s.teeth||[]).join("، ")||"—")} · الحالة: ${html(s.status||"مقترحة")}</small><strong>${html(s.sessions||1)} جلسة · ${html(s.duration||"")} · ${html(s.cost||0)} ${html(plan.currency||s.currency||"")}</strong></article>`).join("");
    return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>${html(plan.title||"خطة علاج")}</title><style>body{font-family:Tahoma,Arial;background:#071827;color:#eaf7ff;margin:0;padding:40px}main{max-width:1000px;margin:auto}.hero{padding:30px;border-radius:28px;background:linear-gradient(135deg,#0a9fc6,#173d78)}article{background:#0d2d47cc;margin:14px 0;padding:20px;border-radius:18px;border:1px solid #68cbff44}article b,article strong{display:block;font-size:20px}article strong{margin-top:12px;color:#bdf65d}.total{font-size:27px;background:#102e45;color:white;padding:22px;border-radius:18px}</style><main><section class="hero"><small>DENTAL CHAIN · خطة علاج بصرية</small><h1>${html(plan.patient?.fullName||"")}</h1><p>${html(plan.title||"خطة العلاج المقترحة")}</p></section>${rows}<div class="total">الإجمالي المتوقع: <b>${html(plan.totalCost||0)} ${html(plan.currency||"")}</b> · ${html(plan.totalSessions||0)} جلسة</div><p>${html(plan.closingNote||"")}</p></main></html>`;
  }
}
module.exports={PatientArchive,IMAGE_EXTENSIONS};
