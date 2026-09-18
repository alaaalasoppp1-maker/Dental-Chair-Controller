'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {safeStorage,shell}=require('electron');

const SCOPES=['openid','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/contacts'];
const GOOGLE_AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN='https://oauth2.googleapis.com/token';
const DRIVE='https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD='https://www.googleapis.com/upload/drive/v3';
const PEOPLE='https://people.googleapis.com/v1';
const clean=v=>String(v??'').trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const b64url=b=>Buffer.from(b).toString('base64url');
const escapeDrive=s=>String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));

function configFromFile(file){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return{};}
}
function normalizePhone(v){return clean(v).replace(/[^\d+]/g,'').replace(/^00/,'+');}
function fireValue(value){
  if(value===null||value===undefined)return {nullValue:null};
  if(typeof value==='string')return {stringValue:value};
  if(typeof value==='boolean')return {booleanValue:value};
  if(typeof value==='number')return Number.isInteger(value)?{integerValue:String(value)}:{doubleValue:value};
  if(Array.isArray(value))return {arrayValue:{values:value.map(fireValue)}};
  if(typeof value==='object')return {mapValue:{fields:Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,fireValue(v)]))}};
  return {stringValue:String(value)};
}
function fromFire(v){
  if(!v)return null;if('stringValue'in v)return v.stringValue;if('integerValue'in v)return Number(v.integerValue);if('doubleValue'in v)return v.doubleValue;if('booleanValue'in v)return v.booleanValue;if('nullValue'in v)return null;
  if(v.arrayValue)return (v.arrayValue.values||[]).map(fromFire);if(v.mapValue)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,fromFire(x)]));return null;
}
function docData(doc){
  if(!doc?.fields)return null;
  const data=Object.fromEntries(Object.entries(doc.fields).map(([k,v])=>[k,fromFire(v)]));
  const documentId=clean(doc.name).split('/').filter(Boolean).pop()||'';
  if(documentId&&!data.id&&!data.patientId)data.id=documentId;
  return data;
}

class GoogleLocalService{
  constructor({directory,onNotice=()=>{},fetchImpl=fetch,configFile}={}){
    this.dir=directory;this.notice=onNotice;this.fetch=fetchImpl;this.configFile=configFile||path.join(__dirname,'../config/google-oauth.json');
    this.tokenFile=path.join(directory,'google-oauth-token.bin');this.clientSecretFile=path.join(directory,'google-oauth-client-secret.bin');this.metaFile=path.join(directory,'google-oauth-meta.json');this.contactFile=path.join(directory,'google-contacts-queue.json');this.oauthDiagFile=path.join(directory,'google-oauth-last-error.json');
    this.access=null;this.session=null;this.generation=0;this.contactsRunning=false;
    const c=configFromFile(this.configFile),candidate=clean(c.desktopClientId||process.env.DTDC_GOOGLE_DESKTOP_CLIENT_ID);this.clientId=/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(candidate)&&!/^PASTE_/i.test(candidate)?candidate:'';this.expectedEmail=clean(c.expectedEmail||'').toLowerCase();
    try{this.meta=JSON.parse(fs.readFileSync(this.metaFile,'utf8'));}catch{this.meta={contactsEnabled:false};}
    try{this.contactRows=JSON.parse(fs.readFileSync(this.contactFile,'utf8'));if(!Array.isArray(this.contactRows))this.contactRows=[];}catch{this.contactRows=[];}
  }
  setSession(value){
    if(!value||!value.token||!value.uid||!value.clinicId||!value.projectId){this.session=null;this.generation++;return;}
    const next={token:String(value.token),uid:String(value.uid),clinicId:String(value.clinicId),role:String(value.role||''),projectId:String(value.projectId),enabled:value.enabled===true,at:Date.now()};
    if(!this.session||JSON.stringify([this.session.uid,this.session.clinicId,this.session.projectId])!==JSON.stringify([next.uid,next.clinicId,next.projectId]))this.generation++;
    this.session=next;void this.flushContacts();
  }
  persistMeta(){fs.mkdirSync(this.dir,{recursive:true});fs.writeFileSync(this.metaFile,JSON.stringify(this.meta,null,2));}
  persistContacts(){fs.mkdirSync(this.dir,{recursive:true});const t=this.contactFile+'.tmp';fs.writeFileSync(t,JSON.stringify(this.contactRows,null,2));fs.renameSync(t,this.contactFile);}
  encryptedRefresh(){
    if(!fs.existsSync(this.tokenFile))return '';
    if(!safeStorage.isEncryptionAvailable())throw Object.assign(new Error('safe_storage_unavailable'),{code:'safe_storage_unavailable'});
    try{return safeStorage.decryptString(fs.readFileSync(this.tokenFile));}catch{throw Object.assign(new Error('google_reconnect_required'),{code:'google_reconnect_required'});}
  }
  saveRefresh(token){
    if(!safeStorage.isEncryptionAvailable())throw Object.assign(new Error('safe_storage_unavailable'),{code:'safe_storage_unavailable'});
    fs.mkdirSync(this.dir,{recursive:true});const tmp=this.tokenFile+'.tmp';fs.writeFileSync(tmp,safeStorage.encryptString(token));fs.renameSync(tmp,this.tokenFile);
  }
  hasClientSecret(){return fs.existsSync(this.clientSecretFile);}
  clientSecret(){
    if(!fs.existsSync(this.clientSecretFile))return '';
    if(!safeStorage.isEncryptionAvailable())throw Object.assign(new Error('safe_storage_unavailable'),{code:'safe_storage_unavailable'});
    try{return safeStorage.decryptString(fs.readFileSync(this.clientSecretFile));}catch{throw Object.assign(new Error('google_client_secret_reenter_required'),{code:'google_client_secret_reenter_required'});}
  }
  saveClientSecret(secret){
    const value=clean(secret);if(!value)throw Object.assign(new Error('google_client_secret_missing_local'),{code:'google_client_secret_missing_local'});
    if(!safeStorage.isEncryptionAvailable())throw Object.assign(new Error('safe_storage_unavailable'),{code:'safe_storage_unavailable'});
    fs.mkdirSync(this.dir,{recursive:true});const tmp=this.clientSecretFile+'.tmp';fs.writeFileSync(tmp,safeStorage.encryptString(value));fs.renameSync(tmp,this.clientSecretFile);return true;
  }
  clearClientSecret(){try{fs.unlinkSync(this.clientSecretFile);}catch{}return true;}
  status(){return {configured:!!this.clientId,clientSecretConfigured:this.hasClientSecret(),connected:fs.existsSync(this.tokenFile)&&!!this.meta.email,email:this.meta.email||'',contactsEnabled:this.meta.contactsEnabled===true,lastContactSyncAt:this.meta.lastContactSyncAt||0,lastDriveTestAt:this.meta.lastDriveTestAt||0,contactQueue:this.contactRows.filter(r=>r.status!=='done').length,scopes:this.meta.scopes||[]};}
  async connect(){
    if(!this.clientId)throw Object.assign(new Error('google_client_id_missing'),{code:'google_client_id_missing'});
    const clientSecret=this.clientSecret();if(!clientSecret)throw Object.assign(new Error('google_client_secret_missing_local'),{code:'google_client_secret_missing_local'});
    const verifier=b64url(crypto.randomBytes(48)),challenge=b64url(crypto.createHash('sha256').update(verifier).digest()),state=b64url(crypto.randomBytes(24));
    let callbackResponse=null,server=null,timer=null;
    const sendPage=(ok,message)=>{
      const res=callbackResponse;if(!res||res.destroyed||res.writableEnded)return;
      try{res.writeHead(ok?200:500,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(`<!doctype html><meta charset="utf-8"><title>Dental Chain OS</title><body style="font-family:system-ui;direction:rtl;padding:40px"><h2>${ok?'تم ربط Google بنجاح':'تعذر إكمال ربط Google'}</h2><p>${message}</p></body>`);}catch{}
    };
    const closeListener=()=>{if(timer)clearTimeout(timer);try{server?.close();}catch{}};
    try{
      const result=await new Promise((resolve,reject)=>{
        let done=false;const finish=(err,val)=>{if(done)return;done=true;if(timer)clearTimeout(timer);err?reject(err):resolve(val);};
        server=http.createServer((req,res)=>{
          try{
            const u=new URL(req.url,'http://127.0.0.1');
            if(u.pathname!=='/'&&u.pathname!=='/oauth2/callback'){res.writeHead(404);res.end();return;}
            if(u.searchParams.get('state')!==state)throw Object.assign(new Error('oauth_state_mismatch'),{code:'oauth_state_mismatch'});
            if(u.searchParams.get('error'))throw Object.assign(new Error(u.searchParams.get('error')),{code:'google_consent_failed'});
            const code=u.searchParams.get('code');if(!code)throw Object.assign(new Error('oauth_code_missing'),{code:'oauth_code_missing'});
            callbackResponse=res;
            // Keep this response open until token exchange + encrypted local persistence really succeed.
            finish(null,{code,redirect:`http://127.0.0.1:${server.address().port}`});
          }catch(e){
            try{res.writeHead(400,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;direction:rtl;padding:40px"><h2>تعذر ربط Google</h2><p>ارجع إلى Dental Chain Controller وحاول مجدداً.</p></body>');}catch{}
            finish(e);
          }
        });
        server.on('error',e=>finish(Object.assign(e,{code:e.code||'oauth_listener_failed'})));
        server.listen(0,'127.0.0.1',async()=>{
          // Google documents the loopback redirect for Desktop apps as the loopback origin + random port.
          const redirect=`http://127.0.0.1:${server.address().port}`;
          const p=new URLSearchParams({client_id:this.clientId,redirect_uri:redirect,response_type:'code',scope:SCOPES.join(' '),state,code_challenge:challenge,code_challenge_method:'S256',access_type:'offline',prompt:'consent'});
          if(this.expectedEmail)p.set('login_hint',this.expectedEmail);
          try{await shell.openExternal(`${GOOGLE_AUTH}?${p}`);}catch(e){finish(e);}
        });
        timer=setTimeout(()=>finish(Object.assign(new Error('oauth_timeout'),{code:'oauth_timeout'})),180000);timer.unref?.();
      });
      const body=new URLSearchParams({client_id:this.clientId,client_secret:clientSecret,code:result.code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:result.redirect});
      // Send an explicit form string. This avoids any Electron/Node fetch implementation ambiguity around URLSearchParams bodies.
      const r=await this.fetch(GOOGLE_TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json'},body:body.toString(),signal:AbortSignal.timeout(30000)});
      const raw=await r.text().catch(()=>''),data=(()=>{try{return raw?JSON.parse(raw):{};}catch{return{};}})();
      if(!r.ok||!data.access_token){
        const reason=clean(data.error)||`http_${r.status}`,description=clean(data.error_description)||clean(raw).slice(0,300)||'No description returned by Google';
        throw Object.assign(new Error(`google_token_exchange_failed:${reason}:${description}`),{code:'google_token_exchange_failed',status:r.status,oauthError:reason,oauthDescription:description});
      }
      const infoR=await this.fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${data.access_token}`},signal:AbortSignal.timeout(20000)});
      const info=await infoR.json().catch(()=>({}));
      if(!infoR.ok||!info.email)throw Object.assign(new Error('google_identity_failed'),{code:'google_identity_failed'});
      if(this.expectedEmail&&clean(info.email).toLowerCase()!==this.expectedEmail)throw Object.assign(new Error('wrong_google_account'),{code:'wrong_google_account'});
      if(!data.refresh_token)throw Object.assign(new Error('google_refresh_missing'),{code:'google_refresh_missing'});
      this.saveRefresh(data.refresh_token);
      this.access={token:data.access_token,expiresAt:Date.now()+Math.max(60,Number(data.expires_in||3600)-60)*1000};
      this.meta={...this.meta,email:info.email,sub:info.sub||'',scopes:clean(data.scope).split(/\s+/).filter(Boolean),connectedAt:Date.now(),lastConnectError:'',lastConnectErrorAt:0};
      this.persistMeta();
      try{fs.unlinkSync(this.oauthDiagFile);}catch{}
      sendPage(true,`تم حفظ الربط محلياً ومشفراً لهذا الجهاز للحساب ${info.email}. يمكنك إغلاق هذه الصفحة والعودة إلى Dental Chain Controller.`);
      return this.status();
    }catch(e){
      const code=e?.code||clean(e?.message)||'google_connect_failed';
      const detail=clean(e?.oauthError),description=clean(e?.oauthDescription);
      this.meta={...this.meta,lastConnectError:code,lastConnectErrorDetail:detail,lastConnectErrorDescription:description,lastConnectErrorAt:Date.now()};
      try{this.persistMeta();}catch{}
      try{
        fs.mkdirSync(this.dir,{recursive:true});
        fs.writeFileSync(this.oauthDiagFile,JSON.stringify({at:new Date().toISOString(),code,status:Number(e?.status||0)||null,googleError:detail||null,googleDescription:description||null},null,2));
      }catch{}
      const extra=detail?`<br><b>Google:</b> ${escapeHtml(detail)}${description?` — ${escapeHtml(description)}`:''}`:'';
      sendPage(false,`لم يكتمل حفظ الربط على هذا الجهاز.<br><b>رمز البرنامج:</b> ${escapeHtml(code)}${extra}<br><br>ارجع إلى Dental Chain Controller.`);
      throw e;
    }finally{closeListener();}
  }
  disconnect(){this.access=null;for(const f of [this.tokenFile])try{fs.unlinkSync(f);}catch{}this.meta={contactsEnabled:false};this.persistMeta();return this.status();}
  async token(force=false){
    if(!force&&this.access&&this.access.expiresAt>Date.now()+30000)return this.access.token;const refresh=this.encryptedRefresh();if(!refresh)throw Object.assign(new Error('google_not_connected'),{code:'google_not_connected'});
    const clientSecret=this.clientSecret();if(!clientSecret)throw Object.assign(new Error('google_client_secret_missing_local'),{code:'google_client_secret_missing_local'});
    const body=new URLSearchParams({client_id:this.clientId,client_secret:clientSecret,refresh_token:refresh,grant_type:'refresh_token'});
    const r=await this.fetch(GOOGLE_TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json'},body:body.toString(),signal:AbortSignal.timeout(30000)});
    const data=await r.json().catch(()=>({}));
    if(!r.ok||!data.access_token){
      const detail=`${clean(data.error)} ${clean(data.error_description)}`;
      if(/invalid_client|client_secret/i.test(detail)){this.clearClientSecret();throw Object.assign(new Error('google_client_secret_reenter_required'),{code:'google_client_secret_reenter_required',status:r.status});}
      throw Object.assign(new Error('google_reconnect_required'),{code:'google_reconnect_required',status:r.status});
    }
    this.access={token:data.access_token,expiresAt:Date.now()+Math.max(60,Number(data.expires_in||3600)-60)*1000};return this.access.token;
  }
  async gfetch(url,options={},retry=true){const token=await this.token();const r=await this.fetch(url,{...options,headers:{...(options.headers||{}),Authorization:`Bearer ${token}`},signal:options.signal||AbortSignal.timeout(65000)});if(r.status===401&&retry){this.access=null;return this.gfetch(url,options,false);}return r;}
  async json(url,options={}){const r=await this.gfetch(url,options);const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(`google_http_${r.status}`),{code:`google_http_${r.status}`,status:r.status,details:data});return data;}
  async testDrive(){const d=await this.json(`${DRIVE}/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)`);this.meta.lastDriveTestAt=Date.now();this.persistMeta();return {ok:true,email:d.user?.emailAddress||this.meta.email||'',storageQuota:d.storageQuota||{}};}
  async testPeople(){
    // Test the exact Contacts permission the app actually uses. Calling people.get('people/me')
    // can require profile-oriented scopes that DTDC intentionally does not request.
    const q=new URLSearchParams({personFields:'names,phoneNumbers',pageSize:'1'});
    try{
      const d=await this.json(`${PEOPLE}/people/me/connections?${q}`);
      return {ok:true,connections:Array.isArray(d.connections)?d.connections.length:0};
    }catch(e){
      const details=e?.details?.error?.details||[];
      const reason=details.find(x=>x&&x.reason)?.reason||'';
      const status=e?.details?.error?.status||'';
      if(reason==='SERVICE_DISABLED')throw Object.assign(new Error('People API غير مفعلة على مشروع Google Cloud. فعّل People API ثم أعد الاختبار.'),{code:'google_people_api_disabled',status:e.status,details:e.details});
      if(reason==='ACCESS_TOKEN_SCOPE_INSUFFICIENT'||status==='PERMISSION_DENIED')throw Object.assign(new Error('صلاحية Google Contacts غير موجودة في الربط الحالي. اضغط إعادة ربط Google ووافق على صلاحية جهات الاتصال ثم أعد الاختبار.'),{code:'google_contacts_scope_missing',status:e.status,details:e.details});
      throw e;
    }
  }
  async testUpload(){const root=await this.ensureFolder('DTDC Patients','','root:v2'),body=Buffer.from('Dental Chain OS Google Drive connection test\n','utf8'),meta={name:'DTDC Connection Test.txt',parents:[root],appProperties:{dtdcKey:'connection-test'}};const boundary='dtdc_'+crypto.randomBytes(12).toString('hex'),payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`),body,Buffer.from(`\r\n--${boundary}--`)]);const r=await this.gfetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,size`,{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`,'Content-Length':String(payload.length)},body:payload});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(`google_http_${r.status}`),{code:`google_http_${r.status}`,status:r.status});return {ok:true,...data};}
  async findFolder(name,parent='',appKey=''){
    const q=["mimeType='application/vnd.google-apps.folder'","trashed=false",`name='${escapeDrive(name)}'`];if(parent)q.push(`'${escapeDrive(parent)}' in parents`);const u=new URL(`${DRIVE}/files`);u.searchParams.set('q',q.join(' and '));u.searchParams.set('spaces','drive');u.searchParams.set('fields','files(id,name,appProperties)');const data=await this.json(u);return (data.files||[]).find(f=>!appKey||f.appProperties?.dtdcKey===appKey)||null;
  }
  async ensureFolder(name,parent='',appKey=''){
    const found=await this.findFolder(name,parent,appKey);if(found)return found.id;const body={name,mimeType:'application/vnd.google-apps.folder',appProperties:{dtdcKey:appKey||name}};if(parent)body.parents=[parent];const u=`${DRIVE}/files?fields=id`;const data=await this.json(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return data.id;
  }
  async patientFolder(spec){const root=await this.ensureFolder('DTDC Patients','','root:v2'),clinic=await this.ensureFolder(spec.clinicId,root,`clinic:${spec.clinicId}`),patient=await this.ensureFolder(spec.patientId,clinic,`patient:${spec.clinicId}:${spec.patientId}`);const category=spec.category==='xrays'?'X-Rays':spec.category==='photos'?'Photos':'Documents';return this.ensureFolder(category,patient,`category:${spec.clinicId}:${spec.patientId}:${category}`);}
  async beginUpload(spec){const parent=await this.patientFolder(spec);const meta={name:spec.name,parents:[parent],appProperties:{dtdcClinicId:spec.clinicId,dtdcPatientId:spec.patientId,dtdcSha256:spec.sha256,dtdcCategory:spec.category||'attachments',dtdcRelativePath:clean(spec.relativePath).slice(0,120)}};const r=await this.gfetch(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id,size,mimeType,appProperties`,{method:'POST',headers:{'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':spec.mimeType,'X-Upload-Content-Length':String(spec.size)},body:JSON.stringify(meta)});if(!r.ok)throw Object.assign(new Error(`google_http_${r.status}`),{code:`google_http_${r.status}`,status:r.status});const location=r.headers.get('location');if(!location)throw new Error('drive_upload_session_missing');return location;}
  async uploadChunk(sessionUrl,chunk,start,total,mimeType){const end=start+chunk.length-1;const r=await this.gfetch(sessionUrl,{method:'PUT',headers:{'Content-Type':mimeType,'Content-Length':String(chunk.length),'Content-Range':`bytes ${start}-${end}/${total}`},body:chunk},false);if(r.status===308){const range=r.headers.get('range');const m=range&&range.match(/bytes=0-(\d+)/);return {done:false,next:m?Number(m[1])+1:end+1};}const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(`google_http_${r.status}`),{code:`google_http_${r.status}`,status:r.status});return {done:true,next:total,file:data};}
  async downloadFile(fileId){const r=await this.gfetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`);if(!r.ok)throw Object.assign(new Error(`google_http_${r.status}`),{code:`google_http_${r.status}`,status:r.status});return Buffer.from(await r.arrayBuffer());}
  async firestore(pathName,{method='GET',body,query=''}={}){const s=this.session;if(!s?.token||!s.projectId)throw Object.assign(new Error('session_changed'),{code:'session_changed'});const base=`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(s.projectId)}/databases/(default)/documents/${pathName}${query}`;const r=await this.fetch(base,{method,headers:{Authorization:`Bearer ${s.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data?.error?.message||`firestore_http_${r.status}`),{code:`firestore_http_${r.status}`,status:r.status});return data;}
  async putMedia(spec,driveFileId,status='uploaded'){const id=crypto.createHash('sha256').update(JSON.stringify([spec.clinicId,spec.patientId,spec.planId||'',spec.category||'attachments',spec.sha256])).digest('hex'),data={id,clinicId:spec.clinicId,patientId:spec.patientId,planId:spec.planId||'',driveFileId,fileName:spec.name,mimeType:spec.mimeType,size:spec.size,sha256:spec.sha256,category:spec.category||'attachments',relativePath:spec.relativePath||spec.name,uploadedAt:Date.now(),uploadedBy:this.session?.uid||'',status};return this.firestore(`clinics/${encodeURIComponent(spec.clinicId)}/patients/${encodeURIComponent(spec.patientId)}/cloudMedia/${id}`,{method:'PATCH',body:{fields:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,fireValue(v)]))}}).then(()=>data);}
  async listMedia(clinicId,patientId){const data=await this.firestore(`clinics/${encodeURIComponent(clinicId)}/patients/${encodeURIComponent(patientId)}/cloudMedia`,{query:'?pageSize=1000'});return (data.documents||[]).map(docData).filter(Boolean).map(row=>({...row,driveFileId:row.driveFileId||row.fileId||'',fileName:row.fileName||row.name||'attachment',uploadedAt:row.uploadedAt||row.createdAt||0,status:row.status==='complete'?'legacy':row.status})).filter(row=>row.driveFileId).sort((a,b)=>(b.uploadedAt||0)-(a.uploadedAt||0));}
  async getIntegration(clinicId,patientId){try{return docData(await this.firestore(`clinics/${encodeURIComponent(clinicId)}/patients/${encodeURIComponent(patientId)}/integrations/googleContact`));}catch(e){if(e.status===404)return null;throw e;}}
  async putIntegration(clinicId,patientId,data){const row={clinicId,patientId,...data};await this.firestore(`clinics/${encodeURIComponent(clinicId)}/patients/${encodeURIComponent(patientId)}/integrations/googleContact`,{method:'PATCH',body:{fields:Object.fromEntries(Object.entries(row).map(([k,v])=>[k,fireValue(v)]))}});return row;}
  async getPatient(clinicId,patientId){return docData(await this.firestore(`clinics/${encodeURIComponent(clinicId)}/patients/${encodeURIComponent(patientId)}`));}
  async listPatients(clinicId){let token='',out=[];do{const q=`?pageSize=500${token?`&pageToken=${encodeURIComponent(token)}`:''}`;const d=await this.firestore(`clinics/${encodeURIComponent(clinicId)}/patients`,{query:q});out.push(...(d.documents||[]).map(docData).filter(Boolean));token=d.nextPageToken||'';}while(token);return out;}
  setContactsEnabled(enabled){this.meta.contactsEnabled=enabled===true;this.persistMeta();if(this.meta.contactsEnabled)void this.flushContacts();return this.status();}
  queuePatient(patient){const clinicId=clean(patient?.clinicId),patientId=clean(patient?.id||patient?.patientId);if(!clinicId||!patientId)return false;const key=`${clinicId}:${patientId}`,hasSnapshot=Boolean(clean(patient.name||patient.fullName)||normalizePhone(patient.phone)),stamp=hasSnapshot?JSON.stringify([clean(patient.name||patient.fullName),normalizePhone(patient.phone)]):`fetch:${Date.now()}`;const row=this.contactRows.find(r=>r.key===key);if(row){if(row.stamp!==stamp||!hasSnapshot){Object.assign(row,{stamp,status:'pending',queuedAt:Date.now(),lastError:''});}}else this.contactRows.push({key,clinicId,patientId,stamp,status:'pending',queuedAt:Date.now(),attempts:0});this.persistContacts();if(this.meta.contactsEnabled)void this.flushContacts();return true;}
  async queueClinic(clinicId){const patients=await this.listPatients(clinicId);for(const p of patients)this.queuePatient({...p,clinicId,id:p.id||p.patientId});void this.flushContacts();return {queued:patients.length};}
  contactReport(clinicId){return this.contactRows.filter(r=>!clinicId||r.clinicId===clinicId).map(({key,...r})=>r);}
  async scanContacts(){const out=[];let page='';do{const q=new URLSearchParams({personFields:'names,phoneNumbers,userDefined,metadata',pageSize:'1000'});if(page)q.set('pageToken',page);const d=await this.json(`${PEOPLE}/people/me/connections?${q}`);out.push(...(d.connections||[]));page=d.nextPageToken||'';}while(page);return out;}
  async syncOneContact(row,connections){const p=await this.getPatient(row.clinicId,row.patientId);if(!p)throw new Error('patient_not_found');const name=clean(p.name||p.fullName)||row.patientId,phone=normalizePhone(p.phone),identity=`${row.clinicId}:${row.patientId}`,integration=await this.getIntegration(row.clinicId,row.patientId);let existing=null;
    if(integration?.resourceName){try{existing=await this.json(`${PEOPLE}/${integration.resourceName}?personFields=names,phoneNumbers,userDefined,metadata`);}catch(e){if(e.status!==404)throw e;}}
    if(!existing){
      existing=(connections||[]).find(c=>(c.userDefined||[]).some(x=>x.key==='DTDC Patient ID'&&x.value===identity))||null;
      if(!existing&&phone){
        const wantedNames=new Set([name,`DTDC - ${name}`].map(v=>clean(v).toLocaleLowerCase()));
        existing=(connections||[]).find(c=>{
          const samePhone=(c.phoneNumbers||[]).some(x=>normalizePhone(x.value)===phone);
          const candidateNames=(c.names||[]).flatMap(x=>[x.displayName,x.givenName]).filter(Boolean).map(v=>clean(v).toLocaleLowerCase());
          return samePhone&&candidateNames.some(v=>wantedNames.has(v));
        })||null;
      }
    }
    const person={names:[{givenName:`DTDC - ${name}`}],phoneNumbers:phone?[{value:phone}]:[],userDefined:[{key:'DTDC Patient ID',value:identity},{key:'DTDC Clinic ID',value:row.clinicId}]};let saved;
    if(existing?.resourceName){
      person.etag=existing.etag;
      if(existing.metadata)person.metadata=existing.metadata;
      const fields='names,phoneNumbers,userDefined';
      saved=await this.json(`${PEOPLE}/${existing.resourceName}:updateContact?updatePersonFields=${encodeURIComponent(fields)}&personFields=${encodeURIComponent(fields+',metadata')}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(person)});
    }else{
      saved=await this.json(`${PEOPLE}/people:createContact?personFields=names,phoneNumbers,userDefined,metadata`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(person)});
      if(saved?.resourceName)(connections||[]).push(saved);
    }
    await this.putIntegration(row.clinicId,row.patientId,{resourceName:saved.resourceName||existing?.resourceName||'',etag:saved.etag||'',syncStatus:'synced',syncedAt:Date.now(),name,phone});return saved;
  }
  async flushContacts(){if(this.contactsRunning||!this.meta.contactsEnabled||!this.status().connected||!this.session)return;this.contactsRunning=true;try{const connections=await this.scanContacts();for(const row of this.contactRows.filter(r=>r.status!=='done')){try{row.attempts=(row.attempts||0)+1;await this.syncOneContact(row,connections);row.status='done';row.lastError='';row.syncedAt=Date.now();try{const p=await this.getPatient(row.clinicId,row.patientId);row.stamp=JSON.stringify([clean(p?.name||p?.fullName),normalizePhone(p?.phone)]);}catch{}this.meta.lastContactSyncAt=row.syncedAt;this.persistMeta();this.persistContacts();}catch(e){row.status='retry';row.lastError=e.code||e.message;this.persistContacts();if([401,403].includes(e.status))break;await sleep(250);}}}finally{this.contactsRunning=false;}}
}
module.exports={GoogleLocalService,SCOPES,fireValue,docData,normalizePhone};
