'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
function setup(){
  const dom=new JSDOM('<body></body>',{url:'https://clinic.invalid/',runScripts:'outside-only'}),w=dom.window,calls=[],network=[];
  Object.assign(w,{Request,Response,Headers,AbortController,DOMException});
  w.fetch=async(...args)=>{network.push(args);return new Response('network');};
  const results={'clinic:health':{ok:true,product:'DentalChairController'},'clinic:command':{ok:true},'clinic:events':{ok:true,events:[]}};
  const ipcRenderer={invoke:async(channel,payload)=>{calls.push({channel,payload});return results[channel];},sendSync:()=>true};
  const electron={ipcRenderer,contextBridge:{exposeInMainWorld:(key,value)=>{w[key]=value;},executeInMainWorld:({func})=>w.eval('('+func.toString()+')()')}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main/clinic-preload.js'),'utf8'),{require:name=>{assert.equal(name,'electron');return electron;},window:w});
  return {w,calls,network,results,close:()=>w.close()};
}
test('an older hosted page reaches the native bridge even when all loopback networking is unavailable',async()=>{
  const f=setup();try{
    const payload={action:'select_patient',clinicId:'A',patientId:'p',sessionId:'s',transport:{clientId:'client-123456',sequence:1,issuedAt:Date.now()}};
    const reply=await f.w.fetch('http://127.0.0.1:8765/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    assert.equal((await reply.json()).ok,true);assert.equal(f.calls[0].channel,'clinic:command');assert.equal(f.calls[0].payload.patientId,'p');assert.equal(f.network.length,0);
    const health=await (await f.w.fetch('http://127.0.0.1:8765/health')).json();assert.equal(health.product,'DentalChairController');
    const events=await (await f.w.fetch(new Request('http://127.0.0.1:8765/clinical/events?clinicId=A&patientId=p&after=7'))).json();assert.equal(events.ok,true);assert.equal(f.calls.at(-1).payload.after,'7');
  }finally{f.close();}
});
test('embedded requests preserve failures, aborts and the boundaries of normal HTTPS traffic',async()=>{
  const f=setup();try{
    f.results['clinic:command']={ok:false,error:'archive_needs_review'};
    const reply=await f.w.fetch('http://127.0.0.1:8765/command',{method:'POST',body:'{"action":"select_patient"}'});assert.equal(reply.status,400);assert.equal((await reply.json()).error,'archive_needs_review');
    const before=f.calls.length,abort=new AbortController();abort.abort();
    await assert.rejects(f.w.fetch('http://127.0.0.1:8765/command',{method:'POST',body:'{}',signal:abort.signal}),/abort/i);assert.equal(f.calls.length,before);
    for(const url of ['https://clinic.invalid/api/dtdc/status','http://127.0.0.1:8765/media/file','http://127.0.0.1:9876/command','https://foreign.invalid/command'])await f.w.fetch(url);
    assert.equal(f.network.length,4);assert.equal(f.calls.length,before);
    assert.equal((await f.w.fetch('http://127.0.0.1:8765/health',{method:'DELETE'})).status,405);
  }finally{f.close();}
});
