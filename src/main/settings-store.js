"use strict";
const fs = require("fs");
const path = require("path");

class SettingsStore {
  constructor(app) {
    this.file = path.join(app.getPath("userData"), "settings.json");
    this.defaults = {
      sensorFolder: "C:\\Users\\Public\\Documents\\Images SOPRO-Imaging",
      clinicName: "عيادة د. طاهر",
      chainName: "Dental Chain | Dr. Taher",
      doctorName: "د. طاهر",
      launchAtLogin: false,
      startMinimized: false,
      wsPort: 8765,
      discoveryPort: 8766,
      mediaMaxWidth: 1280,
      mediaMaxHeight: 1024,
      displayTheme: "dark",
      lastDisplayUrl: "",
      treatments: [],
      treatmentColumns: 3
    };
    this.data = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return {...this.defaults};
      return {...this.defaults, ...JSON.parse(fs.readFileSync(this.file, "utf8"))};
    } catch {
      return {...this.defaults};
    }
  }
  all() { return {...this.data}; }
  get(key) { return this.data[key]; }
  patch(values) {
    this.data = {...this.data, ...values};
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }
}
module.exports = {SettingsStore};
