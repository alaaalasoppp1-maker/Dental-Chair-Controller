"use strict";
const dgram = require("dgram");
const os = require("os");

function isUsableIPv4(address) {
  const value=String(address||"");
  if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(value))return false;
  return !/^169\.254\./.test(value)&&!/^0\./.test(value)&&value!=="255.255.255.255";
}

function isPrivateIPv4(address){
  return /^10\./.test(address)||/^192\.168\./.test(address)||/^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function ipv4ToInt(value){return String(value).split(".").reduce((out,part)=>((out<<8)>>>0)+(Number(part)&255),0)>>>0;}
function intToIpv4(value){return[24,16,8,0].map(shift=>(value>>>shift)&255).join(".");}
function broadcastFor(address,netmask){return intToIpv4((ipv4ToInt(address)|(~ipv4ToInt(netmask)>>>0))>>>0);}

function getLocalIPv4Info() {
  const addresses = [];
  let interfaces = {};
  try { interfaces = os.networkInterfaces() || {}; } catch { interfaces = {}; }
  for (const group of Object.values(interfaces)) {
    for (const item of group || []) {
      if (item.family === "IPv4" && !item.internal && isUsableIPv4(item.address)) {
        addresses.push({address:item.address,netmask:item.netmask||"255.255.255.0",broadcast:broadcastFor(item.address,item.netmask||"255.255.255.0")});
      }
    }
  }
  return addresses.sort((a,b)=>Number(isPrivateIPv4(b.address))-Number(isPrivateIPv4(a.address)));
}
function getLocalIPv4(){return getLocalIPv4Info().map(item=>item.address);}

class DiscoveryBroadcaster {
  constructor({port, wsPort, clinicName, onNotice}) {
    this.port = port;
    this.wsPort = wsPort;
    this.clinicName = clinicName;
    this.onNotice = onNotice || (()=>{});
    this.socket = null;
    this.timer = null;
  }

  start() {
    this.stop();
    this.socket = dgram.createSocket("udp4");
    this.socket.bind(() => {
      this.socket.setBroadcast(true);
      this.broadcast();
      this.timer = setInterval(() => this.broadcast(), 2000);
      this.onNotice("الاكتشاف التلقائي يعمل", "success");
    });
    this.socket.on("error", err => this.onNotice(`خطأ الاكتشاف: ${err.message}`, "error"));
  }

  broadcast() {
    if (!this.socket) return;
    for (const network of getLocalIPv4Info()) {
      const ip=network.address,broadcast=network.broadcast;
      const payload = Buffer.from(JSON.stringify({
        product: "DentalChairController",
        protocol: 5,
        contract: "dtdc-clinical-link-v1",
        roles: ["display", "doctor_assistant"],
        ip,
        wsPort: this.wsPort,
        clinicName: this.clinicName,
        sentAt: Date.now()
      }));
      this.socket.send(payload, 0, payload.length, this.port, broadcast, ()=>{});
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.socket) {
      try { this.socket.close(); } catch {}
    }
    this.socket = null;
  }
}

module.exports = {DiscoveryBroadcaster, getLocalIPv4, getLocalIPv4Info, isUsableIPv4, broadcastFor};
