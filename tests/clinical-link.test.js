"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {CONTRACT_NAME,TRANSPORT_PROTOCOL,CLIENT_ROLES,SERVICE_IDS,contextFromCommand,normalizeAssistantSession,normalizeAssistantStage,normalizeRole}=require("../src/shared/clinical-contract");
const {PatientArchive}=require("../src/main/patient-archive");

const serverSource=fs.readFileSync(path.join(__dirname,"../src/main/server.js"),"utf8");
for(const token of ["/display/presence","/display/commands","/display/ack","displaySequence","X-DTDC-Clinical-Context","decodeClinicalContext"]){
  assert.ok(serverSource.includes(token),`missing reliable display token ${token}`);
}

assert.equal(CONTRACT_NAME,"dtdc-clinical-link-v1");
assert.equal(TRANSPORT_PROTOCOL,5);
assert.equal(SERVICE_IDS.size,26);
assert.equal(normalizeRole("display"),CLIENT_ROLES.DISPLAY);
assert.equal(normalizeRole("doctor_assistant"),CLIENT_ROLES.ASSISTANT);
assert.equal(normalizeRole("untrusted"),CLIENT_ROLES.UNKNOWN);

const context=contextFromCommand({
  contextId:"context-test",
  patient:{patientId:"P-0001",fileNo:"P-0001",fullName:"مريض اختبار",sessionId:"chair-test"},
  plans:[
    {planId:"PLAN-1",serviceId:"fiber-post",serviceName:"وتد فايبر",tooth:"24",priority:"urgent",plannedSessions:2,steps:[{stageId:"fiber-post-1",text:"فتح الحجرة",done:false}]},
    {planId:"PLAN-DONE",serviceId:"cleaning",status:"done"},
    {planId:"PLAN-CLOSED",serviceId:"cleaning",status:"closed"}
  ]
});
assert.equal(context.patient.patientId,"P-0001");
assert.equal(context.plans.length,1,"completed plans must not be sent back to the assistant");
assert.equal(context.plans[0].serviceId,"fiber-post");
assert.deepEqual(context.plans[0].target.teeth,["24"]);
assert.equal(context.plans[0].stages[0].stageId,"fiber-post-1");

const session=normalizeAssistantSession({sessionId:"S-1",patientId:"P-0001",planId:"PLAN-1",completedStageIds:["fiber-post-1"]},context);
assert.equal(session.schema,"dtdc-assistant-session-v1");
assert.deepEqual(session.completedStageIds,["fiber-post-1"]);
assert.throws(()=>normalizeAssistantSession({patientId:"P-0001"},context),/planId/);

const stage=normalizeAssistantStage({patientId:"P-0001",planId:"PLAN-1",stageId:"fiber-post-1",status:"completed"},context);
assert.equal(stage.completed,true);
assert.equal(stage.stageId,"fiber-post-1");
assert.throws(()=>normalizeAssistantStage({patientId:"P-0001",planId:"PLAN-1"},context),/stageId/);

const archiveRoot=fs.mkdtempSync(path.join(os.tmpdir(),"dtdc-archive-test-"));
try{
  const archive=new PatientArchive({app:{getPath:()=>archiveRoot},settings:{get:key=>key==="patientArchiveRoot"?archiveRoot:"",patch:()=>{}},onState:()=>{},onNotice:()=>{}});
  archive.select({patientId:"P-0001",fileNo:"P-0001",fullName:"مريض اختبار"});
  archive.saveAssistantStage({planId:"PLAN-1",serviceId:"fiber-post",serviceName:"وتد فايبر",stageId:"fiber-post-1",status:"completed",completed:true,completedAt:"2026-08-26T06:00:00.000Z",summary:"فتح الحجرة"});
  archive.saveAssistantResumeState({planId:"PLAN-1",serviceId:"fiber-post",serviceName:"وتد فايبر",progress:42,reachedStage:"تحديد القناة",completedActions:5,totalActions:12,resumeState:{screen:"layout",layoutStep:1,canals:[178,null],totalTreatmentMs:120000}});
  const savedMedia=archive.saveAssistantMedia({
    buffer:Buffer.from("test-image"),fileName:"canal.jpg",mimeType:"image/jpeg",kind:"xray",planId:"PLAN-1",sessionId:"S-1",
    clinicalContext:{serviceId:"fiber-post",treatment:"وتد فايبر",tooth:"24",stage:"تحديد القناة",captureContext:"القناة الحنكية"}
  });
  assert.equal(savedMedia.stage,"تحديد القناة");
  const detail=archive.clinicalPlanDetail("PLAN-1");
  assert.equal(detail.images.length,1);
  assert.equal(detail.xrayImages.length,1);
  assert.equal(detail.report.progress,42);
  assert.equal(detail.report.reachedStage,"تحديد القناة");
  assert.match(detail.events.find(item=>item.mediaPath===savedMedia.file).label,/صورة شعاعية/);
  assert.match(detail.events.find(item=>item.mediaPath===savedMedia.file).label,/السن 24/);
  assert.equal(archive.listClinicalPlans().plans[0].title,"وتد فايبر");
  archive.saveAssistantResumeState({planId:"DIAG-1",serviceId:"new-diagnosis",serviceName:"تشخيص جديد",progress:100,reachedStage:"التشخيص",resumeState:{activePlan:"new-diagnosis",screen:"diagnosis",totalTreatmentMs:15000}});
  archive.saveAssistantEvent({planId:"DIAG-1",serviceId:"new-diagnosis",kind:"diagnosis",text:"ألم عفوي، ألم ليلي",at:"2026-08-26T06:02:00.000Z"});
  const diagnosisDetail=archive.clinicalPlanDetail("DIAG-1");
  assert.equal(diagnosisDetail.report.showTreatmentMetrics,false,"diagnosis cards must not show anesthesia/restoration counters");
  assert.match(diagnosisDetail.report.notes[0].text,/ألم عفوي/);
  fs.writeFileSync(path.join(archive.current.folders.TreatmentPlans,"plan-background.jpg"),"not-patient-media");
  assert.ok(!archive.listArchive("all").items.some(item=>item.name==="plan-background.jpg"),"plan backgrounds must not leak into patient media");
  let restored=archive.reconcileAssistantContext(JSON.parse(JSON.stringify(context)));
  assert.equal(restored.plans[0].stages[0].done,true,"saved stage progress must survive a controller restart");
  assert.equal(restored.plans[0].resumeState.canals[0],178,"exact assistant plan state must survive a controller restart");
  archive.saveAssistantPlanClosure({planId:"PLAN-1",doctorName:"د. طاهر",closedAt:"2026-08-26T06:05:00.000Z"});
  restored=archive.reconcileAssistantContext(JSON.parse(JSON.stringify(context)));
  assert.equal(restored.plans.length,0,"closed plan must not return to the assistant");
  assert.equal(restored.closedPlans[0].planId,"PLAN-1","closed state must remain available to the main OS");
}finally{
  fs.rmSync(archiveRoot,{recursive:true,force:true});
}

console.log("Clinical Link contract tests passed.");
