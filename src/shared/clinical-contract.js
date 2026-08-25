"use strict";

const CONTRACT_NAME="dtdc-clinical-link-v1";
const CONTRACT_VERSION=1;
const TRANSPORT_PROTOCOL=4;
const CLIENT_ROLES=Object.freeze({DISPLAY:"display",ASSISTANT:"doctor_assistant",MAIN_OS:"main_os",UNKNOWN:"unknown"});
const SERVICE_IDS=new Set([
  "restoration","fiber-post","sensitivity","endo","retreatment","apicoectomy","fixed","veneer","metal-core","partial-denture","full-denture","fluoride","fissure-sealant","space-maintainer","cleaning","laser-whitening","home-whitening","clear-ortho","metal-ortho","periodontal-curettage","gingivectomy","frenectomy","cementation","extraction","implant","quick-sync"
]);

function text(value){return String(value??"").trim();}
function cleanObject(value){return value&&typeof value==="object"&&!Array.isArray(value)?value:{};}
function cleanArray(value){return Array.isArray(value)?value:[];}
function cleanTeeth(value){const items=Array.isArray(value)?value:String(value||"").split(/[،,;\s]+/);return[...new Set(items.map(text).filter(Boolean))];}
function normalizePatient(payload={}){
  const nested=cleanObject(payload.patient),fullName=text(nested.fullName||payload.fullName||payload.name),fileNo=text(nested.fileNo||payload.fileNo||payload.fileNumber);
  return{
    patientId:text(nested.patientId||payload.patientId||payload.id||fileNo),fileNo,fullName,
    firstName:text(nested.firstName||payload.firstName||payload.displayName||fullName.split(/\s+/)[0]),
    gender:["male","female"].includes(text(nested.gender||payload.gender).toLowerCase())?text(nested.gender||payload.gender).toLowerCase():"",
    doctorName:text(nested.doctorName||payload.doctorName),clinicId:text(nested.clinicId||payload.clinicId),clinicName:text(nested.clinicName||payload.clinicName),sessionId:text(nested.sessionId||payload.sessionId)
  };
}
function normalizePlan(plan={},index=0){
  const planId=text(plan.planId||plan.id||`plan-${index+1}`),requestedService=text(plan.serviceId||plan.layoutId),serviceId=SERVICE_IDS.has(requestedService)?requestedService:"quick-sync";
  const sourceTarget=cleanObject(plan.target),teeth=cleanTeeth(sourceTarget.teeth||plan.teeth||plan.tooth),requestedType=text(sourceTarget.type||plan.targetType);
  const targetType=["tooth","teeth","region","jaw","general"].includes(requestedType)?requestedType:(teeth.length>1?"teeth":teeth.length?"tooth":"general");
  const sourceStages=cleanArray(plan.stages).length?cleanArray(plan.stages):cleanArray(plan.steps);
  return{
    planId,serviceId,serviceName:text(plan.serviceName||plan.title||plan.name||"سنكرة خاصة"),category:text(plan.category||"general"),
    target:{type:targetType,teeth,region:text(sourceTarget.region||plan.region),jaw:text(sourceTarget.jaw||plan.jaw),label:text(sourceTarget.label||plan.targetLabel||plan.tooth)},
    tooth:teeth[0]||text(plan.tooth),teeth,priority:["normal","high","urgent"].includes(text(plan.priority))?text(plan.priority):"normal",
    plannedSessions:Math.max(1,Number(plan.plannedSessions||plan.sessions||1)||1),cost:Math.max(0,Number(plan.cost||0)||0),currency:text(plan.currency).toUpperCase()==="USD"?"USD":"SYP",
    note:text(plan.note||plan.notes),status:text(plan.status||"active")||"active",doctorName:text(plan.doctorName||plan.doctor),createdAt:text(plan.createdAt),updatedAt:text(plan.updatedAt),
    stages:sourceStages.map((stage,stageIndex)=>{const item=typeof stage==="string"?{title:stage}:cleanObject(stage);return{stageId:text(item.stageId||item.id||`${serviceId}-${stageIndex+1}`),index:stageIndex,title:text(item.title||item.text||`المرحلة ${stageIndex+1}`),done:Boolean(item.done),completedAt:text(item.completedAt)}})
  };
}
function contextFromCommand(payload={}){
  const patient=normalizePatient(payload),plans=cleanArray(payload.plans).filter(plan=>!["done","archived","deleted"].includes(text(plan.status))).map(normalizePlan);
  return{type:"assistant_patient_context",contract:CONTRACT_NAME,contractVersion:CONTRACT_VERSION,protocol:TRANSPORT_PROTOCOL,contextId:text(payload.contextId)||`${patient.patientId||patient.fileNo||"patient"}-${Date.now()}`,patient,plans,sentAt:text(payload.sentAt)||new Date().toISOString()};
}
function normalizeRole(value){const role=text(value).toLowerCase();return Object.values(CLIENT_ROLES).includes(role)?role:CLIENT_ROLES.UNKNOWN;}
function normalizeAssistantSession(value={},context=null){
  const payload=cleanObject(value),patient=cleanObject(payload.patient),activePatient=cleanObject(context?.patient);
  const patientId=text(payload.patientId||patient.patientId||activePatient.patientId),planId=text(payload.planId||payload.activePlanId),sessionId=text(payload.sessionId)||`assistant-${Date.now()}`;
  if(!patientId)throw new Error("patientId مطلوب");if(!planId)throw new Error("planId مطلوب");
  return{
    schema:"dtdc-assistant-session-v1",contract:CONTRACT_NAME,contractVersion:CONTRACT_VERSION,sessionId,patientId,fileNo:text(payload.fileNo||patient.fileNo||activePatient.fileNo),planId,
    serviceId:text(payload.serviceId||payload.activePlan?.serviceId),doctorName:text(payload.doctorName||activePatient.doctorName),status:text(payload.status||"completed"),
    startedAt:text(payload.startedAt),completedAt:text(payload.completedAt)||new Date().toISOString(),completedStageIds:cleanArray(payload.completedStageIds).map(text).filter(Boolean),
    currentStageId:text(payload.currentStageId),summary:text(payload.summary||payload.note),events:cleanArray(payload.events).slice(0,2000),media:cleanArray(payload.media||payload.images).slice(0,500)
  };
}

module.exports={CONTRACT_NAME,CONTRACT_VERSION,TRANSPORT_PROTOCOL,CLIENT_ROLES,SERVICE_IDS,normalizePatient,normalizePlan,contextFromCommand,normalizeRole,normalizeAssistantSession};
