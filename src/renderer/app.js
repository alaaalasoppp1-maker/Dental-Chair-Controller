const $=id=>document.getElementById(id);let timer,currentState={};
const labels={home:"ترحيب",patient:"مريض",image:"صورة",gif:"GIF",treatment_gif:"معالجة",video:"فيديو",pdf:"PDF",black:"أسود",services:"خدمات",game:"لعبة",treatment_plan:"خطة علاج"};

function render(s){
 currentState=s||{};$("clients").textContent=s.network?.clients||0;$("count").textContent=s.images?.count||0;
 $("position").textContent=s.images?.count?`${s.images.position}/${s.images.count}`:"—";
 $("mode").textContent=labels[s.display?.mode]||s.display?.mode||"ترحيب";
 $("url").textContent=s.network?.wsUrl||"—";$("folder").textContent=s.settings?.sensorFolder||"—";
 $("archiveRoot").textContent=s.patient?.archiveRoot||s.settings?.patientArchiveRoot||"المسار الافتراضي داخل Documents";
 $("current").textContent=s.images?.currentName||"—";if(document.activeElement!==$("doctor"))$("doctor").value=s.settings?.doctorName||"";
 $("launch").checked=!!s.settings?.launchAtLogin;$("minimized").checked=!!s.settings?.startMinimized;
 $("displayTheme").value=s.settings?.displayTheme||"dark";
 const connected=(s.network?.clients||0)>0;$("badge").classList.toggle("connected",connected);
 const connectionText=connected?`الشاشة متصلة (${s.network.clients})`:"بانتظار الشاشة";
 $("badge").querySelector("span").textContent=connectionText;$("drawerConnection").textContent=connectionText;
 renderTreatments(s.settings?.treatments||[]);
 const linked=!!s.patient?.selected;$("linkedPatient").classList.toggle("waiting",!linked);$("linkedPatient").classList.toggle("active",linked);
 $("linkedPatientName").textContent=linked?s.patient.fullName:"لم يتم تحديد مريض";$("linkedPatientFile").textContent=linked?`رقم الملف: ${s.patient.fileNo||"—"}`:"افتح ملفه من Dental Chain OS";
}
function note(n){const b=$("notice");b.textContent=n.message;b.className=`notice show ${n.type||""}`;clearTimeout(timer);timer=setTimeout(()=>b.className="notice",3200)}

function renderTreatments(items){
 const grid=$("treatmentsGrid"),empty=$("emptyTreatments");grid.innerHTML="";
 empty.style.display=items.length?"none":"block";
 items.forEach(item=>{
   const card=document.createElement("article");card.className="treatment-card";
   card.innerHTML=`<h3>${escapeHtml(item.name)}</h3><div class="actions"><button class="primary play-treatment">عرض</button><button class="edit-treatment">✎</button><button class="delete-treatment">🗑</button></div>`;
   card.querySelector(".play-treatment").onclick=()=>chairAPI.playTreatment(item.id);
   card.querySelector(".edit-treatment").onclick=()=>openTreatmentEditor(item);
   card.querySelector(".delete-treatment").onclick=async()=>{if(confirm(`حذف معالجة "${item.name}"؟`))await chairAPI.deleteTreatment(item.id)};
   grid.appendChild(card);
 });
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}

function openDrawer(){ $("settingsDrawer").classList.add("open");$("drawerBackdrop").classList.add("open") }
function closeDrawer(){ $("settingsDrawer").classList.remove("open");$("drawerBackdrop").classList.remove("open") }
function openHelp(){ $("helpModal").classList.add("open") }
function closeHelp(){ $("helpModal").classList.remove("open") }

function openTreatmentEditor(item=null){
 $("treatmentId").value=item?.id||"";$("treatmentName").value=item?.name||"";$("treatmentFile").value=item?.filePath||"";
 $("treatmentEditorTitle").textContent=item?"تعديل معالجة":"إضافة معالجة";$("treatmentModal").classList.add("open");
}
function closeTreatmentEditor(){ $("treatmentModal").classList.remove("open") }

$("openSettings").onclick=openDrawer;$("drawerBackdrop").onclick=closeDrawer;document.querySelector(".close-drawer").onclick=closeDrawer;
$("openHelp").onclick=openHelp;document.querySelector(".close-help").onclick=closeHelp;
$("addTreatment").onclick=()=>openTreatmentEditor();document.querySelector(".close-treatment").onclick=closeTreatmentEditor;

$("chooseTreatmentFile").onclick=async()=>{const path=await chairAPI.chooseTreatmentGif();if(path)$("treatmentFile").value=path};
$("saveTreatment").onclick=async()=>{
 try{
   await chairAPI.saveTreatment({id:$("treatmentId").value||Date.now(),name:$("treatmentName").value,filePath:$("treatmentFile").value});
   closeTreatmentEditor();note({message:"تم حفظ المعالجة",type:"success"});
 }catch(e){note({message:e.message||"تعذر حفظ المعالجة",type:"error"})}
};

$("folderBtn").onclick=()=>chairAPI.chooseSensorFolder();$("reindex").onclick=()=>chairAPI.reindex();
$("archiveRootBtn").onclick=()=>chairAPI.chooseArchiveRoot();
$("latest").onclick=()=>chairAPI.showLatest();$("prev").onclick=()=>chairAPI.showPrevious();$("next").onclick=()=>chairAPI.showNext();$("hide").onclick=()=>chairAPI.hide();
$("temp").onclick=()=>chairAPI.chooseTemporaryImage();$("gif").onclick=()=>chairAPI.chooseGif();$("video").onclick=()=>chairAPI.chooseVideo();$("pdf").onclick=()=>chairAPI.choosePdf();
$("zoomIn").onclick=()=>chairAPI.transform({zoom:.15});$("zoomOut").onclick=()=>chairAPI.transform({zoom:-.15});
$("left").onclick=()=>chairAPI.transform({dx:-70,dy:0});$("right").onclick=()=>chairAPI.transform({dx:70,dy:0});$("up").onclick=()=>chairAPI.transform({dx:0,dy:-70});$("down").onclick=()=>chairAPI.transform({dx:0,dy:70});$("reset").onclick=()=>chairAPI.resetView();
$("black").onclick=()=>chairAPI.showBlack();$("home").onclick=()=>chairAPI.showHome();$("services").onclick=()=>chairAPI.transform({type:"services"});$("end").onclick=()=>chairAPI.showHome();$("game").onclick=()=>chairAPI.startGame();
$("showPatient").onclick=()=>chairAPI.showPatient({displayName:$("patient").value,doctorName:$("doctor").value});
$("displayTheme").onchange=()=>chairAPI.setDisplayTheme($("displayTheme").value);
$("save").onclick=()=>chairAPI.saveSettings({doctorName:$("doctor").value,displayTheme:$("displayTheme").value,launchAtLogin:$("launch").checked,startMinimized:$("minimized").checked}).then(()=>note({message:"تم حفظ الإعدادات",type:"success"}));

chairAPI.onState(render);chairAPI.onNotice(note);chairAPI.getState().then(render);

$("showQr").onclick=async()=>{
  try{
    await chairAPI.showAppointmentQr({
      patientName:$("qrPatient").value,
      doctorName:$("qrDoctor").value,
      date:$("qrDate").value,
      time:$("qrTime").value,
      type:$("qrType").value,
      clinicName:$("qrClinic").value
    });
    note({message:"تم عرض QR الموعد",type:"success"});
  }catch(error){note({message:error.message||"تعذر إنشاء QR",type:"error"})}
};

$("rotateImage").onclick=()=>chairAPI.rotateImage();
