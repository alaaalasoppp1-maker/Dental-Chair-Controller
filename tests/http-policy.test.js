'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{createHttpPolicy}=require('../src/main/http-policy');
const request=(origin,host='127.0.0.1:8765')=>({headers:{...(origin?{origin}:{}),host},method:'GET',socket:{remoteAddress:'127.0.0.1'}});
function response(){return {headers:{},code:200,setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(data){this.body=data;return this},sendStatus(n){this.code=n}}}
test('a foreign webpage or null origin cannot read or command the local controller',()=>{
 const policy=createHttpPolicy(),req=request('https://foreign.invalid'),res=response();let called=false;policy.middleware(req,res,()=>called=true);
 assert.equal(called,false);assert.equal(res.code,403);assert.equal(res.headers['Access-Control-Allow-Origin'],undefined);
 assert.equal(policy.allowed(request('null')),false);assert.equal(policy.allowed(request('https://dr-taher-dental-chain.web.app.evil.invalid')),false);
});
test('the intended web origin and native clients work, but a rebinding hostname is rejected',()=>{
 const policy=createHttpPolicy({addresses:()=>['192.168.1.2']}),res=response();let called=false;
 policy.middleware(request('https://dr-taher-dental-chain.web.app'),res,()=>called=true);assert.equal(called,true);assert.equal(res.headers['Access-Control-Allow-Origin'],'https://dr-taher-dental-chain.web.app');
 assert.equal(policy.allowed(request(null,'192.168.1.2:8765')),true);assert.equal(policy.allowed(request(null,'rebound.invalid:8765')),false);
});
test('request bursts are bounded and recover without growing an unlimited queue',()=>{
 let at=0;const policy=createHttpPolicy({clock:()=>at}),req=request(null);for(let i=0;i<90;i++)assert.equal(policy.rate(req),true);assert.equal(policy.rate(req),false);at=100;assert.equal(policy.rate(req),true);
});
