'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
test('the actual archive renderer opens the requested plan and discards its response after a patient switch',async t=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../src/renderer/index.html'),'utf8'),{url:'https://controller.invalid',runScripts:'outside-only'}),w=dom.window,callbacks={},calls=[];t.after(()=>w.close());w.HTMLMediaElement.prototype.pause=()=>{};
  const patient={selected:true,clinicId:'A',patientId:'p1',sessionId:'chair-1',fullName:'Synthetic'},state={patient,settings:{},network:{},images:{},display:{}};
  let detail=async request=>{calls.push(request);return {title:'Second plan record',planId:request.planId,events:[],report:{progress:70}};};
  w.chairAPI=new Proxy({getState:async()=>state,listArchive:async()=>({patient,categories:[],items:[]}),listClinicalPlans:async()=>({patient,plans:[{planId:'first',title:'First',sessions:1,events:1},{planId:'second',title:'Second',sessions:2,events:4}]}),getClinicalPlanDetail:request=>detail(request)}, {get:(target,key)=>target[key]||(key.startsWith('on')?(cb=>callbacks[key]=cb):async()=>({}))});
  w.eval(fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8'));await new Promise(r=>setImmediate(r));
  const request={...patient,planId:'second',title:'Second',sessions:2,events:4};await callbacks.onOpenPlanDetails(request);assert.equal(calls[0].planId,'second');assert.equal(calls[0].clinicId,'A');assert.equal(calls[0].patientId,'p1');assert.equal(w.document.getElementById('clinicalPlanTitle').textContent,'Second plan record');
  let release;detail=()=>new Promise(r=>release=r);const pending=callbacks.onOpenPlanDetails(request);while(!release)await new Promise(r=>setImmediate(r));callbacks.onState({...state,patient:{...patient,patientId:'p2',sessionId:'chair-2'}});release({title:'Stale record',events:[],report:{}});await pending;
  assert(!w.document.getElementById('patientArchiveModal').classList.contains('open'));assert.notEqual(w.document.getElementById('clinicalPlanTitle').textContent,'Stale record');
});
