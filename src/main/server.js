"use strict";
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mime = require("mime-types");
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
  }

  state() {
    const ip=getLocalIPv4()[0]||"127.0.0.1";
    return {clients:this.clients.size,ip,wsUrl:`ws://${ip}:${this.port}`,httpUrl:`http://${ip}:${this.port}`};
  }

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
    app.get("/health",(_req,res)=>res.json({ok:true,product:"DentalChairController",protocol:2}));
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
    app.get("/media/:id",async(req,res)=>{
      const entry=this.media.get(req.params.id);
      if(!entry || !fs.existsSync(entry.path)) return res.sendStatus(404);
      try {
        res.setHeader("Cache-Control","no-store");
        if(entry.optimizeImage && sharp) {
          res.type("image/jpeg");
          sharp(entry.path).rotate().resize({
            width:this.maxWidth,height:this.maxHeight,fit:"inside",withoutEnlargement:true
          }).jpeg({quality:90,mozjpeg:true}).pipe(res);
        } else {
          res.type(mime.lookup(entry.path)||"application/octet-stream");
          fs.createReadStream(entry.path).pipe(res);
        }
      } catch { res.sendStatus(500); }
    });

    this.server=http.createServer(app);
    this.wss=new WebSocketServer({server:this.server});
    this.wss.on("connection",socket=>{
      socket.isAlive=true;
      this.clients.add(socket);
      socket.on("pong",()=>socket.isAlive=true);
      socket.on("close",()=>{this.clients.delete(socket);this.emit();});
      socket.on("error",()=>{});
      socket.send(JSON.stringify({type:"hello",protocol:2,controllerVersion:"2.2.0",...this.getHelloPayload()}));
      this.emit();
    });

    setInterval(()=>{
      for(const s of this.clients){
        if(!s.isAlive){s.terminate();this.clients.delete(s);continue;}
        s.isAlive=false;
        try{s.ping();}catch{}
      }
      this.emit();
    },15000);

    await new Promise((resolve,reject)=>{
      this.server.once("error",reject);
      this.server.listen(this.port,"0.0.0.0",resolve);
    });
    this.emit();
    this.onNotice(`خادم الشاشة يعمل على ${this.port}`,"success");
  }

  emit(){ this.onState(this.state()); }

  registerMedia(file,optimizeImage=false){
    const id=crypto.randomUUID();
    this.media.set(id,{path:file,optimizeImage,createdAt:Date.now()});
    if(this.media.size>80){
      const oldest=[...this.media.entries()].sort((a,b)=>a[1].createdAt-b[1].createdAt)[0];
      if(oldest)this.media.delete(oldest[0]);
    }
    return `${this.state().httpUrl}/media/${id}`;
  }

  send(payload,warn=true){
    const msg=JSON.stringify({...payload,protocol:2,sentAt:Date.now()});
    let count=0;
    for(const s of this.clients){
      if(s.readyState===WebSocket.OPEN){s.send(msg);count++;}
    }
    if(!count && warn)this.onNotice("شاشة الكرسي غير متصلة","warning");
    return count;
  }
}
module.exports={ChairServer};
