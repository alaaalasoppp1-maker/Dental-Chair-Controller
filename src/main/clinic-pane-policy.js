'use strict';
function clinicURL(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search)throw new Error('clinic_url_invalid');return u.href;}
function ownPage(url,origin){try{const u=new URL(url);return u.origin===origin&&u.protocol==='https:';}catch{return false;}}
function externalURL(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw new Error('external_url_denied');return u.href;}
function planRequest(payload,current,plans){
  if(!payload||!current?.selected||!payload.planId||payload.clinicId!==current.clinicId||payload.patientId!==current.patientId||payload.sessionId!==current.sessionId)throw new Error('plan_scope_mismatch');
  const known=plans.find(p=>String(p.planId)===String(payload.planId));if(!known)throw new Error('plan_not_found');
  return {...known,clinicId:current.clinicId,patientId:current.patientId,sessionId:current.sessionId,planId:known.planId,title:known.title};
}
module.exports={clinicURL,ownPage,externalURL,planRequest};
