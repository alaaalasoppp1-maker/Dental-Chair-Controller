'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),mime=require('mime-types');
const {upload}=require('../shared/cloud-upload');
function inside(root,file){const relative=path.relative(root,file);return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function portable(root,file){return path.relative(root,file).split(path.sep).filter(Boolean).slice(0,16).map(part=>part.slice(0,120)).join('/').slice(0,900);}
function readPatientManifest(dir){
  const rows=[];for(const name of ['patient.json','_patient.json','.dtdc-patient.json']){const file=path.join(dir,name);if(!fs.existsSync(file))continue;try{const row=JSON.parse(fs.readFileSync(file,'utf8'));if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('invalid');rows.push(row);}catch{throw new Error('invalid_patient_manifest');}}
  const identities=new Set(rows.filter(row=>row.clinicId&&(row.patientId||row.id)).map(row=>JSON.stringify([String(row.clinicId),String(row.patientId||row.id)])));if(identities.size>1)throw new Error('conflicting_patient_manifest');return rows.find(row=>row.clinicId&&(row.patientId||row.id))||rows[0]||null;
}
function categoryFor(relative,file){const value=String(relative||'').toLowerCase(),type=mime.lookup(file)||'';if(/treatmentplans|خطط العلاج/.test(value))return 'plans';if(/panorama|sensor|xray|radiograph|أشعة/.test(value))return 'xrays';return /^image\//.test(type)?'photos':'attachments';}
class CloudQueue {
  constructor({directory,origin,onNotice=()=>{},fetchImpl=fetch}) {
    this.file=path.join(directory,'cloud-upload-queue.json');this.origin=new URL(origin).origin;this.notice=onNotice;this.fetch=fetchImpl;this.session=null;this.generation=0;this.running=false;
    try{this.rows=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!Array.isArray(this.rows))throw new Error('invalid_cloud_queue');}catch(e){if(e.code!=='ENOENT')throw e;this.rows=[];}
    this.timer=setInterval(()=>void this.flush(),30000);this.timer.unref?.();
  }
  persist(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.rows),'utf8');fs.renameSync(tmp,this.file);}
  setSession(value){
    if(!value||typeof value.token!=='string'||value.token.length>16000||!value.uid||!value.clinicId){this.session=null;this.generation++;return;}
    const next={token:value.token,uid:String(value.uid),clinicId:String(value.clinicId),role:String(value.role||''),enabled:value.enabled===true,at:Date.now()};
    if(!this.session||JSON.stringify([this.session.uid,this.session.clinicId,this.session.role,this.session.enabled])!==JSON.stringify([next.uid,next.clinicId,next.role,next.enabled]))this.generation++;
    this.session=next;void this.flush();
  }
  enqueue(file,patient,category='attachments',planId=''){
    if(!patient?.clinicId||!patient.patientId||!patient.patientDir)return false;
    const root=fs.realpathSync(patient.patientDir),target=fs.realpathSync(file);
    if(!inside(root,target)||!fs.statSync(target).isFile())throw new Error('cloud_file_outside_patient');
    const size=fs.statSync(target).size;if(!size||size>100*1024*1024){this.notice('ملف الأرشيف يتجاوز حد الرفع 100 ميغا؛ بقي محفوظاً محلياً.','warning');return false;}
    const sha256=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),relativePath=portable(root,target);
    const spec={clinicId:patient.clinicId,patientId:patient.patientId,planId:String(planId||''),category,name:path.basename(file),relativePath,mimeType:mime.lookup(file)||'application/octet-stream',size,sha256};
    if(spec.mimeType==='application/json'||!/^[-\w.+]+\/[-\w.+]+$/i.test(spec.mimeType))spec.mimeType='application/octet-stream';
    const key=crypto.createHash('sha256').update(JSON.stringify([spec.clinicId,spec.patientId,spec.planId,category,sha256])).digest('hex');
    if(this.rows.some(r=>r.key===key))return true;
    this.rows.push({key,file:target,root,spec,queuedAt:Date.now()});this.persist();void this.flush();return true;
  }
  enqueueArchive(patient,knownPlanIds=[]){
    const root=fs.realpathSync(patient.patientDir);let files=0,queued=0,existing=0,oversized=0;
    const scan=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink())continue;const target=path.join(dir,entry.name);if(entry.isDirectory()){if(!entry.name.endsWith('.tmp'))scan(target);continue;}
      if(!entry.isFile()||/\.tmp$/i.test(entry.name)||/^~\$/.test(entry.name))continue;files++;const relative=portable(root,target);
      const parts=relative.split('/'),candidate=/^(AssistantSessions|09 - جلسات المساعد)$/i.test(parts[0])?parts[1]||'':'',planId=knownPlanIds.includes(candidate)?candidate:'';
      const category=categoryFor(relative,target),before=this.rows.length,result=this.enqueue(target,patient,category,planId);
      if(result){if(this.rows.length>before)queued++;else existing++;}else if(fs.statSync(target).size>100*1024*1024)oversized++;
    }};scan(root);return {files,queued,existing,oversized};
  }
  async enqueueAllArchives(rootDir){
    const session=this.session;if(!session?.enabled)throw new Error('cloud_not_enabled');if(!['manager','super_owner'].includes(session.role))throw new Error('role_denied');if(Date.now()-session.at>90000)throw new Error('session_changed');const root=fs.realpathSync(rootDir);
    const stats={patients:0,files:0,queued:0,existing:0,oversized:0,noIdentity:0,otherClinic:0,conflicts:0};let touched=0;
    for(const entry of fs.readdirSync(root,{withFileTypes:true})){
      if(!entry.isDirectory()||entry.isSymbolicLink())continue;const patientDir=path.join(root,entry.name);let manifest;try{manifest=readPatientManifest(patientDir);}catch{stats.conflicts++;continue;}
      const clinicId=String(manifest?.clinicId||''),patientId=String(manifest?.patientId||manifest?.id||'');if(!clinicId||!patientId){stats.noIdentity++;continue;}if(clinicId!==session.clinicId){stats.otherClinic++;continue;}
      const result=this.enqueueArchive({clinicId,patientId,patientDir},[]);stats.patients++;for(const key of ['files','queued','existing','oversized'])stats[key]+=result[key]||0;
      if((touched+=result.files)>=20){touched=0;await new Promise(resolve=>setImmediate(resolve));}
    }
    void this.flush();return stats;
  }
  async flush(){
    const s=this.session,epoch=this.generation;if(this.running||!s?.enabled||Date.now()-s.at>90000)return;
    this.running=true;const active=()=>this.generation===epoch&&this.session?.enabled&&Date.now()-this.session.at<90000;
    try{
      for(const row of [...this.rows].filter(r=>r.spec.clinicId===s.clinicId)){
        if(!active())break;
        try{
          if(!fs.existsSync(row.file)){this.rows=this.rows.filter(r=>r.key!==row.key);this.persist();continue;}
          if(!inside(row.root,fs.realpathSync(row.file)))throw new Error('cloud_file_outside_patient');
          const bytes=fs.readFileSync(row.file),currentHash=crypto.createHash('sha256').update(bytes).digest('hex');
          if(bytes.length!==row.spec.size||currentHash!==row.spec.sha256){
            this.rows=this.rows.filter(r=>r.key!==row.key);this.persist();this.enqueue(row.file,{clinicId:row.spec.clinicId,patientId:row.spec.patientId,patientDir:row.root},row.spec.category,row.spec.planId);continue;
          }
          const api=async(route,options)=>{
            if(!active())throw Object.assign(new Error('session_changed'),{status:403});
            const r=await this.fetch(this.origin+'/api/dtdc'+route,{method:options.method,headers:{...options.headers,Authorization:'Bearer '+this.session.token,...(options.json?{'Content-Type':'application/json'}:{})},body:options.json?JSON.stringify(options.json):options.body,signal:AbortSignal.timeout(65000)});
            let data;try{data=await r.json();}catch{throw Object.assign(new Error('cloud_not_configured'),{status:404});}
            if(!r.ok)throw Object.assign(new Error(data.error),{code:data.error,status:r.status});return data;
          };
          await upload({spec:row.spec,readChunk:(start,end)=>bytes.subarray(start,end),api,active});
          this.rows=this.rows.filter(r=>r.key!==row.key);this.persist();
          this.notice('تم حفظ نسخة من ملف الأرشيف على السحابة.','success');
        }catch(e){row.lastError=e.code||e.message;this.persist();this.notice('رفع الأرشيف معلّق؛ الملف الأصلي محفوظ. افتح البرنامج الرئيسي داخل الكونترولر لتأكيد الربط.','warning');if([401,403,404].includes(e.status)||!active())break;}
      }
    }finally{this.running=false;}
  }
  close(){clearInterval(this.timer);this.setSession(null);}
}
module.exports={CloudQueue,inside};
