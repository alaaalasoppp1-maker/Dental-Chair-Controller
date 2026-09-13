"use strict";
// Optional USB transport. Never restart the shared adb server or change ports
// belonging to another program. Missing platform-tools must not prevent startup.
const {execFile}=require("node:child_process");
const fs=require("node:fs"),path=require("node:path");
function adbExecutable(){
  const name=process.platform==="win32"?"adb.exe":"adb";
  const candidates=[
    process.env.DTDC_ADB_PATH,
    process.resourcesPath&&path.join(process.resourcesPath,"platform-tools",name),
    process.env.ANDROID_SDK_ROOT&&path.join(process.env.ANDROID_SDK_ROOT,"platform-tools",name),
    process.env.ANDROID_HOME&&path.join(process.env.ANDROID_HOME,"platform-tools",name)
  ].filter(Boolean);
  return candidates.find(file=>{try{return fs.statSync(file).isFile()}catch{return false}})||name;
}
function execute(file,args){return new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:5000,maxBuffer:65536},(error,stdout)=>error?reject(error):resolve(String(stdout||""))))}
function parseDevices(stdout){
  return String(stdout||"").split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(parts=>parts.length>1&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(parts[0])&&['device','offline','unauthorized'].includes(parts[1])).map(([serial,status])=>({serial,status}));
}
class AdbReverseLink{
  constructor({port,onState=()=>{},onNotice=()=>{},run=execute,executable=adbExecutable(),intervalMs=8000}){
    if(!Number.isInteger(Number(port))||Number(port)<1024||Number(port)>65535)throw Error('invalid-controller-port');
    this.port=Number(port);this.run=run;this.executable=executable;this.intervalMs=intervalMs;
    this.onState=onState;this.onNotice=onNotice;this.stopped=true;this.timer=null;this.busy=false;this.generation=0;
    this.value={status:'stopped',connected:0,unauthorized:0,offline:0};this.failures=0;
  }
  snapshot(){return {...this.value}}
  publish(value){this.value={...value,checkedAt:Date.now()};this.onState(this.snapshot())}
  start(){if(!this.stopped)return;this.stopped=false;this.generation++;this.timer=setTimeout(()=>this.tick(),0)}
  stop(){this.stopped=true;this.generation++;clearTimeout(this.timer);this.timer=null}
  async tick(){
    if(this.stopped||this.busy)return;this.busy=true;const generation=this.generation,valid=()=>!this.stopped&&generation===this.generation;
    try{
      const devices=parseDevices(await this.run(this.executable,['devices','-l']));if(!valid())return;
      const local='tcp:'+this.port;let connected=0,conflicts=0;
      for(const device of devices.filter(row=>row.status==='device')){
        const rows=String(await this.run(this.executable,['-s',device.serial,'reverse','--list'])).trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/));if(!valid())return;
        const mapping=rows.find(parts=>parts[parts.length-2]===local);
        if(mapping){if(mapping[mapping.length-1]===local)connected++;else conflicts++;continue}
        await this.run(this.executable,['-s',device.serial,'reverse','--no-rebind',local,local]);if(!valid())return;connected++;
      }
      this.failures=0;this.publish({status:conflicts?'port-conflict':connected?'connected':devices.some(row=>row.status==='unauthorized')?'unauthorized':'waiting',connected,conflicts,unauthorized:devices.filter(row=>row.status==='unauthorized').length,offline:devices.filter(row=>row.status==='offline').length});
    }catch(error){
      if(!valid())return;this.failures++;
      const unavailable=error?.code==='ENOENT';this.publish({status:unavailable?'unavailable':'error',connected:0,unauthorized:0,offline:0});
      if(this.failures===1)this.onNotice(unavailable?'اتصال USB يحتاج Android platform-tools. يبقى اتصال الشبكة متاحاً.':'تعذر تجهيز اتصال USB. تحقق من الكابل وإذن تصحيح USB على الجهاز.','warning');
    }finally{
      this.busy=false;if(!this.stopped)this.timer=setTimeout(()=>this.tick(),Math.min(60000,this.intervalMs*Math.pow(2,Math.min(this.failures,3))));
    }
  }
}
module.exports={AdbReverseLink,parseDevices};
