'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {CloudQueue}=require('../src/main/cloud-queue');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dtdc-cloud-test-')),patient={clinicId:'A',patientId:'same',patientDir:path.join(root,'patient-A')};fs.mkdirSync(patient.patientDir);const file=path.join(patient.patientDir,'xray.png');fs.writeFileSync(file,Buffer.from('synthetic-only'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,patient,file};}
const finished=async q=>{while(q.running)await new Promise(r=>setImmediate(r));};
test('the queue survives restart, stores no token and resumes only for its clinic',async t=>{
  const f=setup(t),calls=[];let q=new CloudQueue({directory:f.root,origin:'https://clinic.invalid',fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'done',offset:14,complete:true,media:{id:'done'}})};}});t.after(()=>q.close());
  q.enqueue(f.file,f.patient,'xrays');q.enqueue(f.file,f.patient,'xrays');assert.equal(q.rows.length,1);q.close();q=new CloudQueue({directory:f.root,origin:'https://clinic.invalid',fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({complete:true,offset:14,media:{id:'done'}})};}});
  q.setSession({uid:'u',clinicId:'B',token:'must-not-be-on-disk',enabled:true});await finished(q);assert.equal(calls.length,0);
  q.setSession({uid:'u',clinicId:'A',token:'must-not-be-on-disk',enabled:true});await finished(q);assert.equal(calls.length,1);assert.equal(q.rows.length,0);assert.equal(fs.readFileSync(f.file,'utf8'),'synthetic-only');assert(!fs.readFileSync(q.file,'utf8').includes('must-not-be-on-disk'));
});
test('network failure, source changes and symlink escapes retain the original and pending record',async t=>{
  const f=setup(t),q=new CloudQueue({directory:f.root,origin:'https://clinic.invalid',fetchImpl:async()=>({ok:false,status:403,json:async()=>({error:'account_disabled'})})});t.after(()=>q.close());q.enqueue(f.file,f.patient);q.setSession({uid:'u',clinicId:'A',token:'fixture',enabled:true});await finished(q);assert.equal(q.rows.length,1);assert.equal(q.rows[0].lastError,'account_disabled');
  fs.writeFileSync(f.file,'changed-original');await q.flush();assert.equal(q.rows[0].lastError,'cloud_original_changed');assert.equal(fs.readFileSync(f.file,'utf8'),'changed-original');
  const outside=path.join(f.root,'outside.png');fs.writeFileSync(outside,'outside');const link=path.join(f.patient.patientDir,'escape.png');try{fs.symlinkSync(outside,link);}catch(e){if(e.code==='EPERM')return;throw e;}assert.throws(()=>q.enqueue(link,f.patient),/outside_patient/);
});
test('corrupt queue data is preserved for recovery, never silently replaced',t=>{const f=setup(t),file=path.join(f.root,'cloud-upload-queue.json');fs.writeFileSync(file,'{"incomplete":');assert.throws(()=>new CloudQueue({directory:f.root,origin:'https://clinic.invalid'}));assert.equal(fs.readFileSync(file,'utf8'),'{"incomplete":');});
