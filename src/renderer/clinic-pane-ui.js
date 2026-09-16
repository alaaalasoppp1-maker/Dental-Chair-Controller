'use strict';
(()=>{
  const byId=id=>document.getElementById(id),report=e=>note({message:e.message||'تعذر إتمام العملية',type:'error'});
  byId('openClinicPane').onclick=()=>chairAPI.toggleClinic(true).catch(report);
  byId('clinicPaneToolbar').addEventListener('click',event=>{const action=event.target.closest('[data-clinic-action]')?.dataset.clinicAction;if(action)(action==='close'?chairAPI.toggleClinic(false):chairAPI.clinicAction(action)).catch(report);});
  chairAPI.onClinicState(state=>{byId('clinicPaneToolbar').hidden=!state.open;byId('openClinicPane').hidden=state.open;byId('clinicPaneStatus').textContent=state.message||'';});
  byId('archiveCloudUpload').onclick=async()=>{try{const result=await chairAPI.queuePatientCloudArchive();note({message:`أُضيف ${result.queued} ملفاً لطابور الرفع. سجّل الدخول وفعّل رفع الصور من البرنامج الرئيسي داخل الكونترولر. تبقى النسخ الأصلية محفوظة.`,type:'success'});}catch(e){report(e);}};
  let edge=null;
  document.addEventListener('pointerdown',e=>{edge=e.clientX>innerWidth-32?{x:e.clientX,y:e.clientY}:null;},{passive:true});
  document.addEventListener('pointerup',e=>{if(edge&&edge.x-e.clientX>90&&Math.abs(edge.y-e.clientY)<70)chairAPI.toggleClinic(true).catch(report);edge=null;},{passive:true});
})();
