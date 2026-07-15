const $ = (id) => document.getElementById(id);
let currentState = null;
let noticeTimer = null;

const modeLabels = {
  welcome: "ترحيب",
  patient: "مريض",
  services: "الخدمات",
  game: "الأطفال"
};

function render(state) {
  currentState = state;
  const clients = state.network?.clients || 0;
  $("clientCount").textContent = String(clients);
  $("imageCount").textContent = String(state.images?.count || 0);
  $("imagePosition").textContent = state.images?.count
    ? `${state.images.currentPosition} / ${state.images.count}`
    : "—";
  $("displayMode").textContent = modeLabels[state.display?.mode] || state.display?.mode || "ترحيب";
  $("networkUrl").textContent = state.network?.url || "ws://—:8765";
  $("sensorFolder").textContent = state.settings?.sensorFolder || "غير محدد";
  $("currentImage").textContent = state.images?.currentName || "—";
  $("doctorName").value = state.settings?.doctorName || "";
  $("launchAtLogin").checked = Boolean(state.settings?.launchAtLogin);
  $("startMinimized").checked = Boolean(state.settings?.startMinimized);

  const badge = $("screenBadge");
  badge.classList.toggle("online", clients > 0);
  badge.classList.toggle("offline", clients === 0);
  badge.querySelector("b").textContent = clients > 0 ? `الشاشة متصلة (${clients})` : "بانتظار الشاشة";
}

function showNotice({message, type = "info"}) {
  const box = $("notice");
  box.textContent = message;
  box.className = `notice show ${type}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => box.className = "notice", 3500);
}

$("chooseFolder").onclick = () => chairAPI.chooseSensorFolder();
$("reindex").onclick = () => chairAPI.reindex();
$("latest").onclick = () => chairAPI.showLatest();
$("previous").onclick = () => chairAPI.showPrevious();
$("next").onclick = () => chairAPI.showNext();
$("hideImage").onclick = () => chairAPI.hideImage();
$("zoomIn").onclick = () => chairAPI.transform({type: "zoom", delta: 0.15});
$("zoomOut").onclick = () => chairAPI.transform({type: "zoom", delta: -0.15});
$("panLeft").onclick = () => chairAPI.transform({type: "pan", dx: -70, dy: 0});
$("panRight").onclick = () => chairAPI.transform({type: "pan", dx: 70, dy: 0});
$("panUp").onclick = () => chairAPI.transform({type: "pan", dx: 0, dy: -70});
$("panDown").onclick = () => chairAPI.transform({type: "pan", dx: 0, dy: 70});
$("resetView").onclick = () => chairAPI.resetView();

$("showPatient").onclick = () => chairAPI.showPatient({
  displayName: $("patientName").value,
  doctorName: $("doctorName").value
});

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.onclick = () => chairAPI.showMode(button.dataset.mode);
});

$("endSession").onclick = () => chairAPI.endSession();

$("saveSettings").onclick = () => chairAPI.saveSettings({
  doctorName: $("doctorName").value.trim(),
  launchAtLogin: $("launchAtLogin").checked,
  startMinimized: $("startMinimized").checked
}).then(() => showNotice({message: "تم حفظ الإعدادات", type: "success"}));

chairAPI.onState(render);
chairAPI.onNotice(showNotice);
chairAPI.getState().then(render);
