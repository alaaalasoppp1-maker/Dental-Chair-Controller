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
const {version:CONTROLLER_VERSION}=require("../../package.json");

function decodeClinicalContext(value=""){
  try{
    const encoded=String(value||"");
    if(!encoded||encoded.length>24576)return{};
    const parsed=JSON.parse(Buffer.from(encoded,"base64").toString("utf8"));
    return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{};
  }catch{return{};}
}

class ChairServer {
  constructor({port,maxWidth,maxHeight,onState,onNotice,getHelloPayload,onCommand,onAssistantStage,onAssistantSession,onAssistantPlanClosed,onAssistantEvent,onAssistantResume,onAssistantMedia,getClinicalEvents,selectedAssistantId,onAssistantSelected}) {
    this.port=port;
    this.maxWidth=maxWidth;
    this.maxHeight=maxHeight;
    this.onState=onState||(()=>{});
    this.onNotice=onNotice||(()=>{});
    this.getHelloPayload=getHelloPayload||(()=>({}));
    this.onCommand=onCommand||(()=>false);
    this.onAssistantStage=onAssistantStage||(()=>{throw new Error("assistant_stage_not_configured");});
    this.onAssistantSession=onAssistantSession||(()=>{throw new Error("assistant_session_not_configured");});
    this.onAssistantPlanClosed=onAssistantPlanClosed||(()=>{throw new Error("assistant_plan_close_not_configured");});
    this.onAssistantEvent=onAssistantEvent||(()=>{throw new Error("assistant_event_not_configured");});
    this.onAssistantResume=onAssistantResume||(()=>{throw new Error("assistant_resume_not_configured");});
    this.onAssistantMedia=onAssistantMedia||(()=>{throw new Error("assistant_media_not_configured");});
    this.getClinicalEvents=getClinicalEvents||(()=>[]);
    this.onAssistantSelected=onAssistantSelected||(()=>{});
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
    this.assistantDevices=new Map();
    // Displays use the same resilient HTTP presence model as the assistant.
    // WebSocket remains the low-latency path, while this queue is the reliable
    // fallback (and the path used through `adb reverse` over USB).
    this.displayDevices=new Map();
    this.displayCommands=[];
    this.displaySequence=0;
    this.selectedAssistantId=String(selectedAssistantId||"");
  }

  logDiagnostic(level,event,details={}){
    this.diagnosticLog.push({at:Date.now(),level,event,...details});
    if(this.diagnosticLog.length>150)this.diagnosticLog.splice(0,this.diagnosticLog.length-150);
  }

  diagnostics(){
    const base=this.state();
    return {...base,mediaEntries:this.media.size,serverRunning:Boolean(this.server?.listening),startedAt:this.startedAt,lastConnectedAt:this.lastConnectedAt,lastMessageAt:this.lastMessageAt,lastCommandAt:this.lastCommandAt,lastAckAt:this.lastAckAt,lastAckLatencyMs:this.lastAckLatencyMs,lastFailedCommand:this.lastFailedCommand,protocol:TRANSPORT_PROTOCOL,controllerVersion:CONTROLLER_VERSION,log:[...this.diagnosticLog].reverse()};
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
    const assistants=this.assistants(),httpDisplays=this.displays().filter(item=>item.online).length,displayClients=Math.max(this.roleCount(CLIENT_ROLES.DISPLAY),httpDisplays),assistantClients=Math.max(this.roleCount(CLIENT_ROLES.ASSISTANT),assistants.filter(item=>item.online).length),unknownClients=this.roleCount(CLIENT_ROLES.UNKNOWN);
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
      ,assistants,displays:this.displays(),selectedAssistantId:this.selectedAssistantId
    };
  }

  assistants(){
    const now=Date.now();
    return[...this.assistantDevices.values()].map(item=>({...item,online:now-item.lastSeen<15000,selected:item.deviceId===this.selectedAssistantId})).sort((a,b)=>Number(b.selected)-Number(a.selected)||b.lastSeen-a.lastSeen);
  }
  displays(){
    const now=Date.now();
    return[...this.displayDevices.values()].map(item=>({...item,online:now-item.lastSeen<12000})).sort((a,b)=>b.lastSeen-a.lastSeen);
  }
  registerDisplay(payload={},remote=""){
    const deviceId=String(payload.deviceId||payload.displayId||"").trim();
    if(!deviceId)throw new Error("deviceId مطلوب");
    const previous=this.displayDevices.get(deviceId)||{};
    const item={...previous,deviceId,name:String(payload.name||payload.deviceName||previous.name||"شاشة الكرسي").trim(),model:String(payload.model||previous.model||""),appVersion:String(payload.appVersion||previous.appVersion||""),transport:String(payload.transport||previous.transport||"network"),remote:String(remote||previous.remote||"").replace(/^::ffff:/,""),lastSeen:Date.now(),firstSeen:previous.firstSeen||Date.now(),lastSequence:Math.max(Number(previous.lastSequence||0),Number(payload.lastSequence||0))};
    this.displayDevices.set(deviceId,item);this.lastConnectedAt=Date.now();this.emit();return item;
  }
  commandsAfter(sequence=0){
    const after=Math.max(0,Number(sequence)||0);
    return this.displayCommands.filter(item=>item.sequence>after).slice(-30).map(item=>item.envelope);
  }
  acknowledgeDisplay(payload={},remote=""){
    const device=this.registerDisplay(payload,remote),messageId=String(payload.messageId||""),commandId=String(payload.commandId||"");
    device.lastSequence=Math.max(Number(device.lastSequence||0),Number(payload.sequence||0));
    device.lastAckAt=Date.now();device.lastResult=String(payload.result||payload.type||"ack");
    if(messageId&&this.pending.has(messageId)){
      const pending=this.pending.get(messageId);this.lastAckLatencyMs=Date.now()-pending.sentAt;this.lastAckAt=Date.now();this.pending.delete(messageId);
      this.logDiagnostic(payload.result==="media_error"?"error":"success","http_display_ack",{deviceId:device.deviceId,commandId,messageId,latencyMs:this.lastAckLatencyMs,result:device.lastResult,error:String(payload.error||"")});
    }
    this.emit();return device;
  }
  registerAssistant(payload={},remote=""){
    const deviceId=String(payload.deviceId||payload.assistantId||"").trim();
    if(!deviceId)throw new Error("deviceId مطلوب");
    const previous=this.assistantDevices.get(deviceId)||{};
    const item={...previous,deviceId,name:String(payload.name||payload.deviceName||previous.name||"مساعد الطبيب").trim(),model:String(payload.model||previous.model||""),appVersion:String(payload.appVersion||previous.appVersion||""),remote:String(remote||previous.remote||"").replace(/^::ffff:/,""),lastSeen:Date.now(),firstSeen:previous.firstSeen||Date.now()};
    this.assistantDevices.set(deviceId,item);this.emit();return{...item,selected:deviceId===this.selectedAssistantId};
  }
  selectAssistant(deviceId=""){
    const id=String(deviceId||"").trim();
    if(id&&!this.assistantDevices.has(id))throw new Error("تطبيق المساعد غير موجود ضمن الأجهزة المكتشفة");
    this.selectedAssistantId=id;this.onAssistantSelected(id);this.logDiagnostic("info","assistant_selected",{deviceId:id});
    if(this.assistantContext)this.sendAssistantContext(this.assistantContext);this.emit();return this.state();
  }
  assistantDeviceId(req,payload={}){return String(req.get("x-dtdc-device-id")||payload.deviceId||req.query?.deviceId||"").trim();}
  requireSelectedAssistant(req,payload={}){
    const id=this.assistantDeviceId(req,payload);if(!id)throw Object.assign(new Error("device_id_required"),{statusCode:400});
    this.registerAssistant({...payload,deviceId:id},req.socket.remoteAddress||"");
    if(!this.selectedAssistantId)throw Object.assign(new Error("assistant_selection_required"),{statusCode:409});
    if(id!==this.selectedAssistantId)throw Object.assign(new Error("assistant_not_selected"),{statusCode:403});
    return id;
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
  sendAssistantContext(context=this.assistantContext){
    if(!context||!this.selectedAssistantId)return 0;let count=0;
    for(const socket of this.clients){const meta=this.clientMeta.get(socket)||{};if(meta.role===CLIENT_ROLES.ASSISTANT&&meta.deviceId===this.selectedAssistantId&&this.direct(socket,{...context,type:"assistant_patient_context"}))count++;}
    return count;
  }

  async start() {
    const app=express();
    app.use((req,res,next)=>{
      res.setHeader("Access-Control-Allow-Origin","*");
      res.setHeader("Access-Control-Allow-Headers","Content-Type, X-DTDC-Device-Id, X-DTDC-Display, X-DTDC-File-Name, X-DTDC-Mime-Type, X-DTDC-Media-Kind, X-DTDC-Patient-Id, X-DTDC-Plan-Id, X-DTDC-Session-Id, X-DTDC-Clinical-Context");
      res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Private-Network","true");
      if(req.method==="OPTIONS")return res.sendStatus(204);
      next();
    });
    const isLoopback=req=>["127.0.0.1","::1","::ffff:127.0.0.1"].includes(String(req.socket.remoteAddress||""));
    app.use(express.json({limit:"4mb"}));
    app.get("/health",(_req,res)=>res.json({ok:true,product:"DentalChairController",protocol:TRANSPORT_PROTOCOL,contract:"dtdc-clinical-link-v1",sessionId:this.sessionId,...this.state()}));
    app.post("/assistant/presence",(req,res)=>{
      try{const assistant=this.registerAssistant(req.body||{},req.socket.remoteAddress||"");res.json({ok:true,assistant,selected:assistant.deviceId===this.selectedAssistantId,selectedAssistantId:this.selectedAssistantId,contextAvailable:Boolean(this.assistantContext),protocol:TRANSPORT_PROTOCOL});}catch(error){res.status(400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/display/presence",(req,res)=>{
      try{
        const body=req.body||{},display=this.registerDisplay(body,req.socket.remoteAddress||""),after=Math.max(0,Number(body.lastSequence||0)||0);
        let commands=this.commandsAfter(after);
        // A newly installed display can start after the in-memory queue was
        // trimmed. Bootstrap it with the last visual state in that case.
        if(!commands.length&&after===0&&this.currentState){
          const commandId=crypto.randomUUID(),sequence=++this.displaySequence;
          const envelope={...this.currentState,type:this.currentState.type,protocol:TRANSPORT_PROTOCOL,sessionId:this.currentState.sessionId??this.sessionId,sentAt:Date.now(),commandId,sequence,bootstrap:true};
          this.displayCommands.push({sequence,envelope,createdAt:Date.now()});
          commands=[envelope];
        }
        res.json({ok:true,display,protocol:TRANSPORT_PROTOCOL,contract:"dtdc-clinical-link-v1",controllerHttpUrl:`http://${this.selectReachableIp(req.socket.remoteAddress||"")}:${this.port}`,config:{type:"hello",protocol:TRANSPORT_PROTOCOL,sessionId:this.sessionId,...this.getHelloPayload()},commands,latestSequence:this.displaySequence});
      }catch(error){res.status(400).json({ok:false,error:String(error?.message||error)});}
    });
    app.get("/display/commands",(req,res)=>{
      try{
        const display=this.registerDisplay({deviceId:req.query.deviceId,appVersion:req.query.appVersion,lastSequence:req.query.after,transport:req.query.transport},req.socket.remoteAddress||"");
        res.json({ok:true,display,commands:this.commandsAfter(req.query.after),latestSequence:this.displaySequence});
      }catch(error){res.status(400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/display/ack",(req,res)=>{
      try{res.json({ok:true,display:this.acknowledgeDisplay(req.body||{},req.socket.remoteAddress||"")});}catch(error){res.status(400).json({ok:false,error:String(error?.message||error)});}
    });
    app.get("/assistant/context",(req,res)=>{
      try{this.requireSelectedAssistant(req,req.query||{});return this.assistantContext?res.json({ok:true,context:this.assistantContext}):res.status(404).json({ok:false,error:"no_active_patient"});}catch(error){res.status(error.statusCode||400).json({ok:false,error:String(error?.message||error),selectedAssistantId:this.selectedAssistantId});}
    });
    app.post("/assistant/stage",async(req,res)=>{
      try{this.requireSelectedAssistant(req,req.body||{});const result=await this.onAssistantStage(req.body||{});res.json({ok:true,result});}catch(error){res.status(error.statusCode||400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/assistant/session",async(req,res)=>{
      try{this.requireSelectedAssistant(req,req.body||{});const result=await this.onAssistantSession(req.body||{});res.json({ok:true,result});}catch(error){res.status(error.statusCode||400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/assistant/plan-close",async(req,res)=>{
      try{this.requireSelectedAssistant(req,req.body||{});const result=await this.onAssistantPlanClosed(req.body||{});res.json({ok:true,result});}catch(error){res.status(error.statusCode||400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/assistant/event",async(req,res)=>{
      try{this.requireSelectedAssistant(req,req.body||{});const result=await this.onAssistantEvent(req.body||{});res.json({ok:true,result});}catch(error){res.status(error.statusCode||400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/assistant/resume",async(req,res)=>{
      try{this.requireSelectedAssistant(req,req.body||{});const result=await this.onAssistantResume(req.body||{});res.json({ok:true,result});}catch(error){res.status(error.statusCode||400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/assistant/display-stop",async(req,res)=>{
      try{this.requireSelectedAssistant(req,req.body||{});const displayClients=this.send({type:"hide"},{important:true,warn:false,targetRole:CLIENT_ROLES.DISPLAY});res.json({ok:true,result:{displayClients}});}catch(error){res.status(error.statusCode||400).json({ok:false,error:String(error?.message||error)});}
    });
    app.post("/assistant/media",express.raw({type:"application/octet-stream",limit:"32mb"}),async(req,res)=>{
      try{this.requireSelectedAssistant(req,{});const result=await this.onAssistantMedia({buffer:req.body,fileName:req.get("x-dtdc-file-name")||"",mimeType:req.get("x-dtdc-mime-type")||"application/octet-stream",kind:req.get("x-dtdc-media-kind")||"other",patientId:req.get("x-dtdc-patient-id")||"",planId:req.get("x-dtdc-plan-id")||"",sessionId:req.get("x-dtdc-session-id")||"",clinicalContext:decodeClinicalContext(req.get("x-dtdc-clinical-context")||""),display:req.get("x-dtdc-display")==="1"});res.json({ok:true,result});}catch(error){res.status(error.statusCode||400).json({ok:false,error:String(error?.message||error)});}
    });
    app.get("/clinical/events",(req,res)=>{
      if(!isLoopback(req))return res.status(403).json({ok:false,error:"loopback_only"});
      try{const since=Math.max(0,Number(req.query.since||0)||0),events=this.getClinicalEvents({since,patientId:String(req.query.patientId||"")})||[];res.json({ok:true,events,context:this.assistantContext,latestAt:events.reduce((max,event)=>Math.max(max,Number(event.at||event.createdAtMs||0)),since)});}catch(error){res.status(400).json({ok:false,error:String(error?.message||error)});}
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
        // Media IDs include path, mtime, size and optimization mode, therefore
        // the URL is content-versioned and safe to cache aggressively.
        res.setHeader("Cache-Control","public, max-age=31536000, immutable");
        res.setHeader("ETag",`\"${req.params.id}\"`);
        if(req.headers["if-none-match"]===`\"${req.params.id}\"`)return res.sendStatus(304);
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
    await new Promise((resolve,reject)=>{
      const onError=error=>{this.server.off("listening",onListening);reject(error)};
      const onListening=()=>{this.server.off("error",onError);resolve()};
      this.server.once("error",onError);this.server.once("listening",onListening);this.server.listen(this.port,"0.0.0.0");
    });
    this.server.on("error",error=>{this.lastDisconnectReason=String(error?.message||error);this.logDiagnostic("error","server_error",{message:this.lastDisconnectReason});this.emit();});
    this.wss=new WebSocketServer({server:this.server});
    this.wss.on("error",error=>{this.lastDisconnectReason=String(error?.message||error);this.logDiagnostic("error","websocket_server_error",{message:this.lastDisconnectReason});this.emit();});
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
      socket.send(JSON.stringify({type:"hello",protocol:TRANSPORT_PROTOCOL,controllerVersion:CONTROLLER_VERSION,contract:"dtdc-clinical-link-v1",sessionId:this.sessionId,...this.getHelloPayload()}));
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

    this.emit();
    this.onNotice(`خادم الشاشة يعمل على ${this.port}`,"success");
  }

  emit(){ this.onState(this.state()); }

  onMessage(socket,raw){
    try{
      const message=JSON.parse(String(raw));
      this.lastMessageAt=Date.now();
      if(message.type==="client_hello"){
        const role=this.setRole(socket,message.role),meta=this.clientMeta.get(socket)||{};
        if(role===CLIENT_ROLES.ASSISTANT&&message.deviceId){this.registerAssistant(message,meta.remote||"");this.clientMeta.set(socket,{...meta,role,deviceId:String(message.deviceId)});}
        if(role===CLIENT_ROLES.DISPLAY&&message.deviceId){this.registerDisplay(message,meta.remote||"");this.clientMeta.set(socket,{...meta,role,deviceId:String(message.deviceId)});}
        this.direct(socket,{type:"client_accepted",role,contract:"dtdc-clinical-link-v1"});
        return;
      }
      if(["assistant_stage_updated","assistant_session","assistant_plan_closed"].includes(message.type)){
        const meta=this.clientMeta.get(socket)||{},deviceId=String(message.deviceId||meta.deviceId||"");
        if(!this.selectedAssistantId||deviceId!==this.selectedAssistantId){this.direct(socket,{type:"assistant_error",requestId:message.requestId||message.eventId||message.sessionId||message.planId,error:this.selectedAssistantId?"assistant_not_selected":"assistant_selection_required"});return;}
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
        const meta=this.clientMeta.get(socket)||{};if(message.deviceId){this.registerAssistant(message,meta.remote||"");this.clientMeta.set(socket,{...meta,role:CLIENT_ROLES.ASSISTANT,deviceId:String(message.deviceId)});}
        if(this.assistantContext&&this.selectedAssistantId&&String(message.deviceId||"")===this.selectedAssistantId)this.direct(socket,this.assistantContext);
      }
      if(message.type==="assistant_stage_updated"){
        this.setRole(socket,CLIENT_ROLES.ASSISTANT);
        Promise.resolve(this.onAssistantStage(message)).then(result=>this.direct(socket,{type:"assistant_stage_saved",requestId:message.requestId||message.eventId,result})).catch(error=>this.direct(socket,{type:"assistant_error",requestId:message.requestId||message.eventId,error:String(error?.message||error)}));
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
          }).jpeg({quality:91,progressive:true,chromaSubsampling:"4:4:4"}).toBuffer();
          return entry.optimizedBuffer;
        }
        if(nativeImage){
          let image=nativeImage.createFromPath(entry.path);
          if(image&&!image.isEmpty()){
            const size=image.getSize();
            const ratio=Math.min(1,this.maxWidth/size.width,this.maxHeight/size.height);
            if(ratio<1)image=image.resize({width:Math.max(1,Math.round(size.width*ratio)),height:Math.max(1,Math.round(size.height*ratio)),quality:"best"});
            entry.optimizedBuffer=image.toJPEG(91);
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
    const targetRole=normalizeRole(opts.targetRole||CLIENT_ROLES.DISPLAY);
    const messageId=important?crypto.randomUUID():undefined;
    const commandId=crypto.randomUUID();
    const sequence=targetRole===CLIENT_ROLES.DISPLAY?++this.displaySequence:undefined;
    const envelope={...payload,protocol:TRANSPORT_PROTOCOL,sessionId:payload?.sessionId??this.sessionId,sentAt:Date.now(),messageId,commandId,sequence};
    const message=JSON.stringify(envelope);
    this.lastCommandAt=Date.now();
    const socketCount=this.broadcast(message,targetRole);
    if(targetRole===CLIENT_ROLES.DISPLAY){
      this.displayCommands.push({sequence,envelope,createdAt:Date.now()});
      if(this.displayCommands.length>120)this.displayCommands.splice(0,this.displayCommands.length-120);
    }
    const httpCount=targetRole===CLIENT_ROLES.DISPLAY?this.displays().filter(item=>item.online).length:0;
    const count=Math.max(socketCount,httpCount);
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
