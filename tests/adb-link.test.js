'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{AdbReverseLink,parseDevices}=require('../src/main/adb-link');
async function check(run){const states=[],link=new AdbReverseLink({port:8765,executable:'fixture-adb',run,onState:s=>states.push(s)});link.stopped=false;try{await link.tick();return{states,link}}finally{link.stop()}}
test('only authorized devices get this controller port and an existing mapping is retained',async()=>{
 const calls=[];const {states}=await check(async(_,args)=>{calls.push(args);if(args[0]==='devices')return 'List of devices attached\nA device product:test\nB unauthorized\nC offline\n';if(args.includes('--list'))return '';return ''});
 assert.deepEqual(calls.at(-1),['-s','A','reverse','--no-rebind','tcp:8765','tcp:8765']);assert.equal(states[0].connected,1);assert.equal(states[0].unauthorized,1);
 const existing=[];await check(async(_,args)=>{existing.push(args);return args[0]==='devices'?'A device':'A tcp:8765 tcp:8765'});assert.equal(existing.length,2);
});
test('another application mapping is reported, never replaced',async()=>{
 const calls=[];const {states}=await check(async(_,args)=>{calls.push(args);return args[0]==='devices'?'A device':'A tcp:8765 tcp:1234'});
 assert.equal(states[0].status,'port-conflict');assert.equal(states[0].connected,0);assert.equal(calls.length,2);
});
test('missing platform-tools is an optional transport failure, not a controller crash',async()=>{
 const {states}=await check(async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'})});assert.equal(states[0].status,'unavailable');
 assert.deepEqual(parseDevices('List of devices attached\n-device device\nx;bad device\nA device'),[{serial:'A',status:'device'}]);
});
test('stopping during detection prevents new reverse commands or state changes',async()=>{
 let resolve,calls=0,states=0;const promise=new Promise(r=>resolve=r),link=new AdbReverseLink({port:8765,run:()=>{calls++;return promise},onState:()=>states++});
 link.stopped=false;const work=link.tick();link.stop();resolve('A device');await work;assert.equal(calls,1);assert.equal(states,0);assert.equal(link.timer,null);
});
