'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const identity=require('../shared/archive-identity');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const copy=value=>JSON.parse(JSON.stringify(value));
function stable(value){
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])]));
 return value;
}
function requestIdentity(type,payload={}){
 const semantic={...payload};for(const key of ['deviceId','queuedAt','transportState','protocol','contractVersion','sentAt'])delete semantic[key];
 if(['assistant_stage_updated','assistant_session','assistant_event','assistant_plan_closed'].includes(semantic.type))delete semantic.type;
 const digest=hash(JSON.stringify(stable(semantic))),id=String(payload.eventId||payload.id||payload.requestId||(type==='assistant_session_saved'?payload.sessionId:'')||digest);
 return {sourceId:JSON.stringify([type,String(payload.sessionId||''),id]),sourceDigest:digest};
}

/** Durable relay journal. Reads never consume records and there is no automatic
 * eviction or deletion after delivery. Authorization is a separate transport gate. */
class ClinicalEventJournal {
 constructor(directory,{clock=Date.now}={}){this.directory=directory;this.clock=clock;this.loaded=new Map();fs.mkdirSync(directory,{recursive:true,mode:0o700});}
 write(file,record,create=false){
  const encoded=JSON.stringify(record)+'\n',fd=fs.openSync(file,create?'wx':'a',0o600);
  try{fs.writeFileSync(fd,encoded,'utf8');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 }
 load(scope,create=false){
  const key=identity.folderKeySync(scope);if(this.loaded.has(key))return this.loaded.get(key);
  const wanted=identity.identity(scope),file=path.join(this.directory,key+'.ndjson');
  if(!fs.existsSync(file)){
   if(!create)return null;
   const header={kind:'header',version:1,journalId:crypto.randomUUID(),...wanted};this.write(file,header,true);
  }
  const bytes=fs.readFileSync(file),end=bytes.lastIndexOf(10)+1;
  if(end===0)throw new Error('clinical_journal_header_incomplete');
  const lines=bytes.subarray(0,end).toString('utf8').trimEnd().split('\n');let header;
  try{header=JSON.parse(lines.shift())}catch{throw new Error('clinical_journal_header_invalid')}
  if(header.kind!=='header'||header.version!==1||!header.journalId||!identity.matches(header,wanted))throw new Error('clinical_journal_identity_invalid');
  const state={file,header,events:[],bySource:new Map()};
  for(const line of lines){
   let row;try{row=JSON.parse(line)}catch{throw new Error('clinical_journal_record_invalid')}
   const event=row.event;
   if(row.kind!=='event'||!event||row.sha256!==hash(JSON.stringify(event))||event.sequence!==state.events.length+1||!identity.matches(event,wanted)||!event.eventId||state.bySource.has(event.sourceId))throw new Error('clinical_journal_record_invalid');
   state.events.push(event);state.bySource.set(event.sourceId,event);
  }
  // Only an incomplete, unacknowledged tail can be recovered automatically.
  // Preserve its exact bytes before truncating; complete corrupt lines stop use.
  if(end<bytes.length){
   const recovery=file+'.partial-'+crypto.randomUUID();const fd=fs.openSync(recovery,'wx',0o600);
   try{fs.writeFileSync(fd,bytes.subarray(end));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
   const original=fs.openSync(file,'r+');try{fs.ftruncateSync(original,end);fs.fsyncSync(original)}finally{fs.closeSync(original)}
  }
  this.loaded.set(key,state);return state;
 }
 find(scope,source){
  const old=this.load(scope)?.bySource.get(source.sourceId);
  if(old&&old.sourceDigest!==source.sourceDigest)throw new Error('clinical_event_id_conflict');
  return old?copy(old):null;
 }
 append(scope,type,data,source){
  if(!source?.sourceId||!source.sourceDigest)throw new Error('clinical_event_identity_required');
  const state=this.load(scope,true),old=state.bySource.get(source.sourceId);
  if(old){if(old.sourceDigest!==source.sourceDigest)throw new Error('clinical_event_id_conflict');return copy(old)}
  const wallTime=Number(this.clock());if(!Number.isFinite(wallTime))throw new Error('clinical_event_time_invalid');
  // at is the transport cursor; createdAt retains the actual controller clock.
  const at=Math.max(wallTime,(state.events.at(-1)?.at||0)+1),sequence=state.events.length+1;
  const event={...copy(data),...identity.identity(scope),sessionId:String(scope.sessionId||''),type,eventId:'clinical-'+hash(JSON.stringify([state.header.journalId,source.sourceId])),...source,at,createdAtMs:wallTime,createdAt:new Date(wallTime).toISOString(),sequence};
  const line={kind:'event',event,sha256:hash(JSON.stringify(event))};
  if(Buffer.byteLength(JSON.stringify(line),'utf8')>512*1024)throw new Error('clinical_event_too_large');
  try{this.write(state.file,line)}catch(error){this.loaded.delete(identity.folderKeySync(scope));throw error}
  state.events.push(event);state.bySource.set(source.sourceId,event);return copy(event);
 }
 list({clinicId,patientId,after=0,journalId='',since=0,limit=200}={}){
  const state=this.load({clinicId,patientId});if(!state)return {events:[],journal:null};const sameJournal=String(journalId)===state.header.journalId;
  let sequence=Number(after);
  if(!Number.isSafeInteger(sequence)||sequence<0)throw new Error('clinical_cursor_invalid');
  if(!sameJournal||sequence>state.events.length)sequence=0;
  const count=Math.min(200,Math.max(1,Math.floor(Number(limit)||200)));
  // New clients always use journal ID + sequence. Old timestamp clients remain
  // supported but are told the new cursor so an upgraded browser can restart.
  const selected=state.events.filter(event=>journalId?event.sequence>sequence:event.at>=Math.max(0,Number(since)||0)),events=selected.slice(0,count).map(copy);
  return {events,journal:{version:1,id:state.header.journalId,after:sequence,nextSequence:events.at(-1)?.sequence||sequence,latestSequence:state.events.length,hasMore:selected.length>events.length}};
 }
}
module.exports={ClinicalEventJournal,requestIdentity};
