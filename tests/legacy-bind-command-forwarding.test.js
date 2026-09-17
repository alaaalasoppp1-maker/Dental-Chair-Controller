'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('confirmed legacy archive bind is forwarded from command payload into PatientArchive.select',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','main','main.js'),'utf8');
  assert.match(source,/const allowLegacyBind=payload\?\.allowLegacyBind===true;/);
  assert.match(source,/archive\?\.select\(\{\.\.\.context\.patient,allowLegacyBind\}\)/);
});

test('successful legacy bind queues the selected patient archive for Drive migration',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','main','main.js'),'utf8');
  assert.match(source,/if\(allowLegacyBind&&state\.patient\?\.selected&&cloudQueue\)/);
  assert.match(source,/cloudQueue\.enqueueArchive\(state\.patient,knownPlanIds\)/);
});
