"use strict";

const fs=require("fs");
const path=require("path");
const os=require("os");
const {execFile}=require("child_process");

function existing(files){return files.find(file=>file&&fs.existsSync(file))||"";}

/**
 * Optional USB transport for Android TV/game sticks.
 *
 * It does not replace Wi-Fi and it does not require bundling adb. When Android
 * platform-tools are installed, every authorised USB device receives:
 *   adb -s <serial> reverse tcp:8765 tcp:8765
 * The Display then reaches the same HTTP protocol at 127.0.0.1:8765.
 */
class AdbReverseLink{
  constructor({port=8765,onState,onNotice}={}){
    this.port=Number(port)||8765;this.onState=onState||(()=>{});this.onNotice=onNotice||(()=>{});
    this.timer=null;this.running=false;this.last={available:false,connected:0,devices:[],message:"ADB غير متوفر — الاتصال اللاسلكي يعمل"};
  }
  adbPath(){
    const exe=process.platform==="win32"?"adb.exe":"adb";
    const roots=[process.env.ANDROID_HOME,process.env.ANDROID_SDK_ROOT,process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,"Android","Sdk"),path.join(os.homedir(),"AppData","Local","Android","Sdk")].filter(Boolean);
    return existing(roots.map(root=>path.join(root,"platform-tools",exe)))||exe;
  }
  run(args,timeout=4500){
    return new Promise((resolve,reject)=>execFile(this.adbPath(),args,{windowsHide:true,timeout},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(String(stdout||""))));
  }
  async refresh(){
    if(this.running)return this.last;this.running=true;
    try{
      const output=await this.run(["devices"]),devices=output.split(/\r?\n/).slice(1).map(line=>line.trim().split(/\s+/)).filter(parts=>parts.length>=2&&parts[1]==="device").map(parts=>parts[0]);
      const linked=[];
      for(const serial of devices){
        try{await this.run(["-s",serial,"reverse",`tcp:${this.port}`,`tcp:${this.port}`]);linked.push(serial);}catch{}
      }
      const changed=JSON.stringify(linked)!==JSON.stringify(this.last.devices);
      this.last={available:true,connected:linked.length,devices:linked,message:linked.length?`USB متصل تلقائياً مع ${linked.length} جهاز`:(devices.length?"جهاز USB غير مخوّل؛ وافق على رسالة USB debugging":"ADB جاهز — بانتظار كابل USB")};
      if(changed&&linked.length)this.onNotice("تم تفعيل اتصال الشاشة السلكي عبر USB","success");
    }catch(error){
      this.last={available:false,connected:0,devices:[],message:error?.code==="ENOENT"?"ثبّت Android Platform Tools لتفعيل USB (اللاسلكي مستمر)":"تعذر فحص USB مؤقتاً — اللاسلكي مستمر"};
    }finally{this.running=false;this.onState({...this.last});}
    return this.last;
  }
  start(){if(this.timer)return;this.refresh();this.timer=setInterval(()=>this.refresh(),5000);}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  snapshot(){return{...this.last};}
}

module.exports={AdbReverseLink};
