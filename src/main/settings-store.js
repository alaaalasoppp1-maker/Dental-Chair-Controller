const fs = require("fs");
const path = require("path");

class SettingsStore {
  constructor(app) {
    this.file = path.join(app.getPath("userData"), "chair-controller-settings.json");
    this.defaults = {
      sensorFolder: "C:\\Users\\Public\\Documents\\Images SOPRO-Imaging",
      port: 8765,
      startMinimized: false,
      launchAtLogin: false,
      clinicName: "عيادة د. طاهر",
      chainName: "Dental Chain | Dr. Taher",
      doctorName: "د. طاهر"
    };
    this.data = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return {...this.defaults};
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {...this.defaults, ...parsed};
    } catch {
      return {...this.defaults};
    }
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return {...this.data};
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  patch(values) {
    this.data = {...this.data, ...values};
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }
}

module.exports = {SettingsStore};
