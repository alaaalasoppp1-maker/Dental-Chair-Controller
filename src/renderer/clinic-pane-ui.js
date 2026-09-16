'use strict';
(()=>{
  const byId=id=>document.getElementById(id),report=e=>note({message:e.message||'تعذر إتمام العملية',type:'error'});
  byId('openClinicPane').onclick=()=>chairAPI.toggleClinic(true).catch(report);
  byId('clinicPaneToolbar').addEventListener('click',event=>{const action=event.target.closest('[data-clinic-action]')?.dataset.clinicAction;if(action)(action==='close'?chairAPI.toggleClinic(false):chairAPI.clinicAction(action)).catch(report);});
  chairAPI.onClinicState(state=>{byId('clinicPaneToolbar').hidden=!state.open;byId('openClinicPane').hidden=state.open;byId('clinicPaneStatus').textContent=state.message||'';});
  byId('archiveCloudUpload').onclick=async()=>{try{const result=await chairAPI.queuePatientCloudArchive();note({message:`أُضيف ${result.queued} ملفاً لطابور الرفع. سجّل الدخول وفعّل رفع الصور من البرنامج الرئيسي داخل الكونترولر. تبقى النسخ الأصلية محفوظة.`,type:'success'});}catch(e){report(e);}};
  DTDCEdgeSwipe.install({window,edge:'right',enabled:()=>byId('clinicPaneToolbar').hidden,onSwipe:()=>chairAPI.toggleClinic(true).catch(report)});
})();
