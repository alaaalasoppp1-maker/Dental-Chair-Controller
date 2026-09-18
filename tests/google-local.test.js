'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){if(request==='electron')return {safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('enc:'+Buffer.from(s).toString('base64')),decryptString:b=>Buffer.from(String(b).slice(4),'base64').toString()},shell:{openExternal:async()=>true}};return originalLoad.call(this,request,parent,isMain);};
const {GoogleLocalService,SCOPES,normalizePhone}=require('../src/main/google-local');Module._load=originalLoad;
test('local OAuth config uses Desktop client and safeStorage encrypts both client secret and refresh token',t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dtdc-google-')),cfg=path.join(dir,'oauth.json');fs.writeFileSync(cfg,JSON.stringify({desktopClientId:'1234567890-abc.apps.googleusercontent.com',expectedEmail:'clinic@example.com'}));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const g=new GoogleLocalService({directory:dir,configFile:cfg});assert.equal(g.status().configured,true);assert.equal(g.status().clientSecretConfigured,false);g.saveClientSecret('desktop-client-secret');assert.equal(g.status().clientSecretConfigured,true);const rawSecret=fs.readFileSync(g.clientSecretFile);assert(!rawSecret.includes(Buffer.from('desktop-client-secret')));assert.equal(g.clientSecret(),'desktop-client-secret');g.saveRefresh('refresh-secret-value');const raw=fs.readFileSync(g.tokenFile);assert(!raw.includes(Buffer.from('refresh-secret-value')));assert.equal(g.encryptedRefresh(),'refresh-secret-value');assert(SCOPES.includes('https://www.googleapis.com/auth/drive.file'));assert(SCOPES.includes('https://www.googleapis.com/auth/contacts'));});
test('phone normalization is stable for contact dedupe',()=>{assert.equal(normalizePhone('00 963 944-123-456'),'+963944123456');});
test('refresh-token exchange also sends the locally encrypted Desktop client secret',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dtdc-google-refresh-')),cfg=path.join(dir,'oauth.json');
  fs.writeFileSync(cfg,JSON.stringify({desktopClientId:'1234567890-abc.apps.googleusercontent.com'}));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let body='';
  const g=new GoogleLocalService({directory:dir,configFile:cfg,fetchImpl:async(url,options)=>{
    if(String(url).includes('/token')){body=String(options.body||'');return {ok:true,status:200,json:async()=>({access_token:'new-access',expires_in:3600})};}
    throw new Error('unexpected_fetch');
  }});
  g.saveClientSecret('desktop-client-secret');g.saveRefresh('refresh-secret-value');
  assert.equal(await g.token(true),'new-access');
  assert.match(body,/client_secret=desktop-client-secret/);assert.match(body,/refresh_token=refresh-secret-value/);
});
