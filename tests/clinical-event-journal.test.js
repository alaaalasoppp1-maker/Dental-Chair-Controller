'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ClinicalEventJournal,requestIdentity}=require('../src/main/clinical-event-journal');
function fixture(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dtdc-journal-'));return {directory,journal:new ClinicalEventJournal(directory,{clock:()=>1000}),scope:{clinicId:'A',patientId:'p',sessionId:'s'},close:()=>fs.rmSync(directory,{recursive:true,force:true})}}
function append(f,id,extra={}){const payload={eventId:id,...extra};return f.journal.append(f.scope,'assistant_event',{planId:'plan',payload},requestIdentity('assistant_event',payload))}
test('more than 600 events survive restart, page in order and never mix clinics with identical patient IDs',()=>{
 const f=fixture();try{
  for(let i=0;i<605;i++)append(f,'e'+i);f.journal.append({clinicId:'B',patientId:'p'},'assistant_event',{payload:{note:'Other clinic'}},requestIdentity('assistant_event',{eventId:'e0'}));
  f.journal=new ClinicalEventJournal(f.directory);let page=f.journal.list(f.scope),all=page.events;
  while(page.journal.hasMore){page=f.journal.list({...f.scope,journalId:page.journal.id,after:page.journal.nextSequence});all.push(...page.events)}
  assert.equal(all.length,605);assert.equal(new Set(all.map(e=>e.eventId)).size,605);assert(all.every(e=>e.clinicId==='A'));assert.deepEqual(all.map(e=>e.sequence),Array.from({length:605},(_,i)=>i+1));
  assert.equal(f.journal.list({...f.scope,journalId:'a-different-journal',after:99999}).events[0].sequence,1);
 }finally{f.close()}
});
test('delivery retries reuse the same event ID and a reused request ID with different content is rejected',()=>{
 const f=fixture();try{
  const first=append(f,'id');f.journal=new ClinicalEventJournal(f.directory);const repeated=append(f,'id');assert.deepEqual(repeated,first);assert.equal(f.journal.list(f.scope).events.length,1);
  assert.throws(()=>append(f,'id',{note:'Changed'}),/id_conflict/);assert.equal(f.journal.list(f.scope).events.length,1);
 }finally{f.close()}
});
test('incomplete final writes are preserved for recovery, complete corrupt records stop use without erasing the journal',()=>{
 const f=fixture();try{
  append(f,'one');const file=path.join(f.directory,fs.readdirSync(f.directory)[0]);fs.appendFileSync(file,'{"kind":');
  f.journal=new ClinicalEventJournal(f.directory);assert.equal(f.journal.list(f.scope).events.length,1);
  const recovery=fs.readdirSync(f.directory).find(n=>n.includes('.partial-'));assert.equal(fs.readFileSync(path.join(f.directory,recovery),'utf8'),'{"kind":');append(f,'two');
  fs.appendFileSync(file,'{"kind":"invalid"}\n');const before=fs.readFileSync(file);f.journal=new ClinicalEventJournal(f.directory);
  assert.throws(()=>f.journal.list(f.scope),/record_invalid/);assert.deepEqual(fs.readFileSync(file),before);
 }finally{f.close()}
});
test('a failed durable write cannot be reported as a saved event',()=>{
 const f=fixture();try{
  append(f,'one');const original=f.journal.write;f.journal.write=()=>{throw new Error('disk full')};assert.throws(()=>append(f,'two'),/disk full/);
  f.journal.write=original;assert.equal(f.journal.list(f.scope).events.length,1);assert.equal(append(f,'two').sequence,2);
 }finally{f.close()}
});
test('reading a nonexistent patient does not create a journal or consume disk entries',()=>{
 const f=fixture();try{assert.deepEqual(f.journal.list(f.scope),{events:[],journal:null});assert.equal(fs.readdirSync(f.directory).length,0)}finally{f.close()}
});
test('the real controller replay wrapper confirms a persisted result without repeating archive side effects',()=>{
 const f=fixture();try{
  const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8'),start=source.indexOf('function withClinicalReplay('),end=source.indexOf('\nfunction selectClinicalPatient',start);
  const context={archive:{requirePatient:()=>f.scope},clinicalJournal:f.journal,requestIdentity};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  let effects=0;const wrapped=context.withClinicalReplay('assistant_plan_closed',payload=>{effects++;return f.journal.append(f.scope,'assistant_plan_closed',{planId:'plan',payload:{doctorName:'Synthetic'}},requestIdentity('assistant_plan_closed',payload))});
  const payload={patientId:'p',clinicId:'A',chairSessionId:'s',planId:'plan',eventId:'closure'};const first=wrapped(payload);const repeat=wrapped({...payload,deviceId:'device',queuedAt:'later'});
  assert.equal(effects,1);assert.equal(repeat.duplicate,true);assert.equal(repeat.eventId,first.eventId);assert.equal(repeat.planId,'plan');
  assert.throws(()=>wrapped({...payload,reason:'different'}),/id_conflict/);assert.equal(effects,1);
  assert.throws(()=>wrapped({...payload,clinicId:'B'}),/لا تطابق/);assert.equal(effects,1);
  const stageWrapped=context.withClinicalReplay('assistant_stage_updated',value=>value);
  assert.throws(()=>stageWrapped({patientId:'p',clinicId:'A',sessionId:'stale-chair',planId:'plan',stageId:'stage'}),/لا تطابق/);
 }finally{f.close()}
});
