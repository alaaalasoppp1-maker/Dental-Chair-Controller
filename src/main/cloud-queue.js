'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),mime=require('mime-types');
function inside(root,file){const relative=path.relative(root,file);return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function portable(root,file){return path.relative(root,file).split(path.sep).filter(Boolean).slice(0,16).map(part=>part.slice(0,120)).join('/').slice(0,900);}
function readPatientManifest(dir){return manifestRows(dir).manifest;}
function categoryFor(relative,file){const value=String(relative||'').toLowerCase(),type=mime.lookup(file)||'';if(/treatmentplans|خطط العلاج/.test(value))return 'plans';if(/panorama|sensor|xray|radiograph|أشعة/.test(value))return 'xrays';return /^image\//.test(type)?'photos':'attachments';}
function matchPart(value){return String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[\u064B-\u065F\u0670]/g,'').replace(/[\s_\-–—]+/g,' ').replace(/[^\p{L}\p{N}+ ]/gu,'').trim();}
function sameValue(a,b){const x=matchPart(a),y=matchPart(b);return Boolean(x&&y&&x===y);}
function normalizePhone(value){return String(value||'').trim().replace(/[^\d+]/g,'').replace(/^00/,'+');}
function phoneTail(value){return normalizePhone(value).replace(/\D/g,'').slice(-8);}
function samePhone(a,b){const x=normalizePhone(a),y=normalizePhone(b);if(!x||!y)return false;if(x===y)return true;const xt=phoneTail(x),yt=phoneTail(y);return xt.length>=8&&yt.length>=8&&xt===yt;}
function patientIdOf(row){return String(row?.id||row?.patientId||'').trim();}
function patientFileNo(row){return String(row?.fileNo||row?.fileNumber||'').trim();}
function patientName(row){return String(row?.fullName||row?.name||'').trim();}
function patientPhone(row){return String(row?.phone||row?.mobile||'').trim();}
function legacyEvidence(patientDir,manifest,patient){
  const folder=path.basename(patientDir),pid=patientIdOf(patient),pFileNo=patientFileNo(patient),pName=patientName(patient),pPhone=patientPhone(patient);
  const oldId=String(manifest?.patientId||manifest?.id||'').trim(),oldFileNo=String(manifest?.fileNo||manifest?.fileNumber||'').trim(),oldName=String(manifest?.fullName||manifest?.name||'').trim(),oldPhone=String(manifest?.phone||manifest?.mobile||'').trim();
  const idExact=Boolean(oldId&&pid&&oldId===pid),fileNoExact=Boolean(oldFileNo&&pFileNo&&sameValue(oldFileNo,pFileNo)),nameExact=Boolean(oldName&&pName&&sameValue(oldName,pName)),phoneExact=Boolean(oldPhone&&pPhone&&samePhone(oldPhone,pPhone));
  const folderExact=Boolean(pFileNo&&pName)&&(sameValue(folder,`${pFileNo} - ${pName}`)||sameValue(folder,`${pName} - ${pFileNo}`)||sameValue(folder,`${pFileNo} ${pName}`)||sameValue(folder,`${pName} ${pFileNo}`));
  const fileConflict=Boolean(oldFileNo&&pFileNo&&!sameValue(oldFileNo,pFileNo)),phoneConflict=Boolean(oldPhone&&pPhone&&!samePhone(oldPhone,pPhone));
  let strong=false,method='';
  if(idExact&&!fileConflict&&!phoneConflict){strong=true;method='patientId';}
  else if(fileNoExact&&(nameExact||phoneExact||folderExact)){strong=true;method=nameExact?'fileNo+name':phoneExact?'fileNo+phone':'folder+fileNo+name';}
  else if(phoneExact&&nameExact){strong=true;method='phone+name';}
  else if(folderExact){strong=true;method='folder+fileNo+name';}
  const weak=idExact||fileNoExact||phoneExact||nameExact||folderExact;
  const score=(idExact?100:0)+(fileNoExact?40:0)+(phoneExact?30:0)+(nameExact?20:0)+(folderExact?35:0)-(fileConflict?80:0)-(phoneConflict?60:0);
  return {strong,weak,method,score,idExact,fileNoExact,nameExact,phoneExact,folderExact,fileConflict,phoneConflict};
}
function writeJsonAtomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');fs.renameSync(tmp,file);}
function manifestRows(dir){
  const rows=[];
  for(const name of ['patient.json','_patient.json','.dtdc-patient.json']){
    const file=path.join(dir,name);if(!fs.existsSync(file))continue;
    try{const row=JSON.parse(fs.readFileSync(file,'utf8'));if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('invalid');rows.push({name,row});}catch{throw new Error('invalid_patient_manifest');}
  }
  const identities=new Set(rows.filter(x=>x.row.clinicId&&(x.row.patientId||x.row.id)).map(x=>JSON.stringify([String(x.row.clinicId),String(x.row.patientId||x.row.id)])));
  if(identities.size>1)throw new Error('conflicting_patient_manifest');
  const chosen=rows.find(x=>x.row.clinicId&&(x.row.patientId||x.row.id))||rows[0]||null;
  return {manifest:chosen?.row||null,rows};
}
class CloudQueue{
  constructor({directory,onNotice=()=>{},google}){this.file=path.join(directory,'cloud-upload-queue.json');this.tempDir=path.join(directory,'cloud-upload-cache');this.notice=onNotice;this.google=google;this.session=null;this.generation=0;this.running=false;try{this.rows=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!Array.isArray(this.rows))throw new Error('invalid_cloud_queue');}catch(e){if(e.code!=='ENOENT')throw e;this.rows=[];}this.timer=setInterval(()=>void this.flush(),30000);this.timer.unref?.();}
  persist(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.rows),'utf8');fs.renameSync(tmp,this.file);}
  setSession(value){this.google?.setSession(value);if(!value||typeof value.token!=='string'||value.token.length>16000||!value.uid||!value.clinicId){this.session=null;this.generation++;return;}const next={...value,token:String(value.token),uid:String(value.uid),clinicId:String(value.clinicId),role:String(value.role||''),projectId:String(value.projectId||''),enabled:value.enabled===true,at:Date.now()};if(!this.session||JSON.stringify([this.session.uid,this.session.clinicId,this.session.role,this.session.enabled,this.session.projectId])!==JSON.stringify([next.uid,next.clinicId,next.role,next.enabled,next.projectId]))this.generation++;this.session=next;void this.flush();}
  makeSpec(file,patient,category='attachments',planId=''){const root=fs.realpathSync(patient.patientDir),target=fs.realpathSync(file);if(!inside(root,target)||!fs.statSync(target).isFile())throw new Error('cloud_file_outside_patient');const stat=fs.statSync(target),size=stat.size;if(!size||size>100*1024*1024){this.notice('ملف الأرشيف يتجاوز حد الرفع 100 ميغا؛ بقي محفوظاً محلياً.','warning');return null;}const sha256=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),relativePath=portable(root,target);const spec={clinicId:String(patient.clinicId),patientId:String(patient.patientId),planId:String(planId||''),category,name:path.basename(file),relativePath,mimeType:mime.lookup(file)||'application/octet-stream',size,sha256};if(spec.mimeType==='application/json'||!/^[-\w.+]+\/[-\w.+]+$/i.test(spec.mimeType))spec.mimeType='application/octet-stream';return {root,target,spec};}
  enqueue(file,patient,category='attachments',planId=''){if(!patient?.clinicId||!patient.patientId||!patient.patientDir)return false;const made=this.makeSpec(file,patient,category,planId);if(!made)return false;const {root,target,spec}=made,key=crypto.createHash('sha256').update(JSON.stringify([spec.clinicId,spec.patientId,spec.planId,category,spec.sha256])).digest('hex');if(this.rows.some(r=>r.key===key))return true;this.rows.push({key,file:target,root,spec,queuedAt:Date.now(),offset:0,sessionUrl:''});this.persist();void this.flush();return true;}
  enqueueBytes(bytes,spec){const data=Buffer.from(bytes);if(!data.length||data.length>100*1024*1024)throw new Error('file_size');const sha256=spec.sha256||crypto.createHash('sha256').update(data).digest('hex');if(spec.sha256&&sha256!==crypto.createHash('sha256').update(data).digest('hex'))throw new Error('upload_hash_mismatch');fs.mkdirSync(this.tempDir,{recursive:true});const key=crypto.createHash('sha256').update(JSON.stringify([spec.clinicId,spec.patientId,spec.planId||'',spec.category||'attachments',sha256])).digest('hex');if(this.rows.some(r=>r.key===key))return {queued:false,existing:true,key};const target=path.join(this.tempDir,key+'.bin');fs.writeFileSync(target,data);this.rows.push({key,file:target,root:this.tempDir,temp:true,spec:{...spec,sha256,size:data.length,mimeType:spec.mimeType||'application/octet-stream',name:spec.name||'attachment'},queuedAt:Date.now(),offset:0,sessionUrl:''});this.persist();void this.flush();return {queued:true,key};}
  enqueueArchive(patient,knownPlanIds=[]){const root=fs.realpathSync(patient.patientDir);let files=0,queued=0,existing=0,oversized=0;const scan=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const target=path.join(dir,entry.name);if(entry.isDirectory()){if(!entry.name.endsWith('.tmp'))scan(target);continue;}if(!entry.isFile()||/\.tmp$/i.test(entry.name)||/^~\$/.test(entry.name))continue;files++;const relative=portable(root,target),parts=relative.split('/'),candidate=/^(AssistantSessions|09 - جلسات المساعد)$/i.test(parts[0])?parts[1]||'':'',planId=knownPlanIds.includes(candidate)?candidate:'',category=categoryFor(relative,target),before=this.rows.length,result=this.enqueue(target,patient,category,planId);if(result){if(this.rows.length>before)queued++;else existing++;}else if(fs.statSync(target).size>100*1024*1024)oversized++;}};scan(root);return {files,queued,existing,oversized};}
  async migrateLegacyIdentities(rootDir){
    const session=this.session;
    if(!session?.uid||!session.clinicId||!session.projectId)throw new Error('session_changed');
    if(!['manager','super_owner'].includes(session.role))throw new Error('role_denied');
    if(Date.now()-session.at>90000)throw new Error('session_changed');
    if(!this.google?.listPatients)throw new Error('patient_registry_unavailable');
    const root=fs.realpathSync(rootDir),patients=(await this.google.listPatients(session.clinicId)).map(row=>({...row,id:patientIdOf(row)})).filter(row=>patientIdOf(row));
    const stats={scanned:0,alreadyIdentified:0,legacy:0,migrated:0,needsReview:0,noCandidate:0,otherClinic:0,conflicts:0,rows:[]};
    const claimed=new Map(),directories=fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()&&!entry.name.startsWith('.'));
    const bundles=new Map();
    for(const entry of directories){
      const patientDir=path.join(root,entry.name);stats.scanned++;
      try{
        const bundle=manifestRows(patientDir);bundles.set(patientDir,bundle);
        const complete=bundle.rows.map(x=>x.row).filter(row=>row.clinicId&&(row.patientId||row.id));
        if(complete.length){
          const current=complete[0],clinicId=String(current.clinicId||''),patientId=String(current.patientId||current.id||'');
          if(clinicId===session.clinicId){
            if(claimed.has(patientId)&&claimed.get(patientId)!==patientDir){
              stats.conflicts++;stats.rows.push({folder:entry.name,status:'conflict',reason:'duplicate_identified_patient',patientId});
            }else claimed.set(patientId,patientDir);
            stats.alreadyIdentified++;
          }else stats.otherClinic++;
        }
      }catch{
        stats.conflicts++;stats.rows.push({folder:entry.name,status:'conflict',reason:'conflicting_or_invalid_manifest'});
      }
    }
    for(const entry of directories){
      const patientDir=path.join(root,entry.name),bundle=bundles.get(patientDir);if(!bundle)continue;
      const allRows=bundle.rows.map(x=>x.row),manifest=bundle.manifest||{};
      if(allRows.some(row=>row.clinicId&&(row.patientId||row.id)))continue;
      if(allRows.some(row=>row.clinicId&&String(row.clinicId)!==session.clinicId)){stats.otherClinic++;continue;}
      stats.legacy++;
      const scored=patients.map(patient=>({patient,evidence:legacyEvidence(patientDir,manifest,patient)}));
      const matches=scored.filter(x=>x.evidence.strong).sort((a,b)=>b.evidence.score-a.evidence.score);
      const weak=scored.filter(x=>x.evidence.weak).sort((a,b)=>b.evidence.score-a.evidence.score);
      const best=matches[0],sameTop=best?matches.filter(x=>x.evidence.score===best.evidence.score):[];
      if(!best){
        if(weak.length){stats.needsReview++;stats.rows.push({folder:entry.name,status:'review',reason:'weak_match_only',fileNo:String(manifest.fileNo||manifest.fileNumber||''),name:String(manifest.fullName||manifest.name||''),candidates:weak.slice(0,4).map(x=>({patientId:patientIdOf(x.patient),fileNo:patientFileNo(x.patient),name:patientName(x.patient)}))});}
        else{stats.noCandidate++;stats.rows.push({folder:entry.name,status:'no_candidate',reason:'no_safe_match',fileNo:String(manifest.fileNo||manifest.fileNumber||''),name:String(manifest.fullName||manifest.name||'')});}
        continue;
      }
      if(sameTop.length!==1){
        stats.needsReview++;stats.rows.push({folder:entry.name,status:'review',reason:'ambiguous_strong_match',fileNo:String(manifest.fileNo||manifest.fileNumber||''),name:String(manifest.fullName||manifest.name||''),candidates:sameTop.slice(0,4).map(x=>({patientId:patientIdOf(x.patient),fileNo:patientFileNo(x.patient),name:patientName(x.patient)}))});continue;
      }
      const patient=best.patient,patientId=patientIdOf(patient);
      if(claimed.has(patientId)&&claimed.get(patientId)!==patientDir){
        stats.needsReview++;stats.rows.push({folder:entry.name,status:'review',reason:'patient_already_has_archive',patientId,fileNo:patientFileNo(patient),name:patientName(patient)});continue;
      }
      const migratedAt=new Date().toISOString(),backup=path.join(patientDir,'.dtdc-legacy-patient.json');
      if(!fs.existsSync(backup))writeJsonAtomic(backup,{...(manifest||{}),backedUpAt:migratedAt,archiveFolder:entry.name,manifestSources:bundle.rows.map(x=>x.name)});
      const next={...(manifest||{}),schema:'dtdc-patient-archive-v4',clinicId:session.clinicId,patientId,fileNo:patientFileNo(patient)||String(manifest.fileNo||manifest.fileNumber||''),name:patientName(patient)||String(manifest.name||manifest.fullName||''),fullName:patientName(patient)||String(manifest.fullName||manifest.name||''),phone:patientPhone(patient)||String(manifest.phone||manifest.mobile||''),identityMigratedAt:migratedAt,identityMigrationMethod:best.evidence.method,identityMigrationSource:'bulk-safe-match'};
      writeJsonAtomic(path.join(patientDir,'patient.json'),next);claimed.set(patientId,patientDir);stats.migrated++;
      stats.rows.push({folder:entry.name,status:'migrated',reason:best.evidence.method,patientId,fileNo:next.fileNo,name:next.fullName});
      if(stats.migrated%20===0)await new Promise(resolve=>setImmediate(resolve));
    }
    return stats;
  }
  async enqueueAllArchives(rootDir){const session=this.session;if(!session?.enabled)throw new Error('cloud_not_enabled');if(!['manager','super_owner'].includes(session.role))throw new Error('role_denied');if(Date.now()-session.at>90000)throw new Error('session_changed');const migration=this.google?.listPatients?await this.migrateLegacyIdentities(rootDir):{migrated:0,needsReview:0,noCandidate:0,conflicts:0,rows:[]},root=fs.realpathSync(rootDir),stats={patients:0,files:0,queued:0,existing:0,oversized:0,noIdentity:0,otherClinic:0,conflicts:0,autoLinked:migration.migrated||0,needsReview:migration.needsReview||0,noCandidate:migration.noCandidate||0,identityMigration:migration};let touched=0;for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink()||entry.name.startsWith('.'))continue;const patientDir=path.join(root,entry.name);let manifest;try{manifest=readPatientManifest(patientDir);}catch{stats.conflicts++;continue;}const clinicId=String(manifest?.clinicId||''),patientId=String(manifest?.patientId||manifest?.id||'');if(!clinicId||!patientId){stats.noIdentity++;continue;}if(clinicId!==session.clinicId){stats.otherClinic++;continue;}const result=this.enqueueArchive({clinicId,patientId,patientDir},[]);stats.patients++;for(const key of ['files','queued','existing','oversized'])stats[key]+=result[key]||0;if((touched+=result.files)>=20){touched=0;await new Promise(resolve=>setImmediate(resolve));}}void this.flush();return stats;}
  summary(clinicId=''){const rows=this.rows.filter(r=>!clinicId||r.spec?.clinicId===clinicId);return {count:rows.length,bytes:rows.reduce((s,r)=>s+Number(r.spec?.size||0),0),rows:rows.map(r=>({name:r.spec?.name,status:r.lastError?'retry':'pending',lastError:r.lastError||'',offset:r.offset||0,size:r.spec?.size||0}))};}
  async flush(){const s=this.session,epoch=this.generation;if(this.running||!s?.enabled||Date.now()-s.at>90000||!this.google?.status().connected)return;this.running=true;const active=()=>this.generation===epoch&&this.session?.enabled&&Date.now()-this.session.at<90000;try{for(const row of [...this.rows].filter(r=>r.spec.clinicId===s.clinicId)){if(!active())break;try{if(!fs.existsSync(row.file)){this.rows=this.rows.filter(r=>r.key!==row.key);this.persist();continue;}if(!row.temp&&!inside(row.root,fs.realpathSync(row.file)))throw new Error('cloud_file_outside_patient');const stat=fs.statSync(row.file);if(stat.size!==row.spec.size){this.rows=this.rows.filter(r=>r.key!==row.key);this.persist();if(!row.temp)this.enqueue(row.file,{clinicId:row.spec.clinicId,patientId:row.spec.patientId,patientDir:row.root},row.spec.category,row.spec.planId);continue;}if(!row.sessionUrl){row.sessionUrl=await this.google.beginUpload(row.spec);row.offset=0;this.persist();}const fd=fs.openSync(row.file,'r');try{while((row.offset||0)<row.spec.size){if(!active())throw Object.assign(new Error('session_changed'),{code:'session_changed'});const start=row.offset||0,len=Math.min(4*1024*1024,row.spec.size-start),chunk=Buffer.allocUnsafe(len),read=fs.readSync(fd,chunk,0,len,start),result=await this.google.uploadChunk(row.sessionUrl,chunk.subarray(0,read),start,row.spec.size,row.spec.mimeType);row.offset=result.next;this.persist();if(result.done){await this.google.putMedia(row.spec,result.file.id,'uploaded');row.offset=row.spec.size;break;}}}finally{fs.closeSync(fd);}this.rows=this.rows.filter(r=>r.key!==row.key);this.persist();if(row.temp)try{fs.unlinkSync(row.file);}catch{}this.notice('تم حفظ نسخة من ملف الأرشيف على Google Drive.','success');}catch(e){if([404,410].includes(e.status)){row.sessionUrl='';row.offset=0;}row.lastError=e.code||e.message;row.attempts=(row.attempts||0)+1;this.persist();this.notice('رفع الأرشيف معلّق؛ النسخة المحلية محفوظة وسيُعاد المحاولة.','warning');if([401,403].includes(e.status)||!active())break;}}}finally{this.running=false;}}
  close(){clearInterval(this.timer);this.setSession(null);}
}
module.exports={CloudQueue,inside};
