"use strict";
const fs = require("fs");
const path = require("path");

const DEFAULT_SHORTCUTS = Object.freeze({
  latest: "CommandOrControl+`",
  home: "CommandOrControl+H",
  black: "CommandOrControl+B",
  tempImage: "CommandOrControl+I",
  treatments: "CommandOrControl+G",
  video: "CommandOrControl+V",
  pdf: "CommandOrControl+P",
  game: "CommandOrControl+L",
  hide: "CommandOrControl+Escape",
  moveLeft: "CommandOrControl+Left",
  moveRight: "CommandOrControl+Right",
  moveUp: "CommandOrControl+Up",
  moveDown: "CommandOrControl+Down",
  zoomIn: "CommandOrControl+=",
  zoomOut: "CommandOrControl+-",
  resetView: "CommandOrControl+0",
  rotate: "CommandOrControl+Shift+8",
  previous: "CommandOrControl+PageUp",
  next: "CommandOrControl+PageDown"
});
const DEFAULT_CLINICAL_PHRASES = Object.freeze([
  "نخر بدئي","نكس نخر تحت الترميم","ألم عفوي","ألم محرض بالساخن","ناسور موجود","ألم ليلي",
  "ألم مستمر بعد زوال المحرض","تموت لبّي","آفة حول ذروية","توسع الرباط حول السني","ألم بالجس الذروي",
  "ألم محرض بالبارد","حشو أقنية قصير","تجاوز للذروة","قناة غير معالجة","أداة مكسورة","قناة مفقودة",
  "انثقاب","حشوة سيئة الحواف","كسر جذري مشتبه","سن منطمر","تاج سيئ الحواف","كسر خزف"
]);

class SettingsStore {
  constructor(app) {
    this.file = path.join(app.getPath("userData"), "settings.json");
    this.defaults = {
      sensorFolder: "C:\\Users\\Public\\Documents\\Images SOPRO-Imaging",
      patientArchiveRoot: "",
      clinicName: "عيادة د. طاهر",
      chainName: "DR TAHER DENTAL CHAIN",
      displayTitle: "Clinic Display",
      clinicDisplayName: "DR TAHER CLINIC",
      homeEyebrow: "DENTAL CHAIN",
      specialty: "DDS, PhD • Endodontics",
      welcomeText: "WELCOME",
      comfortText: "نتمنى لك جلسة مريحة",
      qrEventTitle: "موعدك في {clinic}",
      qrEventDescription: "شكراً لثقتكم.",
      qrReminderMessage: "موعدك غداً في {clinic}",
      qrReminderHours: 24,
      doctorName: "د. طاهر",
      launchAtLogin: false,
      startMinimized: false,
      wsPort: 8765,
      discoveryPort: 8766,
      mediaMaxWidth: 1920,
      mediaMaxHeight: 1200,
      displayTheme: "dark",
      controllerTheme: "dark",
      selectedAssistantId: "",
      displayAspectProfile: "standard",
      displayAspectFactor: 1,
      shortcuts: {...DEFAULT_SHORTCUTS},
      lastDisplayUrl: "",
      treatments: [],
      treatmentColumns: 3
      ,clinicalPhrases:[...DEFAULT_CLINICAL_PHRASES]
    };
    this.data = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return {...this.defaults};
      const loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        ...this.defaults,
        ...loaded,
        mediaMaxWidth:Number(loaded.mediaMaxWidth||0)<=1280?1920:Number(loaded.mediaMaxWidth),
        mediaMaxHeight:Number(loaded.mediaMaxHeight||0)<=1024?1200:Number(loaded.mediaMaxHeight),
        shortcuts: {...DEFAULT_SHORTCUTS, ...(loaded.shortcuts || {})},
        clinicalPhrases:Array.isArray(loaded.clinicalPhrases)?loaded.clinicalPhrases.filter(Boolean):[...DEFAULT_CLINICAL_PHRASES]
      };
    } catch {
      return {...this.defaults};
    }
  }
  all() { return {...this.data}; }
  get(key) { return this.data[key]; }
  patch(values) {
    const next = {...(values || {})};
    if (next.shortcuts) next.shortcuts = {...DEFAULT_SHORTCUTS, ...this.data.shortcuts, ...next.shortcuts};
    this.data = {...this.data, ...next};
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }
}
module.exports = {SettingsStore, DEFAULT_SHORTCUTS, DEFAULT_CLINICAL_PHRASES};
