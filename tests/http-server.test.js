'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{once}=require('node:events');
const {ChairServer}=require('../src/main/server'),{WebSocket}=require('ws');
test('the actual HTTP and WebSocket entry points enforce origins and clinical scope',async()=>{
 let commands=0;const captured=[];
 const server=new ChairServer({port:0,onCommand:()=>{commands++;return true},getClinicalEvents:scope=>{captured.push(scope);return[]}});
 server.assistantContext={patient:{patientId:'p',clinicId:'A',fullName:'Synthetic private name'}};await server.start();const base='http://127.0.0.1:'+server.server.address().port;
 try{
  const health=await(await fetch(base+'/health')).json();assert.equal(health.ok,true);assert.equal(JSON.stringify(health).includes('private'),false);assert.equal(health.sessionId,undefined);
  let res=await fetch(base+'/command',{method:'POST',headers:{Origin:'https://foreign.invalid','Content-Type':'application/json'},body:'{"action":"clear_patient"}'});assert.equal(res.status,403);assert.equal(commands,0);
  res=await fetch(base+'/command',{method:'POST',headers:{Origin:'https://dr-taher-dental-chain.web.app','Content-Type':'application/json'},body:'{"action":"clear_patient"}'});assert.equal(res.status,200);assert.equal(commands,1);
  assert.equal((await fetch(base+'/clinical/events')).status,400);
  let data=await(await fetch(base+'/clinical/events?clinicId=B&patientId=p')).json();assert.equal(data.context,null);assert.equal(captured[0].clinicId,'B');
  data=await(await fetch(base+'/clinical/events?clinicId=A&patientId=p')).json();assert.equal(data.context.patient.clinicId,'A');
  const socket=new WebSocket(base.replace('http','ws'),{origin:'https://foreign.invalid'});const [error]=await once(socket,'error');assert.match(error.message,/403/);
 }finally{clearInterval(server.heartbeatTimer);for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.wss.close(resolve));await new Promise(resolve=>server.server.close(resolve));}
});
test('changing the patient session discards prior display retries, cached media and reconnect state',()=>{
 const server=new ChairServer({port:0});server.setSession('patient-A-session');
 server.pending.set('old-command',{patientId:'A'});server.displayCommands.push({type:'image',url:'/old'});server.currentState={type:'image',url:'/old'};server.media.set('old','/old');
 server.setSession('patient-B-session');
 assert.equal(server.pending.size,0);assert.deepEqual(server.displayCommands,[]);assert.equal(server.currentState,null);assert.equal(server.media.size,0);
 server.currentState={type:'home',clearPatient:true};server.setSession('patient-B-session');assert.equal(server.currentState.type,'home');
});
test('the clinical HTTP endpoint exposes durable pages and resets a cursor from a different journal',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{ClinicalEventJournal,requestIdentity}=require('../src/main/clinical-event-journal');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dtdc-http-journal-')),scope={clinicId:'A',patientId:'p'},journal=new ClinicalEventJournal(directory);
 for(let i=0;i<201;i++)journal.append(scope,'assistant_event',{payload:{note:'Synthetic'}},requestIdentity('assistant_event',{eventId:'event-'+i}));
 const server=new ChairServer({port:0,getClinicalEvents:query=>journal.list(query)});await server.start();const base='http://127.0.0.1:'+server.server.address().port;
 try{
  const first=await(await fetch(base+'/clinical/events?clinicId=A&patientId=p&journalId=new&after=99999')).json();assert.equal(first.events.length,200);assert.equal(first.journal.hasMore,true);assert.equal(first.events[0].sequence,1);
  const second=await(await fetch(base+'/clinical/events?clinicId=A&patientId=p&journalId='+first.journal.id+'&after=200')).json();assert.equal(second.events.length,1);assert.equal(second.events[0].sequence,201);assert.equal(second.journal.hasMore,false);
  const foreign=await(await fetch(base+'/clinical/events?clinicId=B&patientId=p')).json();assert.equal(foreign.events.length,0);assert.equal(foreign.journal,null);
 }finally{clearInterval(server.heartbeatTimer);for(const socket of server.clients)socket.terminate();await new Promise(r=>server.wss.close(r));await new Promise(r=>server.server.close(r));fs.rmSync(directory,{recursive:true,force:true})}
});
