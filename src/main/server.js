"use strict";
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mime = require("mime-types");
let nativeImage = null;
try { ({nativeImage} = require("electron")); } catch { nativeImage = null; }
let sharp = null;
try { sharp = require("sharp"); } catch { sharp = null; }
const {WebSocketServer, WebSocket} = require("ws");
const {getLocalIPv4} = require("./discovery");
const {CLIENT_ROLES,TRANSPORT_PROTOCOL,normalizeRole}=require("../shared/clinical-contract");

class ChairServer {
  constructor({port,maxWidth,maxHeight,onState,onNotice,getHelloPayload,onCommand,onAssistantSession,onAssistantPlanClosed,onAssistantMedia,getClinicalEvents}) {
    this.port=port;
    this.maxWidth=maxWidth;
    this.maxHeight=maxHeight;
    this.onState=onState||(()=>{});
    this.onNotice=onNotice||(()=>{});
    this.getHelloPayload=getHelloPayload||(()=>({}));
    this.onCommand=onCommand||(()=>false);
    this.onAssistantSession=onAssistantSession||(()=>{throw new Error("assistant_session_not_configured");});
    this.onAssistantPlanClosed=onAssistantPlanClosed||(()=>{throw new Error("assistant_plan_close_not_configured");});
    this.onAssistantMedia=onAssistantMedia||(()=>{throw new Error("assistant_media_not_configured");});
    this.getClinicalEvents=getClinicalEvents||(()=>[]);
    this.clients=new Set();
    this.clientMeta=new Map();
    this.media=new Map();
    this.server=null;
    this.wss=null;
    this.pending=new Map();
    this.currentState=null;
    this.assistantContext=null;
    this.sessionId="";
    this.lastDisconnectReason="";
    this.heartbeatTimer=null;
    this.startedAt=0;
    this.lastConnectedAt=0;
    this.lastMessageAt=0;
    this.lastCommandAt=0;
    this.lastAckAt=0;
    this.lastAckLatencyMs=null;
    this.lastFailedCommand="";
    this.diagnosticLog=[];
    this.preferredIp="";
    this.lastRemoteAddress="";
  }

  logDiagnostic(level,event,details={}){
    this.diagnosticLog.push({at:Date.now(),level,event,...details});
    if(this.diagnosticLog.length>150)this.diagnosticLog.splice(0,this.diagnosticLog.length-150);
  }

  diagnostics(){
    const base=this.state();
    return {...base,mediaEntries:this.media.size,serverRunning:Boolean(this.server?.listening),startedAt:this.startedAt,lastConnectedAt:this.lastConnectedAt,lastMessageAt:this.lastMessageAt,lastCommandAt:this.lastCommandAt,lastAckAt:this.lastAckAt,lastAckLatencyMs:this.lastAckLatencyMs,lastFailedCommand:this.lastFailedCommand,protocol:TRANSPORT_PROTOCOL,controllerVersion:"3.0.0",log:[...this.diagnosticLog].reverse()};
  }

  clearDiagnostics(){this.diagnosticLog=[];this.lastFailedCommand="";return this.diagnostics();}

  testConnection(){
    const sentAt=Date.now();
    const count=this.send({type:"diagnostic_ping",requestedAt:sentAt},{important:true,warn:false,targetRole:CLIENT_ROLES.DISPLAY});
    this.logDiagnostic(count?"info":"warning","diagnostic_test",{clients:count});
    return {ok:count>0,clients:count,sentAt};
  }

  selectReachableIp(remoteAddress=""){
    const ips=getLocalIPv4();
    const remote=String(remoteAddress||this.lastRemoteAddress||"").replace(/^::ffff:/,"");
    if(remote){
      const parts=remote.split(".");
      if(parts.length===4){
        const same24=ips.find(ip=>ip.split(".").slice(0,3).join(".")===parts.slice(0,3).join("."));
        if(same24){this.preferredIp=same24;return same24;}
        const same16=ips.find(ip=>ip.split(".").slice(0,2).join(".")===parts.slice(0,2).join("."));
        if(same16){this.preferredIp=same16;return same16;}
      }
    }
    if(this.preferredIp&&ips.includes(this.preferredIp))return this.preferredIp;
    const privateIp=ips.find(ip=>/^192\.168\./.test(ip))||ips.find(ip=>/^10\./.test(ip))||ips.find(ip=>/^172\.(1[6-9]|2\d|3[01])\./.test(ip));
    return privateIp||ips[0]||"127.0.0.1";
  }

  state() {
    const ip=this.selectReachableIp();
    const displayClients=this.roleCount(CLIENT_ROLES.DISPLAY),assistantClients=this.roleCount(CLIENT_ROLES.ASSISTANT),unknownClients=this.roleCount(CLIENT_ROLES.UNKNOWN);
    return {
      clients:this.clients.size,
      displayClients,
      assistantClients,
      unknownClients,
      ip,
      wsUrl:`ws://${ip}:${this.port}`,
      httpUrl:`http://${ip}:${this.port}`,
      sessionId:this.sessionId,
      pendingAcks:this.pending.size,
      lastDisconnectReason:this.lastDisconnectReason
    };
  }

  setSession(id){
    const next=String(id||"");
    if(next!==this.sessionId)this.pending.clear();
    this.sessionId=next;
    this.emit();
  }

  setCurrentState(payload){this.currentState=payload||null;}

  roleCount(role){let count=0;for(const socket of this.clients)if((this.clientMeta.get(socket)?.role||CLIENT_ROLES.UNKNOWN)===role)count++;return count;}
  setRole(socket,role){
    const normalized=normalizeRole(role),previous=this.clientMeta.get(socket)||{};this.clientMeta.set(socket,{...previous,role:normalized,identifiedAt:Date.now()});
    this.logDiagnostic("info","client_identified",{role:normalized,remote:previous.remote||""});this.emit();return normalized;
  }
  direct(socket,payload){
    if(!socket||socket.readyState!==WebSocket.OPEN)return false;
    socket.send(JSON.stringify({...payload,protocol:TRANSPORT_PROTOCOL,sessionId:payload?.sessionId??this.sessionId,sentAt:Date.now()}));return true;
  }
  setAssistantContext(context){this.assistantContext=context||null;if(this.assistantContext)this.sendAssistantContext(this.assistantContext);this.emit();return this.assistantContext;}
  clearAssistantContext(){this.assistantContext=null;this.broadcast(JSON.stringify({type:"assistant_context_cleared",protocol:TRANSPORT_PROTOCOL,sentAt:Date.now()}),CLIENT_ROLES.ASSISTANT);this.emit();}
  sendAssistantContext(context=this.assistantContext){if(!context)return 0;return this.broadcast(JSON.stringify({...context,type:"assistant_patient_context",protocol:TRANSPORT_PROTOCOL,sessionId:context.patient?.sessionId||this.sessionId,sentAt:Date.now()}),CLIENT_ROLES.ASSISTANT);}

  async start() {
    const app=express();
    app.use((req,res,next)=>{
      res.setHeader("Access-Control-Allow-Origin","*");
      res.setHeader("Access-Control-Allow-Headers","Content-Type, X-DTDC-File-Name, X-DTDC-Mime-Type, X-DTDC-Media-Kind, X-DTDC-Patient-Id, X-DTDC-Plan-Id, X-DTDC-Session-Id");
      res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Private-Network","true");
      if(req.method==="OPTIONS")return res.sendStatus(204);
      next();
    });
    const isLoopback=req=>["127.0.0.1","::1","::ffff:127.0.0.1"].includes(String(req.socket.remoteAddress||""));
    app.use(express.json({limit:"4mb"}));
    app.get("/health",(_req,res)=>res.json({ok:true,product:"DentalChairController",protocol:TRANSPORT_PROTOCOL,contract:"dtdc-clinical-link-v1",sessionId:this.sessionId,...this.state()}));
    app.get("/assistant/context",(_req,res)=>this.assistantContext?res.json({ok:true,context:this.assistantContext}):res.status(404).json({ok:false,error:"no_active_patient"}));
    app.post("/assistant/session",async(req,res)=>{
      try{const result=await this.onAssistantSession(req.body||{});res.json({ok:true,result});}catch(error){res.status(400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/assistant/plan-close",async(req,res)=>{
      try{const result=await this.onAssistantPlanClosed(req.body||{});res.json({ok:true,result});}catch(error){res.status(400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/assistant/media",express.raw({type:"application/octet-stream",limit:"32mb"}),async(req,res)=>{
      try{const result=await this.onAssistantMedia({buffer:req.body,fileName:req.get("x-dtdc-file-name")||"",mimeType:req.get("x-dtdc-mime-type")||"application/octet-stream",kind:req.get("x-dtdc-media-kind")||"other",patientId:req.get("x-dtdc-patient-id")||"",planId:req.get("x-dtdc-plan-id")||"",sessionId:req.get("x-dtdc-session-id")||""});res.json({ok:true,result});}catch(error){res.status(400).json({ok:false,error:String(error?.message||error)});}
    });
    app.get("/clinical/events",(req,res)=>{
      if(!isLoopback(req))return res.status(403).json({ok:false,error:"loopback_only"});
      try{const since=Math.max(0,Number(req.query.since||0)||0),events=this.getClinicalEvents({since,patientId:String(req.query.patientId||"")})||[];res.json({ok:true,events,latestAt:events.reduce((max,event)=>Math.max(max,Number(event.at||event.createdAtMs||0)),since)});}catch(error){res.status(400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/command",async(req,res)=>{
      try{
        if(!isLoopback(req))return res.status(403).json({ok:false,error:"loopback_only"});
        const handled=await this.onCommand(req.body||{});
        if(!handled)return res.status(400).json({ok:false,error:"unsupported_command"});
        res.json({ok:true});
      }catch(error){
        res.status(400).json({ok:false,error:String(error?.message||error)});
      }
    });
    app.get(["/media/:id","/media/:id/:name"],async(req,res)=>{
      const entry=this.media.get(req.params.id);
      if(!entry || !fs.existsSync(entry.path)) return res.sendStatus(404);
      const started=Date.now();
      try {
        res.setHeader("Cache-Control","no-cache, max-age=0, must-revalidate");
        res.setHeader("Pragma","no-cache");
        res.setHeader("Expires","0");
        res.setHeader("Accept-Ranges","bytes");
        this.logDiagnostic("info","media_request",{name:path.basename(entry.path),remote:String(req.socket.remoteAddress||""),url:req.originalUrl});
        const optimized=entry.optimizeImage ? await this.optimizedBuffer(entry) : null;
        if(optimized){
          res.type("image/jpeg");
          res.setHeader("Content-Length",optimized.length);
          this.logDiagnostic("info","media_served",{name:path.basename(entry.path),optimized:true,bytes:optimized.length,prepareMs:Date.now()-started});
          return res.end(optimized);
        }
        const stat=fs.statSync(entry.path),range=req.headers.range,type=mime.lookup(entry.path)||"application/octet-stream";
        res.type(type);
        if(range){
          const match=/bytes=(\d*)-(\d*)/.exec(range);
          if(match){
            const from=match[1]?Number(match[1]):0,to=match[2]?Number(match[2]):stat.size-1;
            const safeFrom=Math.max(0,Math.min(from,stat.size-1)),safeTo=Math.max(safeFrom,Math.min(to,stat.size-1));
            res.status(206);res.setHeader("Content-Range",`bytes ${safeFrom}-${safeTo}/${stat.size}`);res.setHeader("Content-Length",safeTo-safeFrom+1);
            this.logDiagnostic("info","media_range",{name:path.basename(entry.path),bytes:safeTo-safeFrom+1});
            return fs.createReadStream(entry.path,{start:safeFrom,end:safeTo}).pipe(res);
          }
        }
        res.setHeader("Content-Length",stat.size);
        this.logDiagnostic("info","media_served",{name:path.basename(entry.path),optimized:false,bytes:stat.size,prepareMs:Date.now()-started});
        fs.createReadStream(entry.path).pipe(res);
      } catch(error) { this.logDiagnostic("error","media_error",{message:String(error?.message||error)});res.sendStatus(500); }
    });

    this.server=http.createServer(app);
    this.startedAt=Date.now();
    this.logDiagnostic("info","server_start",{port:this.port});
    this.wss=new WebSocketServer({server:this.server});
    this.wss.on("connection",socket=>{
      socket.isAlive=true;
      const remoteAddress=String(socket._socket?.remoteAddress||"").replace(/^::ffff:/,"");
      this.lastRemoteAddress=remoteAddress;
      this.selectReachableIp(remoteAddress);
      this.clients.add(socket);
      this.clientMeta.set(socket,{role:CLIENT_ROLES.UNKNOWN,remote:remoteAddress,connectedAt:Date.now()});
      this.lastConnectedAt=Date.now();
      this.logDiagnostic("success","client_connected",{remote:remoteAddress,selectedIp:this.selectReachableIp(remoteAddress)});
      socket.on("pong",()=>socket.isAlive=true);
      socket.on("message",raw=>this.onMessage(socket,raw));
      socket.on("close",(code,reason)=>{
        this.lastDisconnectReason=`${code} ${String(reason||"")}`.trim();
        this.clients.delete(socket);
        const role=this.clientMeta.get(socket)?.role||CLIENT_ROLES.UNKNOWN;this.clientMeta.delete(socket);
        this.logDiagnostic("warning","client_disconnected",{role,code,reason:String(reason||"")});
        this.emit();
      });
      socket.on("error",error=>{this.lastDisconnectReason=String(error?.message||"socket error");this.logDiagnostic("error","socket_error",{message:this.lastDisconnectReason});});
      socket.send(JSON.stringify({type:"hello",protocol:TRANSPORT_PROTOCOL,controllerVersion:"3.0.0",contract:"dtdc-clinical-link-v1",sessionId:this.sessionId,...this.getHelloPayload()}));
      this.emit();
    });

    this.heartbeatTimer=setInterval(()=>{
      for(const s of this.clients){
        if(!s.isAlive){s.terminate();this.clients.delete(s);this.clientMeta.delete(s);continue;}
        s.isAlive=false;
        try{s.ping();}catch{}
      }
      this.retryPending();
      this.emit();
    },5000);

    await new Promise((resolve,reject)=>{
      this.server.once("error",reject);
      this.server.listen(this.port,"0.0.0.0",resolve);
    });
    this.emit();
    this.onNotice(`خادم الشاشة يعمل على ${this.port}`,"success");
  }

  emit(){ this.onState(this.state()); }

  onMessage(socket,raw){
    try{
      const message=JSON.parse(String(raw));
      this.lastMessageAt=Date.now();
      if(message.type==="client_hello"){
        const role=this.setRole(socket,message.role);
        this.direct(socket,{type:"client_accepted",role,contract:"dtdc-clinical-link-v1"});
        return;
      }
      if((message.type==="ack"||message.type==="media_loaded"||message.type==="media_error")&&message.messageId){
        const pending=this.pending.get(String(message.messageId));
        if(pending){
          this.lastAckLatencyMs=Date.now()-pending.sentAt;this.lastAckAt=Date.now();
          const level=message.type==="media_error"?"error":"success";
          this.logDiagnostic(level,message.type,{command:pending.payload?.type||"",latencyMs:this.lastAckLatencyMs,url:message.url||"",error:message.error||""});
        }
        // ACK الاستلام يبقي الأمر منتظراً فقط إذا أعلنت الشاشة أنها تدعم ACK تحميل الوسيط.
        if(message.type!=="ack"||message.mediaLoaded===true||!message.awaitMediaLoad)this.pending.delete(String(message.messageId));
      }
      if(message.type==="display_ready"){
        this.setRole(socket,CLIENT_ROLES.DISPLAY);
        if(this.currentState)this.direct(socket,this.currentState);
      }
      if(message.type==="assistant_ready"){
        this.setRole(socket,CLIENT_ROLES.ASSISTANT);
        if(this.assistantContext)this.direct(socket,this.assistantContext);
      }
      if(message.type==="assistant_session"){
        this.setRole(socket,CLIENT_ROLES.ASSISTANT);
        Promise.resolve(this.onAssistantSession(message)).then(result=>this.direct(socket,{type:"assistant_session_saved",requestId:message.requestId||message.sessionId,result})).catch(error=>this.direct(socket,{type:"assistant_error",requestId:message.requestId||message.sessionId,error:String(error?.message||error)}));
      }
      if(message.type==="assistant_plan_closed"){
        this.setRole(socket,CLIENT_ROLES.ASSISTANT);
        Promise.resolve(this.onAssistantPlanClosed(message)).then(result=>this.direct(socket,{type:"assistant_plan_closed_saved",requestId:message.requestId||message.planId,result})).catch(error=>this.direct(socket,{type:"assistant_error",requestId:message.requestId||message.planId,error:String(error?.message||error)}));
      }
      this.emit();
    }catch{}
  }

  retryPending(){
    const now=Date.now();
    for(const [id,item] of this.pending){
      if(now-item.sentAt<2500)continue;
      if(item.tries>=3){
        this.pending.delete(id);
        this.lastFailedCommand=String(item.payload.type||"");
        this.logDiagnostic("error","ack_timeout",{command:this.lastFailedCommand,tries:item.tries});
        this.onNotice(`لم تؤكد الشاشة استلام الأمر ${item.payload.type}`,"warning");
        continue;
      }
      item.tries++;
      item.sentAt=now;
      this.broadcast(item.message,item.targetRole);
    }
  }

  mediaId(file,optimizeImage=false){
    try{
      const st=fs.statSync(file);
      return crypto.createHash("sha256")
        .update(`${path.resolve(file)}|${Math.round(st.mtimeMs)}|${st.size}|${optimizeImage?1:0}`)
        .digest("hex").slice(0,32);
    }catch{return crypto.randomUUID();}
  }

  async optimizedBuffer(entry){
    if(!entry?.optimizeImage)return null;
    if(entry.optimizedBuffer)return entry.optimizedBuffer;
    if(entry.optimizePromise)return entry.optimizePromise;
    entry.optimizePromise=(async()=>{
      try{
        if(sharp){
          entry.optimizedBuffer=await sharp(entry.path).rotate().resize({
            width:this.maxWidth,height:this.maxHeight,fit:"inside",withoutEnlargement:true
          }).jpeg({quality:84,progressive:true}).toBuffer();
          return entry.optimizedBuffer;
        }
        if(nativeImage){
          let image=nativeImage.createFromPath(entry.path);
          if(image&&!image.isEmpty()){
            const size=image.getSize();
            const ratio=Math.min(1,this.maxWidth/size.width,this.maxHeight/size.height);
            if(ratio<1)image=image.resize({width:Math.max(1,Math.round(size.width*ratio)),height:Math.max(1,Math.round(size.height*ratio)),quality:"best"});
            entry.optimizedBuffer=image.toJPEG(84);
            return entry.optimizedBuffer;
          }
        }
      }catch{}
      return null;
    })().finally(()=>{entry.optimizePromise=null;});
    return entry.optimizePromise;
  }

  registerMedia(file,optimizeImage=false){
    const id=this.mediaId(file,optimizeImage);
    let entry=this.media.get(id);
    if(!entry){
      entry={path:file,optimizeImage,createdAt:Date.now(),optimizedBuffer:null,optimizePromise:null};
      this.media.set(id,entry);
    }else entry.createdAt=Date.now();
    if(optimizeImage)this.optimizedBuffer(entry).catch(()=>{});
    if(this.media.size>80){
      const oldest=[...this.media.entries()].sort((a,b)=>a[1].createdAt-b[1].createdAt)[0];
      if(oldest)this.media.delete(oldest[0]);
    }
    return `${this.state().httpUrl}/media/${id}/${encodeURIComponent(path.basename(file))}`;
  }

  prewarmMedia(file,optimizeImage=true){
    if(!file||!fs.existsSync(file))return;
    this.registerMedia(file,optimizeImage);
  }

  broadcast(message,targetRole=CLIENT_ROLES.DISPLAY){
    let count=0;
    for(const socket of this.clients){
      const role=this.clientMeta.get(socket)?.role||CLIENT_ROLES.UNKNOWN;
      if(role===targetRole&&socket.readyState===WebSocket.OPEN){socket.send(message);count++;}
    }
    return count;
  }

  send(payload,options=true){
    const opts=typeof options==="boolean"?{warn:options}:options||{};
    const stateful=new Set(["home","patient","image","gif","video","pdf","black","hide","treatment_gif","appointment_qr","treatment_plan","game"]).has(String(payload?.type||""));
    const important=opts.important===undefined?stateful:Boolean(opts.important);
    const messageId=important?crypto.randomUUID():undefined;
    const targetRole=normalizeRole(opts.targetRole||CLIENT_ROLES.DISPLAY);
    const envelope={...payload,protocol:TRANSPORT_PROTOCOL,sessionId:payload?.sessionId??this.sessionId,sentAt:Date.now(),messageId};
    const message=JSON.stringify(envelope);
    this.lastCommandAt=Date.now();
    const count=this.broadcast(message,targetRole);
    if(stateful)this.currentState={...payload,sessionId:envelope.sessionId};
    if(important&&messageId&&count){
      if(stateful)this.pending.clear();
      this.pending.set(messageId,{payload:envelope,message,sentAt:Date.now(),tries:0,targetRole});
    }
    if(!count&&opts.warn!==false)this.onNotice(`${targetRole===CLIENT_ROLES.ASSISTANT?"تطبيق المساعد":"شاشة الكرسي"} غير متصل${this.lastDisconnectReason?`: ${this.lastDisconnectReason}`:""}`,"warning");
    this.emit();
    return count;
  }
}
module.exports={ChairServer};
