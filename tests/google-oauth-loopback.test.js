'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const Module=require('node:module');

const originalLoad=Module._load;
let openedRedirect='';
let callbackHtml='';
Module._load=function(request,parent,isMain){
  if(request==='electron')return {
    safeStorage:{
      isEncryptionAvailable:()=>true,
      encryptString:s=>Buffer.from('enc:'+Buffer.from(s).toString('base64')),
      decryptString:b=>Buffer.from(String(b).slice(4),'base64').toString()
    },
    shell:{openExternal:async authUrl=>{
      const u=new URL(authUrl);
      const redirect=u.searchParams.get('redirect_uri');
      const state=u.searchParams.get('state');
      openedRedirect=redirect;
      await new Promise((resolve,reject)=>{
        http.get(`${redirect}/?code=test-code&state=${encodeURIComponent(state)}`,res=>{
          let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>{callbackHtml=body;resolve();});
        }).on('error',reject);
      });
      return true;
    }}
  };
  return originalLoad.call(this,request,parent,isMain);
};
const {GoogleLocalService}=require('../src/main/google-local');
Module._load=originalLoad;

function jsonResponse(status,obj){const raw=JSON.stringify(obj);return {ok:status>=200&&status<300,status,json:async()=>obj,text:async()=>raw};}

test('Desktop OAuth uses root loopback redirect and only reports browser success after local token persistence',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dtdc-oauth-loop-'));
  const cfg=path.join(dir,'oauth.json');
  fs.writeFileSync(cfg,JSON.stringify({desktopClientId:'1234567890-abc.apps.googleusercontent.com',expectedEmail:'dr.taheralajaclinic@gmail.com'}));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const fetchImpl=async(url,options)=>{
    if(String(url).includes('/token')){
      const body=String(options.body);
      assert.match(body,/redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+(?:&|$)/);
      assert.doesNotMatch(body,/oauth2%2Fcallback/);
      assert.match(body,/client_secret=desktop-client-secret/);
      return jsonResponse(200,{access_token:'access',refresh_token:'refresh',expires_in:3600,scope:'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/contacts'});
    }
    if(String(url).includes('openidconnect.googleapis.com'))return jsonResponse(200,{email:'dr.taheralajaclinic@gmail.com',sub:'sub1'});
    throw new Error('unexpected_fetch:'+url);
  };
  const g=new GoogleLocalService({directory:dir,configFile:cfg,fetchImpl});
  g.saveClientSecret('desktop-client-secret');
  const result=await g.connect();
  for(let i=0;i<20&&!callbackHtml;i++)await new Promise(r=>setTimeout(r,5));
  assert.match(openedRedirect,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(new URL(openedRedirect).pathname,'/');
  assert.equal(result.connected,true);
  assert.equal(result.email,'dr.taheralajaclinic@gmail.com');
  assert.equal(fs.existsSync(g.tokenFile),true);
  assert.match(callbackHtml,/تم ربط Google بنجاح/);
});


test('token exchange failure exposes Google sub-error without persisting secrets',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dtdc-oauth-detail-'));
  const cfg=path.join(dir,'oauth.json');
  fs.writeFileSync(cfg,JSON.stringify({desktopClientId:'1234567890-abc.apps.googleusercontent.com',expectedEmail:'dr.taheralajaclinic@gmail.com'}));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  callbackHtml='';
  let seenBody='';
  const fetchImpl=async(url,options)=>{
    if(String(url).includes('/token')){
      seenBody=String(options.body||'');
      return jsonResponse(400,{error:'invalid_grant',error_description:'Missing code verifier'});
    }
    throw new Error('unexpected_fetch:'+url);
  };
  const g=new GoogleLocalService({directory:dir,configFile:cfg,fetchImpl});
  g.saveClientSecret('desktop-client-secret');
  await assert.rejects(()=>g.connect(),e=>e&&e.code==='google_token_exchange_failed'&&e.oauthError==='invalid_grant'&&e.oauthDescription==='Missing code verifier');
  assert.match(seenBody,/code_verifier=[A-Za-z0-9_-]{43,128}/);
  assert.match(seenBody,/client_secret=desktop-client-secret/);
  for(let i=0;i<30&&!callbackHtml;i++)await new Promise(r=>setTimeout(r,5));
  assert.match(callbackHtml,/invalid_grant/);
  assert.match(callbackHtml,/Missing code verifier/);
  const diag=JSON.parse(fs.readFileSync(g.oauthDiagFile,'utf8'));
  assert.equal(diag.googleError,'invalid_grant');
  assert.equal(diag.googleDescription,'Missing code verifier');
  const rawDiag=fs.readFileSync(g.oauthDiagFile,'utf8');
  assert.doesNotMatch(rawDiag,/test-code|code_verifier|access_token|refresh_token/);
});


test('connect fails locally before opening browser when the encrypted Desktop client secret is missing',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dtdc-oauth-secret-missing-'));
  const cfg=path.join(dir,'oauth.json');
  fs.writeFileSync(cfg,JSON.stringify({desktopClientId:'1234567890-abc.apps.googleusercontent.com'}));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  openedRedirect='';callbackHtml='';
  const g=new GoogleLocalService({directory:dir,configFile:cfg,fetchImpl:async()=>{throw new Error('must_not_fetch');}});
  await assert.rejects(()=>g.connect(),e=>e&&e.code==='google_client_secret_missing_local');
  assert.equal(openedRedirect,'');
});
