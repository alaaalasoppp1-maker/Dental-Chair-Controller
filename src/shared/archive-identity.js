'use strict';
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('node:crypto'));
  else root.DCOS_ARCHIVE_IDENTITY=factory(null);
})(typeof window!=='undefined'?window:globalThis,function(nodeCrypto){
  function identity(value){
    const clinicId=String(value?.clinicId||''),patientId=String(value?.patientId||value?.id||'');
    if(!clinicId||!patientId||clinicId.length>200||patientId.length>200)throw Error('archive-identity-required');
    return {clinicId,patientId};
  }
  function matches(manifest,wanted){
    if(!manifest)return false;
    return String(manifest.clinicId||'')===wanted.clinicId&&String(manifest.patientId||manifest.id||'')===wanted.patientId;
  }
  function identityText(value){const id=identity(value);return JSON.stringify([id.clinicId,id.patientId])}
  function folderKeySync(value){return 'dtdc-'+nodeCrypto.createHash('sha256').update(identityText(value),'utf8').digest('hex')}
  async function folderKey(value){
    if(nodeCrypto)return folderKeySync(value);
    const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(identityText(value)));
    return 'dtdc-'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  return {identity,matches,folderKey,folderKeySync};
});
