'use strict';

// Ordering protection, not authentication: paired-client authorization is separate.
// A logout arriving before an old select must still invalidate that old select.
class CommandSessionGuard {
  constructor({now=Date.now,maxClients=128}={}){this.now=now;this.maxClients=maxClients;this.clients=new Map();}
  accept(command){
    const meta=command?.transport,now=this.now();
    const reject=code=>{throw Object.assign(new Error(code),{statusCode:409});};
    if(!meta||typeof meta.clientId!=='string'||!/^[A-Za-z0-9_-]{12,100}$/.test(meta.clientId)||!Number.isSafeInteger(meta.sequence)||meta.sequence<1||!Number.isSafeInteger(meta.issuedAt))reject('command_context_required');
    if(meta.issuedAt<now-60000||meta.issuedAt>now+10000)reject('command_expired');
    for(const field of ['clinicId','patientId','sessionId'])if(typeof command[field]!=='string'||!command[field].trim()||command[field].length>200)reject('patient_context_required');
    if(command.patient){
      for(const field of ['clinicId','patientId','sessionId'])if(command.patient[field]!==command[field])reject('patient_context_mismatch');
    }
    for(const [id,entry]of this.clients)if(now-entry.at>600000)this.clients.delete(id);
    const previous=this.clients.get(meta.clientId);
    if(previous&&meta.sequence<=previous.sequence)reject('stale_command');
    if(!previous&&this.clients.size>=this.maxClients)reject('controller_busy');
    this.clients.set(meta.clientId,{sequence:meta.sequence,at:now});
    return true;
  }
}
module.exports={CommandSessionGuard};
