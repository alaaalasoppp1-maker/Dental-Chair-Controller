const $=id=>document.getElementById(id);
let timer,currentState={},shortcutDraft={},shortcutDirty=new Set();
let archiveCategory="all",archiveSelected=null,archiveCompare=[];

const labels={home:"الواجهة الرئيسية",patient:"ترحيب مريض",image:"صورة",gif:"GIF",treatment_gif:"معالجة",treatment_plan:"خطة علاج",appointment_qr:"QR موعد",video:"فيديو",pdf:"PDF",black:"أسود",game:"لعبة"};
const shortcutMeta=[
  ["latest","أحدث صورة SOPRO","CommandOrControl+`"],
  ["home","شاشة الترحيب","CommandOrControl+H"],
  ["black","شاشة سوداء","CommandOrControl+B"],
  ["tempImage","بانوراما / صورة مؤقتة","CommandOrControl+I"],
  ["treatments","فتح شبكة المعالجات","CommandOrControl+G"],
  ["video","اختيار فيديو","CommandOrControl+V"],
  ["pdf","اختيار PDF","CommandOrControl+P"],
  ["game","لعبة الأطفال","CommandOrControl+L"],
  ["hide","إغلاق العرض","CommandOrControl+Escape"],
  ["previous","الصورة السابقة","CommandOrControl+PageUp"],
  ["next","الصورة التالية","CommandOrControl+PageDown"],
  ["zoomIn","تكبير الصورة","CommandOrControl+="],
  ["zoomOut","تصغير الصورة","CommandOrControl+-"],
  ["moveLeft","تحريك الصورة لليسار","CommandOrControl+Left"],
  ["moveRight","تحريك الصورة لليمين","CommandOrControl+Right"],
  ["moveUp","تحريك الصورة للأعلى","CommandOrControl+Up"],
  ["moveDown","تحريك الصورة للأسفل","CommandOrControl+Down"],
  ["resetView","إعادة ضبط الصورة","CommandOrControl+0"],
  ["rotate","تدوير الصورة 20°","CommandOrControl+Shift+8"]
];
const defaultShortcuts=Object.fromEntries(shortcutMeta.map(([key,,value])=>[key,value]));

function syncValue(id,value){const el=$(id);if(el&&document.activeElement!==el)el.value=value??""}
function prettyShortcut(value){
  if(!value)return "معطّل";
  const map={CommandOrControl:"Ctrl",Left:"←",Right:"→",Up:"↑",Down:"↓",PageUp:"Page Up",PageDown:"Page Down",Escape:"Esc"};
  return String(value).split("+").map(part=>map[part]||part).join(" + ");
}
function applyControllerTheme(theme){
  const value=theme==="light"?"light":"dark";
  document.body.dataset.controllerTheme=value;
  $("controllerTheme").value=value;
  document.querySelectorAll("[data-controller-theme]").forEach(button=>button.classList.toggle("active",button.dataset.controllerTheme===value));
  const toggle=$("controllerThemeToggle");
  toggle.querySelector(".theme-icon").textContent=value==="dark"?"☀":"🌙";
  toggle.querySelector(".theme-label").textContent=value==="dark"?"فاتح":"داكن";
  toggle.title=value==="dark"?"الانتقال إلى الوضع الفاتح":"الانتقال إلى الوضع الداكن";
}
function applyDisplayThemeChoice(theme){
  const value=["dark","light","auto"].includes(theme)?theme:"dark";
  $("displayTheme").value=value;
  document.querySelectorAll("[data-display-theme]").forEach(button=>button.classList.toggle("active",button.dataset.displayTheme===value));
}

function render(s){
  currentState=s||{};$("clients").textContent=s.network?.displayClients??s.network?.clients??0;if($("assistantClients"))$("assistantClients").textContent=s.network?.assistantClients||0;$("count").textContent=s.images?.count||0;
  $("position").textContent=s.images?.count?`${s.images.position}/${s.images.count}`:"—";
  $("mode").textContent=labels[s.display?.mode]||s.display?.mode||"ترحيب";
  $("url").textContent=s.network?.wsUrl||"—";$("folder").textContent=s.settings?.sensorFolder||"—";
  if($("archiveRoot"))$("archiveRoot").textContent=s.patient?.archiveRoot||s.settings?.patientArchiveRoot||"مجلد المستندات الافتراضي";
  if(s.patient?.selected){syncValue("patient",s.patient.displayName||s.patient.fullName||"");if(s.patient.doctorName)syncValue("doctor",s.patient.doctorName);}
  $("current").textContent=s.images?.currentName||"—";syncValue("doctor",s.settings?.doctorName||"");
  ["chainName","displayTitle","clinicName","clinicDisplayName","homeEyebrow","specialty","welcomeText","comfortText","qrEventTitle","qrEventDescription","qrReminderMessage","qrReminderHours"].forEach(id=>syncValue(id,s.settings?.[id]??""));
  syncValue("clinicalPhrases",(s.settings?.clinicalPhrases||[]).join("\n"));
  syncValue("qrClinic",s.settings?.clinicName||"عيادة د. طاهر");
  $("launch").checked=!!s.settings?.launchAtLogin;$("minimized").checked=!!s.settings?.startMinimized;
  applyControllerTheme(s.settings?.controllerTheme||"dark");
  applyDisplayThemeChoice(s.settings?.displayTheme||"dark");
  syncShortcuts(s.settings?.shortcuts||defaultShortcuts);
  const displayCount=s.network?.displayClients??s.network?.clients??0,assistantCount=s.network?.assistantClients||0,connected=displayCount>0;$("badge").classList.toggle("connected",connected);
  const connectionText=`${connected?`الشاشة متصلة (${displayCount})`:"بانتظار الشاشة"} · ${assistantCount?`المساعد متصل (${assistantCount})`:"المساعد غير متصل"}`;
  $("badge").querySelector("span").textContent=connectionText;$("drawerConnection").textContent=connectionText;
  renderTreatments(s.settings?.treatments||[]);
  renderAssistants(s.network?.assistants||[],s.network?.selectedAssistantId||s.settings?.selectedAssistantId||"");
  renderDisplayAspect(s.settings?.displayAspectProfile||"standard",Number(s.settings?.displayAspectFactor||1));
}
function renderAssistants(items,selectedId){
  const list=$("assistantDeviceList");if(!list)return;list.innerHTML="";
  if(!items.length){list.innerHTML='<p class="setting-note">افتح تطبيق المساعد على شبكة العيادة ليظهر هنا.</p>';$("assistantPairingState").textContent="بانتظار جهاز";return;}
  $("assistantPairingState").textContent=selectedId?"تم اعتماد جهاز":"اختر جهازاً";
  items.forEach(item=>{const row=document.createElement("article");row.className=`assistant-device ${item.online?"online":""} ${item.deviceId===selectedId?"selected":""}`;row.innerHTML=`<div><strong>${escapeHtml(item.name||"مساعد الطبيب")}</strong><small>${escapeHtml(item.model||item.remote||item.deviceId)} · ${item.online?"متصل الآن":"غير متصل"}</small></div><button type="button" class="${item.deviceId===selectedId?"primary":""}">${item.deviceId===selectedId?"معتمد":"اعتماد"}</button>`;row.querySelector("button").onclick=async()=>{try{await chairAPI.selectAssistant(item.deviceId);note({message:`تم اعتماد ${item.name||"تطبيق المساعد"}`,type:"success"})}catch(error){note({message:error.message||"تعذر اعتماد الجهاز",type:"error"})}};list.appendChild(row)});
}
function renderDisplayAspect(profile,factor){
  document.querySelectorAll("[data-display-aspect]").forEach(button=>button.classList.toggle("active",button.dataset.displayAspect===profile));
  const slider=$("displayAspectFactor"),out=$("displayAspectValue");if(slider&&document.activeElement!==slider)slider.value=String(factor);if(out)out.textContent=Number(factor).toFixed(3);
}
function note(n){const b=$("notice");b.textContent=n.message;b.className=`notice show ${n.type||""}`;clearTimeout(timer);timer=setTimeout(()=>b.className="notice",3600)}

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

function renderShortcutEditor(){
  const editor=$("shortcutEditor");
  if(editor.children.length)return;
  shortcutMeta.forEach(([key,label])=>{
    const row=document.createElement("label");row.className="shortcut-row";
    row.innerHTML=`<span>${escapeHtml(label)}</span><input class="shortcut-input ltr" data-shortcut-key="${key}" readonly aria-label="${escapeHtml(label)}">`;
    const input=row.querySelector("input");
    input.addEventListener("focus",()=>{input.classList.add("recording");input.value="اضغط الاختصار الآن…"});
    input.addEventListener("blur",()=>{input.classList.remove("recording");input.value=prettyShortcut(shortcutDraft[key])});
    input.addEventListener("keydown",event=>recordShortcut(event,key,input));
    editor.appendChild(row);
  });
}
function syncShortcuts(values){
  renderShortcutEditor();
  shortcutMeta.forEach(([key])=>{
    if(!shortcutDirty.has(key))shortcutDraft[key]=values[key]??defaultShortcuts[key]??"";
    const input=document.querySelector(`[data-shortcut-key="${key}"]`);
    if(input&&document.activeElement!==input)input.value=prettyShortcut(shortcutDraft[key]);
  });
  renderShortcutHelp(shortcutDraft);
}
function acceleratorFromEvent(event){
  const modifiers=[];
  if(event.ctrlKey||event.metaKey)modifiers.push("CommandOrControl");
  if(event.altKey)modifiers.push("Alt");
  if(event.shiftKey)modifiers.push("Shift");
  const byCode={Backquote:"`",Minus:"-",Equal:"=",BracketLeft:"[",BracketRight:"]",Semicolon:";",Quote:"'",Comma:",",Period:".",Slash:"/",Backslash:"\\",Space:"Space",ArrowLeft:"Left",ArrowRight:"Right",ArrowUp:"Up",ArrowDown:"Down",PageUp:"PageUp",PageDown:"PageDown",Home:"Home",End:"End",Insert:"Insert",Escape:"Escape",Enter:"Enter",Tab:"Tab"};
  let key=byCode[event.code];
  if(!key&&/^Key[A-Z]$/.test(event.code))key=event.code.slice(3);
  if(!key&&/^Digit[0-9]$/.test(event.code))key=event.code.slice(5);
  if(!key&&/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code))key=event.code;
  if(!key||["ControlLeft","ControlRight","MetaLeft","MetaRight","AltLeft","AltRight","ShiftLeft","ShiftRight"].includes(event.code))return "";
  return [...modifiers,key].join("+");
}
function recordShortcut(event,key,input){
  event.preventDefault();event.stopPropagation();
  if(event.code==="Delete"||event.code==="Backspace"){
    shortcutDraft[key]="";shortcutDirty.add(key);input.blur();return;
  }
  const value=acceleratorFromEvent(event);
  if(!value)return;
  shortcutDraft[key]=value;shortcutDirty.add(key);input.value=prettyShortcut(value);input.blur();
}
function renderShortcutHelp(values){
  const help=$("shortcutHelp");help.innerHTML="";
  shortcutMeta.forEach(([key,label])=>{
    const kbd=document.createElement("kbd");kbd.textContent=prettyShortcut(values[key]);
    const span=document.createElement("span");span.textContent=label;
    help.append(kbd,span);
  });
}
function duplicateShortcut(values){
  const seen=new Map();
  for(const [key,label] of shortcutMeta){
    const value=String(values[key]||"").trim().toLowerCase();
    if(!value)continue;
    if(seen.has(value))return `${label} و${seen.get(value)}`;
    seen.set(value,label);
  }
  return "";
}


function formatDiagTime(value){if(!value)return "—";try{return new Date(value).toLocaleTimeString("ar",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}catch{return "—"}}
async function refreshDiagnostics(){
  try{
    const d=await chairAPI.getDiagnostics();
    $("diagServer").textContent=d.serverRunning?"يعمل":"متوقف";
    $("diagClients").textContent=d.displayClients??d.clients??0;if($("diagAssistant"))$("diagAssistant").textContent=d.assistantClients||0;
    $("diagAck").textContent=formatDiagTime(d.lastAckAt);
    $("diagLatency").textContent=Number.isFinite(d.lastAckLatencyMs)?`${d.lastAckLatencyMs} ms`:"—";
    $("diagPending").textContent=d.pendingAcks||0;
    $("diagError").textContent=d.lastFailedCommand||d.lastDisconnectReason||"لا يوجد";
    const log=$("diagnosticLog");log.innerHTML="";
    const items=(d.log||[]).slice(0,30);
    if(!items.length){log.innerHTML="<p>لا توجد أحداث بعد.</p>";return;}
    items.forEach(item=>{const row=document.createElement("div");row.className=`diagnostic-row ${item.level||"info"}`;row.innerHTML=`<time>${formatDiagTime(item.at)}</time><b>${escapeHtml(item.event||"")}</b><span>${escapeHtml(item.command||item.message||item.remote||"")}${Number.isFinite(item.latencyMs)?` · ${item.latencyMs} ms`:""}</span>`;log.appendChild(row);});
  }catch(error){note({message:error.message||"تعذر قراءة التشخيص",type:"error"});}
}

function openDrawer(){ $("settingsDrawer").classList.add("open");$("drawerBackdrop").classList.add("open");refreshDiagnostics() }
function closeDrawer(){ $("settingsDrawer").classList.remove("open");$("drawerBackdrop").classList.remove("open") }
function openHelp(){renderShortcutHelp(shortcutDraft);$("helpModal").classList.add("open") }
function closeHelp(){ $("helpModal").classList.remove("open") }

async function loadPatientArchive(category=archiveCategory){
  archiveCategory=category;
  try{
    const data=await chairAPI.listArchive(category);$("archivePatientLabel").textContent=`${data.patient.fullName||""}${data.patient.fileNo?` · ${data.patient.fileNo}`:""}`;$("archiveCount").textContent=`${data.items.length} ملف`;
    const cats=$("archiveCategories");cats.innerHTML="";(data.categories||[]).forEach(item=>{const button=document.createElement("button");button.type="button";button.textContent=item.label;button.classList.toggle("active",item.id===category);button.onclick=()=>loadPatientArchive(item.id);cats.appendChild(button)});
    const grid=$("archiveItems");grid.innerHTML="";if(!data.items.length){grid.innerHTML='<p class="empty-state">لا توجد ملفات ضمن هذا التصنيف.</p>';return;}
    data.items.forEach(item=>{const button=document.createElement("button");button.type="button";button.className=`archive-item ${archiveSelected?.path===item.path?"active":""}`;button.innerHTML=`<span class="archive-thumb">${item.kind==="image"?"🖼":item.kind==="audio"?"🎙":"📄"}</span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.category)} · ${new Date(item.modifiedAt).toLocaleDateString("ar")}</small>`;button.onclick=()=>selectArchiveItem(item,button);grid.appendChild(button);if(item.kind==="image")chairAPI.previewArchive(item.path).then(preview=>{const thumb=button.querySelector(".archive-thumb");if(thumb&&preview.dataUrl)thumb.innerHTML=`<img src="${preview.dataUrl}" alt="">`}).catch(()=>{})});
  }catch(error){note({message:error.message||"افتح ملف مريض أولاً",type:"error"});$("patientArchiveModal").classList.remove("open")}
}
async function selectArchiveItem(item,button){
  archiveSelected=item;document.querySelectorAll(".archive-item").forEach(el=>el.classList.remove("active"));button?.classList.add("active");const image=$("archivePreviewImage"),audio=$("archivePreviewAudio"),record=$("archivePreviewRecord"),empty=$("archivePreviewEmpty");image.style.display="none";audio.style.display="none";audio.pause();record.style.display="none";empty.style.display="block";$("archivePreviewName").textContent=item.name;$("archiveDisplay").disabled=item.kind!=="image";$("archiveCompare").disabled=item.kind!=="image";
  try{const preview=await chairAPI.previewArchive(item.path);if(preview.kind==="image"){image.src=preview.dataUrl;image.style.display="block";empty.style.display="none"}else if(preview.kind==="audio"){audio.src=preview.dataUrl;audio.style.display="block";empty.style.display="none"}}
  catch(error){note({message:error.message||"تعذر فتح المعاينة",type:"error"})}
}
function setArchiveMode(mode){const plans=mode==="plans";$("archiveMediaTab").classList.toggle("active",!plans);$("archivePlansTab").classList.toggle("active",plans);$("archiveMediaView").hidden=plans;$("archivePlansView").hidden=!plans;if(plans)loadClinicalPlans();else loadPatientArchive(archiveCategory)}
function openPatientArchive(){archiveSelected=null;archiveCompare=[];$("patientArchiveModal").classList.add("open");$("patientArchiveModal").setAttribute("aria-hidden","false");$("archiveComparePanel").hidden=true;setArchiveMode("media")}
function closePatientArchive(){$("patientArchiveModal").classList.remove("open");$("patientArchiveModal").setAttribute("aria-hidden","true")}
async function renderArchiveCompare(){
  const panel=$("archiveComparePanel"),grid=$("archiveCompareGrid");panel.hidden=!archiveCompare.length;grid.innerHTML="";
  for(const item of archiveCompare){const preview=await chairAPI.previewArchive(item.path);const figure=document.createElement("figure");figure.innerHTML=`<img src="${preview.dataUrl}" alt=""><figcaption>${escapeHtml(item.name)}</figcaption>`;grid.appendChild(figure)}
}
function clinicalDate(value){return new Date(value).toLocaleDateString("ar-SY",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}
function clinicalTime(value){return new Date(value).toLocaleTimeString("ar-SY",{hour:"numeric",minute:"2-digit"})}
async function loadClinicalPlans(){
  const list=$("clinicalPlansList"),detail=$("clinicalPlanDetail");detail.hidden=true;list.hidden=false;list.innerHTML='<p class="empty-state">جارِ قراءة سجل الخطط…</p>';
  try{const data=await chairAPI.listClinicalPlans();$("archivePatientLabel").textContent=`${data.patient.fullName||""}${data.patient.fileNo?` · ${data.patient.fileNo}`:""}`;list.innerHTML="";if(!data.plans.length){list.innerHTML='<p class="empty-state">لا توجد خطط منفذة ومسجلة من تطبيق المساعد بعد.</p>';return}data.plans.forEach(plan=>{const card=document.createElement("button");card.type="button";card.className="clinical-plan-card";card.innerHTML=`<small>${plan.status==="closed"?"خطة منتهية":"جلسات مسجلة"}</small><h3>${escapeHtml(plan.title||plan.planId)}</h3><span>${plan.lastActivityAt?clinicalDate(plan.lastActivityAt):""}</span><div class="plan-card-stats"><i>${plan.sessions} جلسة</i><i>${plan.events} حدث</i><i>${plan.media} وسائط</i></div>`;card.onclick=()=>openClinicalPlan(plan);list.appendChild(card)})}catch(error){list.innerHTML='<p class="empty-state">تعذر قراءة سجل الخطط.</p>';note({message:error.message||"تعذر فتح سجل الخطط",type:"error"})}
}
async function openClinicalPlan(plan){
  const list=$("clinicalPlansList"),detail=$("clinicalPlanDetail");list.hidden=true;detail.hidden=false;$("clinicalPlanTitle").textContent=plan.title||"سجل الخطة";$("clinicalPlanSummary").textContent=`${plan.sessions} جلسة · ${plan.events} حدث سريري`;
  try{const data=await chairAPI.getClinicalPlanDetail(plan.planId);renderClinicalTimeline(data.events||[]);renderClinicalPlanMedia(data.images||[],data.audio||[])}catch(error){note({message:error.message||"تعذر قراءة تفاصيل الخطة",type:"error"})}
}
function renderClinicalTimeline(events){
  const root=$("clinicalTimeline");root.innerHTML="";if(!events.length){root.innerHTML='<p class="empty-state">لا توجد أحداث مفصلة لهذه الخطة.</p>';return}const groups=new Map();events.forEach(event=>{const key=clinicalDate(event.at);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(event)});groups.forEach((items,date)=>{const section=document.createElement("section");section.className="timeline-day";section.innerHTML=`<h4>${escapeHtml(date)}</h4>`;items.forEach(event=>{const row=document.createElement("article");row.className="timeline-event";row.innerHTML=`<time>${clinicalTime(event.at)}</time><div><b>${escapeHtml(event.label)}</b>${event.stage?`<small>${escapeHtml(event.stage)}</small>`:""}</div><span class="timeline-media"></span>`;if(event.mediaPath){row.style.cursor="pointer";row.onclick=()=>openClinicalMedia(event.mediaPath);chairAPI.previewArchive(event.mediaPath).then(preview=>{if(preview.kind==="image")row.querySelector(".timeline-media").innerHTML=`<img src="${preview.dataUrl}" alt="فتح الصورة">`;else row.querySelector(".timeline-media").textContent="🎙"}).catch(()=>{})}section.appendChild(row)});root.appendChild(section)})
}
function renderClinicalPlanMedia(images,audio){
  const imageRoot=$("clinicalPlanImages"),audioRoot=$("clinicalPlanAudio");imageRoot.innerHTML=images.length?"":'<small>لا توجد صور.</small>';audioRoot.innerHTML=audio.length?"":'<small>لا توجد تسجيلات.</small>';
  images.forEach(item=>{const button=document.createElement("button");button.type="button";button.className="clinical-media-item";button.innerHTML=`<span>${escapeHtml(item.name)}</span>`;button.onclick=()=>openClinicalMedia(item.path);imageRoot.appendChild(button);chairAPI.previewArchive(item.path).then(preview=>{button.insertAdjacentHTML("afterbegin",`<img src="${preview.dataUrl}" alt="">`)}).catch(()=>{})});
  audio.forEach(item=>{const box=document.createElement("div");box.className="clinical-media-item audio";box.innerHTML=`<span>${escapeHtml(item.name)}</span>`;audioRoot.appendChild(box);chairAPI.previewArchive(item.path).then(preview=>{const player=document.createElement("audio");player.controls=true;player.src=preview.dataUrl;box.prepend(player)}).catch(()=>{})});
}
async function openClinicalMedia(path){
  try{const preview=await chairAPI.previewArchive(path);const overlay=document.createElement("div");overlay.className="clinical-lightbox";overlay.innerHTML=preview.kind==="image"?`<img src="${preview.dataUrl}" alt="الصورة السريرية"><button type="button">✕</button>`:`<audio controls autoplay src="${preview.dataUrl}"></audio><button type="button">✕</button>`;overlay.onclick=event=>{if(event.target===overlay||event.target.tagName==="BUTTON")overlay.remove()};$("patientArchiveModal").appendChild(overlay)}catch(error){note({message:error.message||"تعذر فتح الوسيط",type:"error"})}
}

function openTreatmentEditor(item=null){
  $("treatmentId").value=item?.id||"";$("treatmentName").value=item?.name||"";$("treatmentFile").value=item?.filePath||"";
  $("treatmentEditorTitle").textContent=item?"تعديل معالجة":"إضافة معالجة";$("treatmentModal").classList.add("open");
}
function closeTreatmentEditor(){ $("treatmentModal").classList.remove("open") }

$("openSettings").onclick=openDrawer;$("drawerBackdrop").onclick=closeDrawer;document.querySelector(".close-drawer").onclick=closeDrawer;
$("openHelp").onclick=openHelp;document.querySelector(".close-help").onclick=closeHelp;
$("openPatientArchive").onclick=openPatientArchive;$("closePatientArchive").onclick=closePatientArchive;
$("archiveMediaTab").onclick=()=>setArchiveMode("media");$("archivePlansTab").onclick=()=>setArchiveMode("plans");$("clinicalPlanBack").onclick=loadClinicalPlans;
$("archiveRefresh").onclick=()=>loadPatientArchive();$("archiveOpenFolder").onclick=()=>chairAPI.openPatientFolder();
$("archiveImport").onclick=async()=>{try{await chairAPI.importArchive(archiveCategory);await loadPatientArchive();note({message:"تم نسخ الملف إلى أرشيف المريض",type:"success"})}catch(error){note({message:error.message||"تعذر الاستيراد",type:"error"})}};
$("archiveDisplay").onclick=async()=>{if(!archiveSelected)return;try{await chairAPI.showArchive(archiveSelected.path);note({message:"تم إرسال الصورة إلى شاشة الكرسي",type:"success"})}catch(error){note({message:error.message||"اختر صورة للعرض",type:"error"})}};
$("archiveReveal").onclick=()=>archiveSelected&&chairAPI.revealArchive(archiveSelected.path);
$("archiveDelete").onclick=async()=>{if(!archiveSelected||!confirm(`حذف ${archiveSelected.name} نهائياً من أرشيف المريض؟`))return;try{await chairAPI.deleteArchive(archiveSelected.path);archiveSelected=null;await loadPatientArchive();note({message:"تم حذف الملف",type:"success"})}catch(error){note({message:error.message||"تعذر الحذف",type:"error"})}};
$("archiveCompare").onclick=async()=>{if(!archiveSelected||archiveSelected.kind!=="image")return note({message:"اختر صورة للمقارنة",type:"warning"});if(!archiveCompare.some(item=>item.path===archiveSelected.path)){if(archiveCompare.length>=2)archiveCompare.shift();archiveCompare.push(archiveSelected)}await renderArchiveCompare()};
$("archiveClearCompare").onclick=()=>{archiveCompare=[];renderArchiveCompare()};
$("addTreatment").onclick=()=>openTreatmentEditor();document.querySelector(".close-treatment").onclick=closeTreatmentEditor;

$("chooseTreatmentFile").onclick=async()=>{const path=await chairAPI.chooseTreatmentGif();if(path)$("treatmentFile").value=path};
$("saveTreatment").onclick=async()=>{
  try{
    await chairAPI.saveTreatment({id:$("treatmentId").value||Date.now(),name:$("treatmentName").value,filePath:$("treatmentFile").value});
    closeTreatmentEditor();note({message:"تم حفظ المعالجة",type:"success"});
  }catch(e){note({message:e.message||"تعذر حفظ المعالجة",type:"error"})}
};


$("refreshDiagnostics").onclick=refreshDiagnostics;
$("testConnection").onclick=async()=>{const r=await chairAPI.testDisplayConnection();note({message:r.ok?`تم إرسال اختبار إلى ${r.clients} شاشة`:"لا توجد شاشة متصلة",type:r.ok?"success":"warning"});setTimeout(refreshDiagnostics,500)};
$("resendDisplayState").onclick=async()=>{await chairAPI.resendDisplayState();note({message:"تمت إعادة إرسال الحالة الحالية",type:"success"});setTimeout(refreshDiagnostics,400)};
$("restartDiscovery").onclick=async()=>{await chairAPI.restartDiscovery();setTimeout(refreshDiagnostics,300)};
$("copyDiagnostics").onclick=async()=>{await chairAPI.copyDiagnostics();note({message:"تم نسخ تقرير التشخيص",type:"success"})};
$("clearDiagnostics").onclick=async()=>{await chairAPI.clearDiagnostics();refreshDiagnostics()};

$("folderBtn").onclick=()=>chairAPI.chooseSensorFolder();$("reindex").onclick=()=>chairAPI.reindex();
$("archiveRootBtn").onclick=()=>chairAPI.chooseArchiveRoot();
$("latest").onclick=()=>chairAPI.showLatest();$("prev").onclick=()=>chairAPI.showPrevious();$("next").onclick=()=>chairAPI.showNext();$("hide").onclick=()=>chairAPI.hide();
$("temp").onclick=()=>chairAPI.chooseTemporaryImage();$("gif").onclick=()=>chairAPI.chooseGif();$("video").onclick=()=>chairAPI.chooseVideo();$("pdf").onclick=()=>chairAPI.choosePdf();
$("zoomIn").onclick=()=>chairAPI.transform({zoom:.15});$("zoomOut").onclick=()=>chairAPI.transform({zoom:-.15});
$("brightnessUp").onclick=()=>chairAPI.transform({brightness:.10});$("brightnessDown").onclick=()=>chairAPI.transform({brightness:-.10});
$("contrastUp").onclick=()=>chairAPI.transform({contrast:.10});$("contrastDown").onclick=()=>chairAPI.transform({contrast:-.10});
$("resetEnhancement").onclick=()=>chairAPI.transform({resetEnhancement:true});
$("left").onclick=()=>chairAPI.transform({dx:-70,dy:0});$("right").onclick=()=>chairAPI.transform({dx:70,dy:0});$("up").onclick=()=>chairAPI.transform({dx:0,dy:-70});$("down").onclick=()=>chairAPI.transform({dx:0,dy:70});$("reset").onclick=()=>chairAPI.resetView();
$("black").onclick=()=>chairAPI.showBlack();$("home").onclick=()=>chairAPI.showHome();$("end").onclick=()=>chairAPI.endSession();$("game").onclick=()=>chairAPI.startGame();
$("rotateImage").onclick=()=>chairAPI.rotateImage();
$("showPatient").onclick=()=>chairAPI.showPatient({
  displayName:$("patient").value,
  doctorName:$("doctor").value,
  gender:document.querySelector('input[name="patientGender"]:checked')?.value||"male"
});

document.querySelectorAll("[data-controller-theme]").forEach(button=>button.onclick=async()=>{
  const theme=button.dataset.controllerTheme;applyControllerTheme(theme);
  try{await chairAPI.saveSettings({controllerTheme:theme})}catch(error){note({message:error.message||"تعذر تغيير مظهر الكونترولر",type:"error"})}
});
document.querySelectorAll("[data-display-theme]").forEach(button=>button.onclick=async()=>{
  const theme=button.dataset.displayTheme;applyDisplayThemeChoice(theme);
  try{await chairAPI.setDisplayTheme(theme)}catch(error){note({message:error.message||"تعذر تغيير مظهر الشاشة",type:"error"})}
});
document.querySelectorAll("[data-display-aspect]").forEach(button=>button.onclick=async()=>{
  const profile=button.dataset.displayAspect,factor=profile==="corrected"?.703125:profile==="standard"?1:Number($("displayAspectFactor").value||1);
  try{await chairAPI.setDisplayAspect({profile,factor});note({message:profile==="corrected"?"تم تفعيل تصحيح شاشة 5:4":"تم تحديث أبعاد العرض",type:"success"})}catch(error){note({message:error.message||"تعذر تحديث أبعاد العرض",type:"error"})}
});
$("displayAspectFactor").oninput=event=>{$("displayAspectValue").textContent=Number(event.target.value).toFixed(3)};
$("displayAspectFactor").onchange=event=>chairAPI.setDisplayAspect({profile:"custom",factor:Number(event.target.value)}).catch(error=>note({message:error.message||"تعذر حفظ العامل",type:"error"}));
$("controllerThemeToggle").onclick=async()=>{
  const next=$("controllerTheme").value==="dark"?"light":"dark";applyControllerTheme(next);
  try{await chairAPI.saveSettings({controllerTheme:next})}catch(error){note({message:error.message||"تعذر تغيير مظهر الكونترولر",type:"error"})}
};
$("resetShortcuts").onclick=()=>{
  shortcutDraft={...defaultShortcuts};shortcutDirty=new Set(Object.keys(defaultShortcuts));syncShortcuts(shortcutDraft);
  document.querySelectorAll(".shortcut-input").forEach(input=>input.value=prettyShortcut(shortcutDraft[input.dataset.shortcutKey]));
  note({message:"تمت استعادة الاختصارات الافتراضية — اضغط حفظ لتثبيتها",type:"info"});
};

$("save").onclick=async()=>{
  const duplicate=duplicateShortcut(shortcutDraft);
  if(duplicate){note({message:`يوجد اختصار مكرر بين ${duplicate}`,type:"error"});return;}
  try{
    await chairAPI.saveSettings({
      doctorName:$("doctor").value,
      displayTheme:$("displayTheme").value,
      controllerTheme:$("controllerTheme").value,
      shortcuts:{...shortcutDraft},
      launchAtLogin:$("launch").checked,
      startMinimized:$("minimized").checked,
      chainName:$("chainName").value,
      displayTitle:$("displayTitle").value,
      clinicName:$("clinicName").value,
      clinicDisplayName:$("clinicDisplayName").value,
      homeEyebrow:$("homeEyebrow").value,
      specialty:$("specialty").value,
      welcomeText:$("welcomeText").value,
      comfortText:$("comfortText").value,
      qrEventTitle:$("qrEventTitle").value,
      qrEventDescription:$("qrEventDescription").value,
      qrReminderMessage:$("qrReminderMessage").value,
      qrReminderHours:Math.max(1,Math.min(168,Number($("qrReminderHours").value)||24))
      ,clinicalPhrases:$("clinicalPhrases").value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)
    });
    shortcutDirty.clear();note({message:"تم حفظ الإعدادات والاختصارات وتحديث الشاشة",type:"success"});
  }catch(error){note({message:error.message||"تعذر حفظ الإعدادات",type:"error"})}
};

chairAPI.onState(render);chairAPI.onNotice(note);chairAPI.onOpenTreatments?.(()=>$("treatmentsSection").scrollIntoView({behavior:"smooth",block:"start"}));chairAPI.getState().then(render);

$("showQr").onclick=async()=>{
  try{
    await chairAPI.showAppointmentQr({
      patientName:$("qrPatient").value,
      date:$("qrDate").value,
      time:$("qrTime").value,
      type:$("qrType").value,
      clinicName:$("qrClinic").value
    });
    note({message:"تم عرض QR الموعد",type:"success"});
  }catch(error){note({message:error.message||"تعذر إنشاء QR",type:"error"})}
};
