'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const {install}=require('../src/shared/edge-swipe');
function setup(edge){
  const dom=new JSDOM('<body><input id="name"><canvas></canvas></body>',{pretendToBeVisual:true}),w=dom.window;w.innerWidth=1000;
  let count=0;const dispose=install({window:w,edge,onSwipe:()=>count++});
  const fire=(type,x,y=200,extra={})=>{const e=new w.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{clientX:x,clientY:y,pointerId:1,pointerType:'touch',isPrimary:true,button:0,...extra});w.document.getElementById('dtdc-swipe-'+edge).dispatchEvent(e);};
  return {w,fire,count:()=>count,close:()=>{dispose();w.close();}};
}
test('touch and pen edge swipes open in opposite directions and ignore ordinary scrolling and cancelled contacts',()=>{
  for(const edge of ['left','right']){const f=setup(edge);try{
    const from=edge==='left'?10:990,to=edge==='left'?160:840;
    f.fire('pointerdown',from);f.fire('pointermove',to);f.fire('pointerup',to);assert.equal(f.count(),1);
    f.fire('pointerdown',from,200,{pointerType:'pen'});f.fire('pointerup',to,205,{pointerType:'pen'});assert.equal(f.count(),2);
    f.fire('pointerdown',from);f.fire('pointermove',from,320);f.fire('pointerup',to,320);assert.equal(f.count(),2);
    f.fire('pointerdown',from);f.fire('pointercancel',from);f.fire('pointerup',to);assert.equal(f.count(),2);
    f.fire('pointerdown',from);f.fire('pointerdown',from,210,{pointerId:2,isPrimary:false});f.fire('pointerup',to);assert.equal(f.count(),2);
    f.fire('pointerdown',500);f.fire('pointerup',edge==='left'?650:350);assert.equal(f.count(),2);
    f.fire('pointerdown',from);f.fire('pointerup',to,200,{pointerId:2});assert.equal(f.count(),2);
  }finally{f.close();}}
});
