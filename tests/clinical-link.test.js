"use strict";
const assert=require("node:assert/strict");
const {CONTRACT_NAME,TRANSPORT_PROTOCOL,CLIENT_ROLES,SERVICE_IDS,contextFromCommand,normalizeAssistantSession,normalizeRole}=require("../src/shared/clinical-contract");

assert.equal(CONTRACT_NAME,"dtdc-clinical-link-v1");
assert.equal(TRANSPORT_PROTOCOL,4);
assert.equal(SERVICE_IDS.size,26);
assert.equal(normalizeRole("display"),CLIENT_ROLES.DISPLAY);
assert.equal(normalizeRole("doctor_assistant"),CLIENT_ROLES.ASSISTANT);
assert.equal(normalizeRole("untrusted"),CLIENT_ROLES.UNKNOWN);

const context=contextFromCommand({
  contextId:"context-test",
  patient:{patientId:"P-0001",fileNo:"P-0001",fullName:"مريض اختبار",sessionId:"chair-test"},
  plans:[
    {planId:"PLAN-1",serviceId:"fiber-post",serviceName:"وتد فايبر",tooth:"24",priority:"urgent",plannedSessions:2,steps:[{stageId:"fiber-post-1",text:"فتح الحجرة",done:false}]},
    {planId:"PLAN-DONE",serviceId:"cleaning",status:"done"}
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

console.log("Clinical Link contract tests passed.");
