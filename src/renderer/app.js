const $=id=>document.getElementById(id);let timer;
const labels={home:"ترحيب",patient:"مريض",image:"صورة",gif:"GIF",video:"فيديو",pdf:"PDF",black:"أسود",services:"خدمات"};
function render(s){
 $("clients").textContent=s.network?.clients||0;$("count").textContent=s.images?.count||0;
 $("position").textContent=s.images?.count?`${s.images.position}/${s.images.count}`:"—";
 $("mode").textContent=labels[s.display?.mode]||s.display?.mode||"ترحيب";
 $("url").textContent=s.network?.wsUrl||"—";$("folder").textContent=s.settings?.sensorFolder||"—";
 $("current").textContent=s.images?.currentName||"—";$("doctor").value=s.settings?.doctorName||"";
 $("launch").checked=!!s.settings?.launchAtLogin;$("minimized").checked=!!s.settings?.startMinimized;
 $("badge").textContent=(s.network?.clients||0)>0?`الشاشة متصلة (${s.network.clients})`:"بانتظار الشاشة";
}
function note(n){const b=$("notice");b.textContent=n.message;b.className=`notice show ${n.type||""}`;clearTimeout(timer);timer=setTimeout(()=>b.className="notice",3200)}
$("folderBtn").onclick=()=>chairAPI.chooseSensorFolder();$("reindex").onclick=()=>chairAPI.reindex();
$("latest").onclick=()=>chairAPI.showLatest();$("prev").onclick=()=>chairAPI.showPrevious();$("next").onclick=()=>chairAPI.showNext();$("hide").onclick=()=>chairAPI.hide();
$("temp").onclick=()=>chairAPI.chooseTemporaryImage();$("gif").onclick=()=>chairAPI.chooseGif();$("video").onclick=()=>chairAPI.chooseVideo();$("pdf").onclick=()=>chairAPI.choosePdf();
$("zoomIn").onclick=()=>chairAPI.transform({zoom:.15});$("zoomOut").onclick=()=>chairAPI.transform({zoom:-.15});
$("left").onclick=()=>chairAPI.transform({dx:-70,dy:0});$("right").onclick=()=>chairAPI.transform({dx:70,dy:0});$("up").onclick=()=>chairAPI.transform({dx:0,dy:-70});$("down").onclick=()=>chairAPI.transform({dx:0,dy:70});$("reset").onclick=()=>chairAPI.resetView();
$("black").onclick=()=>chairAPI.showBlack();$("home").onclick=()=>chairAPI.showHome();$("services").onclick=()=>chairAPI.transform({type:"services"});$("end").onclick=()=>chairAPI.showHome();
$("showPatient").onclick=()=>chairAPI.showPatient({displayName:$("patient").value,doctorName:$("doctor").value});
$("save").onclick=()=>chairAPI.saveSettings({doctorName:$("doctor").value,launchAtLogin:$("launch").checked,startMinimized:$("minimized").checked}).then(()=>note({message:"تم الحفظ",type:"success"}));
chairAPI.onState(render);chairAPI.onNotice(note);chairAPI.getState().then(render);
