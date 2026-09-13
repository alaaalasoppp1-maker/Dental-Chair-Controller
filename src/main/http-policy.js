'use strict';
const DEFAULT_ORIGINS=Object.freeze(['https://dr-taher-dental-chain.web.app','https://dr-taher-dental-chain.firebaseapp.com']);
function createHttpPolicy({origins=DEFAULT_ORIGINS,addresses=()=>[],clock=Date.now}={}){
  const allowedOrigins=new Set(origins),buckets=new Map();
  function allowed(req){
    const origin=req.headers.origin;if(origin&&!allowedOrigins.has(origin))return false;
    let host;try{host=new URL('http://'+req.headers.host).hostname.replace(/^\[|\]$/g,'')}catch{return false}
    return new Set(['localhost','127.0.0.1','::1',...addresses()]).has(host);
  }
  function rate(req){
    const now=clock(),key=String(req.socket.remoteAddress||''),old=buckets.get(key)||{tokens:90,at:now};
    old.tokens=Math.min(90,old.tokens+Math.max(0,now-old.at)/100);old.at=now;
    const ok=old.tokens>=1;if(ok)old.tokens--;buckets.set(key,old);
    if(buckets.size>256){for(const [id,item]of buckets){if(now-item.at>60000)buckets.delete(id)}if(buckets.size>256)buckets.delete(buckets.keys().next().value)}
    return ok;
  }
  function middleware(req,res,next){
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Origin');
    if(!allowed(req))return res.status(403).json({ok:false,error:'origin_or_host_not_allowed'});
    if(!rate(req)){res.setHeader('Retry-After','1');return res.status(429).json({ok:false,error:'request_limit'})}
    if(req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Access-Control-Allow-Private-Network','true')}
    res.setHeader('Access-Control-Allow-Headers','Content-Type, X-DTDC-Device-Id, X-DTDC-Display, X-DTDC-File-Name, X-DTDC-Mime-Type, X-DTDC-Media-Kind, X-DTDC-Patient-Id, X-DTDC-Plan-Id, X-DTDC-Session-Id, X-DTDC-Clinical-Context');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    if(req.method==='OPTIONS')return res.sendStatus(204);next();
  }
  return {middleware,allowed,rate};
}
module.exports={createHttpPolicy,DEFAULT_ORIGINS};
