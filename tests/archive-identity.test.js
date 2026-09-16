'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PatientArchive}=require('../src/main/patient-archive'),identity=require('../src/shared/archive-identity');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dtdc-identity-'));return{root,archive:new PatientArchive({app:{getPath:()=>root},settings:{get:()=>root,patch(){}},onNotice(){}}),close(){fs.rmSync(root,{recursive:true,force:true})}}}
test('identical file numbers and patient names in two clinics never select the same directory',()=>{
 const f=fixture();try{
  const base={patientId:'p',fileNo:'0001',fullName:'Same name'};
  const a=f.archive.select({...base,clinicId:'A'});fs.writeFileSync(path.join(a.folders.Photos,'original.jpg'),'original');
  const b=f.archive.select({...base,clinicId:'B'});assert.notEqual(a.patientDir,b.patientDir);assert.equal(fs.readdirSync(b.folders.Photos).length,0);
  const renamed=f.archive.select({...base,clinicId:'A',fullName:'Changed name'});assert.equal(renamed.patientDir,a.patientDir);assert.equal(renamed.fullName,'Changed name');assert.equal(fs.readFileSync(path.join(renamed.folders.Photos,'original.jpg'),'utf8'),'original');
  assert.throws(()=>f.archive.select({...base,clinicId:'B',patientDir:a.patientDir}),/هوية/);
 }finally{f.close()}
});
test('one strongly matching legacy folder is adopted in place without losing its files',()=>{
 const f=fixture();try{
  const legacy=path.join(f.root,'0001 - Same name');fs.mkdirSync(legacy);fs.mkdirSync(path.join(legacy,'06 - صور فوتوغرافية'));fs.writeFileSync(path.join(legacy,'06 - صور فوتوغرافية','old.jpg'),'old');
  fs.writeFileSync(path.join(legacy,'patient.json'),JSON.stringify({patientId:'old-local-id',fileNo:'0001',fullName:'Same name',legacyField:'keep'}));
  assert.throws(()=>f.archive.select({clinicId:'A',patientId:'uuid-new',fileNo:'0001',fullName:'Same name'}),/legacy_archive_bind_required/);
  const selected=f.archive.select({clinicId:'A',patientId:'uuid-new',fileNo:'0001',fullName:'Same name',allowLegacyBind:true});
  assert.equal(selected.patientDir,legacy);assert.equal(fs.readFileSync(path.join(selected.folders.Photos,'old.jpg'),'utf8'),'old');
  const manifest=JSON.parse(fs.readFileSync(path.join(legacy,'patient.json'),'utf8'));assert.equal(manifest.clinicId,'A');assert.equal(manifest.patientId,'uuid-new');assert.equal(manifest.legacyField,'keep');assert.ok(manifest.identityMigratedAt);
  const backup=JSON.parse(fs.readFileSync(path.join(legacy,'.dtdc-legacy-patient.json'),'utf8'));assert.equal(backup.patientId,'old-local-id');
  const again=f.archive.select({clinicId:'A',patientId:'uuid-new',fileNo:'0001',fullName:'Renamed later'});assert.equal(again.patientDir,legacy);
 }finally{f.close()}
});
test('legacy number-only folders stay untouched; missing or duplicate identities require review',()=>{
 const f=fixture();try{
  const legacy=path.join(f.root,'0001 - old');fs.mkdirSync(legacy);const original=JSON.stringify({patientId:'old',fileNo:'0001',fullName:'Old'});fs.writeFileSync(path.join(legacy,'patient.json'),original);
  assert.throws(()=>f.archive.select({clinicId:'A',patientId:'p',fileNo:'0001',fullName:'New'}),/مراجعة ربط/);assert.equal(fs.readdirSync(f.root).length,1);assert.equal(fs.readFileSync(path.join(legacy,'patient.json'),'utf8'),original);
  const next=f.archive.select({clinicId:'A',patientId:'p',fileNo:'0002',fullName:'New'});assert.notEqual(next.patientDir,legacy);
  assert.throws(()=>f.archive.select({patientId:'p',fileNo:'0001'}),/identity/);
  const duplicate=path.join(f.root,'copy');fs.mkdirSync(duplicate);fs.copyFileSync(path.join(next.patientDir,'patient.json'),path.join(duplicate,'patient.json'));
  assert.throws(()=>f.archive.select({clinicId:'A',patientId:'p'}),/مجلدان/);
 }finally{f.close()}
});
test('conflicting archive manifests stop selection and an interrupted empty folder remains usable',()=>{
 const f=fixture();try{
  const key=identity.folderKeySync({clinicId:'A',patientId:'p'}),reserved=path.join(f.root,key);fs.mkdirSync(reserved);
  const selected=f.archive.select({clinicId:'A',patientId:'p'});assert.equal(selected.patientDir,reserved);
  const canonical=fs.readFileSync(path.join(reserved,'patient.json'),'utf8');fs.writeFileSync(path.join(reserved,'_patient.json'),JSON.stringify({clinicId:'B',patientId:'p'}));
  assert.throws(()=>f.archive.select({clinicId:'A',patientId:'p'}),/متعارضة/);assert.equal(fs.readFileSync(path.join(reserved,'patient.json'),'utf8'),canonical);
  fs.writeFileSync(path.join(reserved,'_patient.json'),'{broken');assert.throws(()=>f.archive.select({clinicId:'A',patientId:'p'}),/تعذر التحقق/);
 }finally{f.close()}
});
test('a media directory symlink cannot redirect writes into another patient or outside the root',()=>{
 const f=fixture();try{
  const a=f.archive.select({clinicId:'A',patientId:'p'}),outside=path.join(f.root,'unrelated');fs.mkdirSync(outside);fs.rmSync(a.folders.Photos,{recursive:true});fs.symlinkSync(outside,a.folders.Photos,'dir');
  assert.throws(()=>f.archive.select({clinicId:'A',patientId:'p'}),/خارج/);assert.equal(fs.readdirSync(outside).length,0);
 }finally{f.close()}
});
test('shared identifiers are case-sensitive, independent of names, and safe as paths',async()=>{
 const a={clinicId:'A',patientId:'../patient'},b={clinicId:'a',patientId:'../patient'};
 assert.match(await identity.folderKey(a),/^dtdc-[a-f0-9]{64}$/);assert.notEqual(identity.folderKeySync(a),identity.folderKeySync(b));assert.equal(identity.matches(a,b),false);
});
test('archived progress restores its timestamp but cannot override a newer correction from the main program',()=>{
 const f=fixture();try{
  const p=f.archive.select({clinicId:'A',patientId:'p'});
  f.archive.saveAssistantStage({planId:'plan',stageId:'one',completed:true,completedAt:'2026-09-01T12:00:00Z',progress:50});
  const context={patient:{clinicId:'A',patientId:'p'},plans:[{planId:'plan',status:'active',stages:[{stageId:'one',done:false}]}]};
  let result=f.archive.reconcileAssistantContext(context);assert.equal(result.plans[0].stages[0].done,true);assert.ok(result.plans[0].assistantUpdatedAt);
  context.plans[0].updatedAt='2099-01-01T12:00:00Z';result=f.archive.reconcileAssistantContext(context);assert.equal(result.plans[0].stages[0].done,false);assert.equal(result.plans[0].assistantUpdatedAt,undefined);
  assert.throws(()=>f.archive.reconcileAssistantContext({...context,patient:{clinicId:'B',patientId:'p'}}),/هوية/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.folders.AssistantSessions,'plan','plan-progress.json'))).stages.one.completed,true,'old records are retained, not deleted because a newer correction exists');
 }finally{f.close()}
});
