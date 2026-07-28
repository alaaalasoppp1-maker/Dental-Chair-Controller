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

class ChairServer {
  constructor({port,maxWidth,maxHeight,onState,onNotice,getHelloPayload,onCommand}) {
    this.port=port;
    this.maxWidth=maxWidth;
    this.maxHeight=maxHeight;
    this.onState=onState||(()=>{});
    this.onNotice=onNotice||(()=>{});
    this.getHelloPayload=getHelloPayload||(()=>({}));
    this.onCommand=onCommand||(()=>false);
    this.clients=new Set();
    this.media=new Map();
    this.server=null;
    this.wss=null;
    this.pending=new Map();
    this.currentState=null;
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
  }

  logDiagnostic(level,event,details={}){
    this.diagnosticLog.push({at:Date.now(),level,event,...details});
    if(this.diagnosticLog.length>150)this.diagnosticLog.splice(0,this.diagnosticLog.length-150);
  }

  diagnostics(){
    const base=this.state();
    return {...base,mediaEntries:this.media.size,serverRunning:Boolean(this.server?.listening),startedAt:this.startedAt,lastConnectedAt:this.lastConnectedAt,lastMessageAt:this.lastMessageAt,lastCommandAt:this.lastCommandAt,lastAckAt:this.lastAckAt,lastAckLatencyMs:this.lastAckLatencyMs,lastFailedCommand:this.lastFailedCommand,protocol:3,controllerVersion:"2.9.1",log:[...this.diagnosticLog].reverse()};
  }

  clearDiagnostics(){this.diagnosticLog=[];this.lastFailedCommand="";return this.diagnostics();}

  testConnection(){
    const sentAt=Date.now();
    const count=this.send({type:"diagnostic_ping",requestedAt:sentAt},{important:true,warn:false});
    this.logDiagnostic(count?"info":"warning","diagnostic_test",{clients:count});
    return {ok:count>0,clients:count,sentAt};
  }

  state() {
    const ip=getLocalIPv4()[0]||"127.0.0.1";
    return {
      clients:this.clients.size,
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

  async start() {
    const app=express();
    app.use((req,res,next)=>{
      res.setHeader("Access-Control-Allow-Origin","*");
      res.setHeader("Access-Control-Allow-Headers","Content-Type");
      res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Private-Network","true");
      if(req.method==="OPTIONS")return res.sendStatus(204);
      next();
    });
    app.use(express.json({limit:"256kb"}));
    app.get("/health",(_req,res)=>res.json({ok:true,product:"DentalChairController",protocol:3,sessionId:this.sessionId}));
    app.post("/command",async(req,res)=>{
      try{
        const remote=String(req.socket.remoteAddress||"");
        if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(remote))return res.status(403).json({ok:false,error:"loopback_only"});
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
        const etag=`"${req.params.id}"`;
        res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, max-age=0");
        res.setHeader("Pragma","no-cache");
        res.setHeader("Expires","0");
        res.setHeader("ETag",etag);
        res.setHeader("Accept-Ranges","bytes");
        if(req.headers["if-none-match"]===etag)return res.sendStatus(304);
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
      this.clients.add(socket);
      this.lastConnectedAt=Date.now();
      this.logDiagnostic("success","display_connected",{remote:String(socket._socket?.remoteAddress||"")});
      socket.on("pong",()=>socket.isAlive=true);
      socket.on("message",raw=>this.onMessage(raw));
      socket.on("close",(code,reason)=>{
        this.lastDisconnectReason=`${code} ${String(reason||"")}`.trim();
        this.clients.delete(socket);
        this.logDiagnostic("warning","display_disconnected",{code,reason:String(reason||"")});
        this.emit();
      });
      socket.on("error",error=>{this.lastDisconnectReason=String(error?.message||"socket error");this.logDiagnostic("error","socket_error",{message:this.lastDisconnectReason});});
      socket.send(JSON.stringify({type:"hello",protocol:3,controllerVersion:"2.9.1",sessionId:this.sessionId,...this.getHelloPayload()}));
      if(this.currentState)setTimeout(()=>this.send(this.currentState,{important:true,warn:false}),180);
      this.emit();
    });

    this.heartbeatTimer=setInterval(()=>{
      for(const s of this.clients){
        if(!s.isAlive){s.terminate();this.clients.delete(s);continue;}
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

  onMessage(raw){
    try{
      const message=JSON.parse(String(raw));
      this.lastMessageAt=Date.now();
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
      if(message.type==="display_ready"&&this.currentState)this.send(this.currentState,{important:true,warn:false});
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
      this.broadcast(item.message);
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

  broadcast(message){
    let count=0;
    for(const socket of this.clients){
      if(socket.readyState===WebSocket.OPEN){socket.send(message);count++;}
    }
    return count;
  }

  send(payload,options=true){
    const opts=typeof options==="boolean"?{warn:options}:options||{};
    const stateful=new Set(["home","patient","image","gif","video","pdf","black","hide","treatment_gif","appointment_qr","treatment_plan","game"]).has(String(payload?.type||""));
    const important=opts.important===undefined?stateful:Boolean(opts.important);
    const messageId=important?crypto.randomUUID():undefined;
    const envelope={...payload,protocol:3,sessionId:payload?.sessionId??this.sessionId,sentAt:Date.now(),messageId};
    const message=JSON.stringify(envelope);
    this.lastCommandAt=Date.now();
    const count=this.broadcast(message);
    if(stateful)this.currentState={...payload,sessionId:envelope.sessionId};
    if(important&&messageId&&count){
      if(stateful)this.pending.clear();
      this.pending.set(messageId,{payload:envelope,message,sentAt:Date.now(),tries:0});
    }
    if(!count&&opts.warn!==false)this.onNotice(`شاشة الكرسي غير متصلة${this.lastDisconnectReason?`: ${this.lastDisconnectReason}`:""}`,"warning");
    this.emit();
    return count;
  }
}
module.exports={ChairServer};
