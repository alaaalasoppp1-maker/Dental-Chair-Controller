'use strict';
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.DTDCEdgeSwipe=factory();
})(typeof window!=='undefined'?window:globalThis,function(){
  function install({window:w,edge,onSwipe,enabled=()=>true}){
    const doc=w.document,id='dtdc-swipe-'+edge;
    doc.getElementById(id)?.remove();
    const strip=doc.createElement('div');strip.id=id;strip.setAttribute('aria-hidden','true');
    // Reserve only the edge; charts, text selection and horizontal controls elsewhere keep their gestures.
    strip.style.cssText=`position:fixed;${edge}:0;top:58px;bottom:0;width:24px;z-index:79;touch-action:pan-y;user-select:none;`;
    const handle=doc.createElement('span');handle.style.cssText=`position:absolute;${edge}:4px;top:45%;height:64px;width:4px;border-radius:4px;background:#169cb980;pointer-events:none;`;
    strip.appendChild(handle);doc.body.appendChild(strip);
    let start=null;
    const reset=()=>{start=null;};
    const down=e=>{
      if(e.isPrimary===false){reset();return;}
      if(!enabled()||(e.pointerType==='mouse'&&e.button!==0)){reset();return;}
      const atEdge=edge==='right'?e.clientX>=w.innerWidth-32:e.clientX<=32;
      start=atEdge?{id:e.pointerId,x:e.clientX,y:e.clientY,at:Date.now()}:null;
      if(start)try{e.target.setPointerCapture(e.pointerId);}catch{}
    };
    const move=e=>{
      if(!start||e.pointerId!==start.id)return;
      const dx=edge==='right'?start.x-e.clientX:e.clientX-start.x,dy=Math.abs(e.clientY-start.y);
      if(dy>60||Date.now()-start.at>1500){reset();return;}
      if(dx>12&&dx>dy*1.8&&e.cancelable)e.preventDefault();
    };
    const up=e=>{
      if(!start||e.pointerId!==start.id)return;
      const gesture=start;reset();
      const dx=edge==='right'?gesture.x-e.clientX:e.clientX-gesture.x,dy=Math.abs(e.clientY-gesture.y);
      if(enabled()&&Date.now()-gesture.at<=1500&&dx>=Math.min(96,w.innerWidth*.14)&&dx>dy*1.8&&dy<60){
        e.preventDefault();e.stopPropagation();Promise.resolve(onSwipe()).catch(()=>{});
      }
    };
    const options={capture:true,passive:false};
    w.addEventListener('pointerdown',down,options);w.addEventListener('pointermove',move,options);w.addEventListener('pointerup',up,options);
    for(const event of ['pointercancel','blur','pagehide'])w.addEventListener(event,reset,true);
    return ()=>{reset();strip.remove();w.removeEventListener('pointerdown',down,true);w.removeEventListener('pointermove',move,true);w.removeEventListener('pointerup',up,true);for(const event of ['pointercancel','blur','pagehide'])w.removeEventListener(event,reset,true);};
  }
  return {install};
});
