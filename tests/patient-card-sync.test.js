'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');

test('patient/session card shows the linked full name, doctor and gender and clears stale identity',async t=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../src/renderer/index.html'),'utf8'),{url:'https://controller.invalid',runScripts:'outside-only'}),w=dom.window,callbacks={};
  t.after(()=>w.close());w.HTMLMediaElement.prototype.pause=()=>{};w.alert=()=>{};w.confirm=()=>true;
  let state={patient:{selected:true,clinicId:'A',patientId:'p1',sessionId:'s1',fullName:'Patient Full Name',displayName:'Patient',doctorName:'Dr Patient',gender:'female'},settings:{doctorName:'Dr Fallback'},network:{},images:{},display:{}};
  w.chairAPI=new Proxy({getState:async()=>state},{get:(target,key)=>target[key]||(key.startsWith('on')?(cb=>callbacks[key]=cb):async()=>({}))});
  w.eval(fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8'));await new Promise(r=>setImmediate(r));
  assert.equal(w.document.getElementById('patient').value,'Patient Full Name');
  assert.equal(w.document.getElementById('doctor').value,'Dr Patient');
  assert.equal(w.document.querySelector('input[name="patientGender"][value="female"]').checked,true);

  const input=w.document.getElementById('patient');input.focus();input.value='manual draft';
  state={...state,patient:{selected:true,clinicId:'A',patientId:'p2',sessionId:'s2',fullName:'Second Patient',displayName:'Second',doctorName:'Dr Two',gender:'male'}};
  callbacks.onState(state);
  assert.equal(input.value,'Second Patient','a new patient must replace a focused stale/manual field');
  assert.equal(w.document.getElementById('doctor').value,'Dr Two');
  assert.equal(w.document.querySelector('input[name="patientGender"][value="male"]').checked,true);

  input.blur();callbacks.onState({...state,patient:{selected:false}});
  assert.equal(input.value,'','ending/clearing the patient must not leave the previous name visible');
});

test('manual patient display sends the entered full name without pretending to select an archive patient',async t=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../src/renderer/index.html'),'utf8'),{url:'https://controller.invalid',runScripts:'outside-only'}),w=dom.window,callbacks={},calls=[];
  t.after(()=>w.close());w.HTMLMediaElement.prototype.pause=()=>{};w.alert=()=>{};w.confirm=()=>true;
  const state={patient:{selected:false},settings:{},network:{},images:{},display:{}};
  w.chairAPI=new Proxy({getState:async()=>state,showPatient:async payload=>{calls.push(payload);return true;}},{get:(target,key)=>target[key]||(key.startsWith('on')?(cb=>callbacks[key]=cb):async()=>({}))});
  w.eval(fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8'));await new Promise(r=>setImmediate(r));
  w.document.getElementById('patient').value='Manual Full Name';w.document.getElementById('showPatient').click();await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,1);assert.equal(calls[0].manual,true);assert.equal(calls[0].fullName,'Manual Full Name');assert.equal(calls[0].displayName,'Manual Full Name');
});
