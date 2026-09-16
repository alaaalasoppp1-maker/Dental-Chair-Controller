'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),mime=require('mime-types');
const {upload}=require('../shared/cloud-upload');
function inside(root,file){const relative=path.relative(root,file);return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
class CloudQueue {
  constructor({directory,origin,onNotice=()=>{},fetchImpl=fetch}) {
    this.file=path.join(directory,'cloud-upload-queue.json');this.origin=new URL(origin).origin;this.notice=onNotice;this.fetch=fetchImpl;this.session=null;this.generation=0;this.running=false;
    try{this.rows=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!Array.isArray(this.rows))throw new Error('invalid_cloud_queue');}catch(e){if(e.code!=='ENOENT')throw e;this.rows=[];}
    this.timer=setInterval(()=>void this.flush(),30000);this.timer.unref?.();
  }
  persist(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.rows),'utf8');fs.renameSync(tmp,this.file);}
  setSession(value){
    if(!value||typeof value.token!=='string'||value.token.length>16000||!value.uid||!value.clinicId){this.session=null;this.generation++;return;}
    const next={token:value.token,uid:String(value.uid),clinicId:String(value.clinicId),enabled:value.enabled===true,at:Date.now()};
    if(!this.session||JSON.stringify([this.session.uid,this.session.clinicId,this.session.enabled])!==JSON.stringify([next.uid,next.clinicId,next.enabled]))this.generation++;
    this.session=next;void this.flush();
  }
  enqueue(file,patient,category='attachments',planId=''){
    if(!patient?.clinicId||!patient.patientId||!patient.patientDir)return false;
    const root=fs.realpathSync(patient.patientDir),target=fs.realpathSync(file);
    if(!inside(root,target)||!fs.statSync(target).isFile())throw new Error('cloud_file_outside_patient');
    const size=fs.statSync(target).size;if(!size||size>100*1024*1024){this.notice('ملف الأرشيف يتجاوز حد الرفع 100 ميغا؛ بقي محفوظاً محلياً.','warning');return false;}
    const sha256=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    const spec={clinicId:patient.clinicId,patientId:patient.patientId,planId:String(planId||''),category,name:path.basename(file),mimeType:mime.lookup(file)||'application/octet-stream',size,sha256};
    if(spec.mimeType==='application/json')spec.mimeType='application/octet-stream';
    const key=crypto.createHash('sha256').update(JSON.stringify([spec.clinicId,spec.patientId,spec.planId,category,sha256])).digest('hex');
    if(this.rows.some(r=>r.key===key))return true;
    this.rows.push({key,file:target,root,spec,queuedAt:Date.now()});this.persist();void this.flush();return true;
  }
  enqueueArchive(patient,knownPlanIds=[]){
    const root=fs.realpathSync(patient.patientDir);let count=0;
    const scan=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink())continue;const target=path.join(dir,entry.name);if(entry.isDirectory()){scan(target);continue;}
      if(!/\.(png|jpe?g|webp|gif|bmp|tiff?|pdf|mp4|m4a|mp3|wav|webm|docx?|xlsx?|csv|txt|zip|dcm|sopix14)$/i.test(entry.name))continue;
      const parts=path.relative(root,target).split(path.sep),candidate=parts[0]==='AssistantSessions'?parts[1]||'':'',planId=knownPlanIds.includes(candidate)?candidate:'';
      const sidecar=target+'.json';let meta={};try{meta=JSON.parse(fs.readFileSync(sidecar,'utf8'));}catch{}
      const category=/xray|sensor|radiograph|panorama/i.test(parts[0]+' '+(meta.kind||''))?'xrays':/^image\//.test(mime.lookup(target)||'')?'photos':'attachments';
      if(this.enqueue(target,patient,category,planId))count++;
    }};scan(root);return {queued:count};
  }
  async flush(){
    const s=this.session,epoch=this.generation;if(this.running||!s?.enabled||Date.now()-s.at>90000)return;
    this.running=true;const active=()=>this.generation===epoch&&this.session?.enabled&&Date.now()-this.session.at<90000;
    try{
      for(const row of [...this.rows].filter(r=>r.spec.clinicId===s.clinicId)){
        if(!active())break;
        try{
          if(!inside(row.root,fs.realpathSync(row.file)))throw new Error('cloud_file_outside_patient');
          const bytes=fs.readFileSync(row.file);
          if(bytes.length!==row.spec.size||crypto.createHash('sha256').update(bytes).digest('hex')!==row.spec.sha256)throw new Error('cloud_original_changed');
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
