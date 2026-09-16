(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DTDCCloudUpload=api;})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const CHUNK=1024*1024;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function retryable(error){return !error.status||error.status===429||error.status>=500||['operation_busy','offset_mismatch'].includes(error.code);}
  async function upload({spec,readChunk,api,onProgress=()=>{},active=()=>true,wait=sleep}){
    let state=null,failures=0;
    while(true){
      if(!active())throw Object.assign(new Error('session_changed'),{code:'session_changed'});
      try{
        if(!state)state=await api('/media/begin',{method:'POST',json:spec});
        if(!active())throw Object.assign(new Error('session_changed'),{code:'session_changed',status:403});
        if(state.complete){onProgress(spec.size);return state.media;}
        if(!Number.isSafeInteger(state.offset)||state.offset<0||state.offset>=spec.size)throw Object.assign(new Error('invalid_progress'),{status:400});
        const offset=state.offset,body=await readChunk(offset,Math.min(spec.size,offset+CHUNK));
        const next=await api('/media/upload/'+state.id,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Upload-Offset':String(offset)},body});
        if(!active())throw Object.assign(new Error('session_changed'),{code:'session_changed',status:403});
        if(!next.complete&&(!Number.isSafeInteger(next.offset)||next.offset<=offset||next.offset>spec.size))throw Object.assign(new Error('invalid_progress'),{status:502});
        state={...next,id:state.id};failures=0;onProgress(state.offset);
        if(state.complete)return state.media;
      }catch(error){
        if(!active()||!retryable(error)||++failures>5)throw error;
        state=null;await wait(Math.min(16000,1000*2**(failures-1)));
      }
    }
  }
  return {upload,CHUNK,retryable};
});
