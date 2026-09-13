'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CommandSessionGuard}=require('../src/main/command-session-guard');
const command=(sequence,overrides={})=>({action:'select_patient',clinicId:'A',patientId:'p',sessionId:'session-A',transport:{clientId:'synthetic-client-one',sequence,issuedAt:100000},...overrides});
test('logout and new selections invalidate requests that arrive out of order',()=>{
  const guard=new CommandSessionGuard({now:()=>100000});guard.accept(command(2,{action:'clear_patient'}));
  assert.throws(()=>guard.accept(command(1)),/stale_command/);guard.accept(command(3,{patientId:'q',sessionId:'session-B'}));
  assert.throws(()=>guard.accept(command(2,{action:'clear_patient'})),/stale_command/);
});
test('missing, expired or contradictory identity cannot move the active patient',()=>{
  const guard=new CommandSessionGuard({now:()=>100000});
  assert.throws(()=>guard.accept(command(1,{transport:undefined})),/context_required/);
  assert.throws(()=>guard.accept(command(1,{clinicId:''})),/patient_context_required/);
  assert.throws(()=>guard.accept(command(1,{patient:{clinicId:'B',patientId:'p',sessionId:'session-A'}})),/mismatch/);
  assert.throws(()=>guard.accept(command(1,{transport:{clientId:'synthetic-client-one',sequence:1,issuedAt:1}})),/expired/);
  assert.equal(guard.accept(command(1)),true);
});
test('capacity is bounded without evicting a recent logout fence',()=>{
  const guard=new CommandSessionGuard({now:()=>100000,maxClients:1});guard.accept(command(2));
  assert.throws(()=>guard.accept(command(1,{transport:{clientId:'synthetic-client-two',sequence:1,issuedAt:100000}})),/controller_busy/);
  assert.throws(()=>guard.accept(command(1)),/stale_command/);
});
