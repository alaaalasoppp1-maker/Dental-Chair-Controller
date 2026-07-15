const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp"]);

class ImageLibrary {
  constructor({onChanged, onNotice}) {
    this.folder = "";
    this.items = [];
    this.currentIndex = -1;
    this.watcher = null;
    this.onChanged = onChanged || (() => {});
    this.onNotice = onNotice || (() => {});
  }

  isSupported(file) {
    return SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase());
  }

  scan(folder) {
    this.folder = folder;
    const items = [];
    if (!folder || !fs.existsSync(folder)) {
      this.items = [];
      this.currentIndex = -1;
      this.onChanged(this.status());
      return;
    }

    const stack = [folder];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, {withFileTypes: true});
      } catch {
        continue;
      }

      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && this.isSupported(full)) {
          try {
            const stat = fs.statSync(full);
            if (stat.size > 0) {
              items.push({
                path: full,
                name: entry.name,
                mtimeMs: stat.mtimeMs,
                size: stat.size
              });
            }
          } catch {}
        }
      }
    }

    items.sort((a, b) => a.mtimeMs - b.mtimeMs);
    this.items = items;
    this.currentIndex = items.length ? items.length - 1 : -1;
    this.onChanged(this.status());
    this.onNotice(`تمت فهرسة ${items.length} صورة`, "success");
  }

  async startWatching(folder) {
    await this.stopWatching();
    this.scan(folder);
    if (!folder || !fs.existsSync(folder)) return;

    this.watcher = chokidar.watch(folder, {
      ignoreInitial: true,
      persistent: true,
      depth: 20,
      awaitWriteFinish: {
        stabilityThreshold: 1200,
        pollInterval: 200
      }
    });

    this.watcher.on("add", (file) => this.addFile(file));
    this.watcher.on("change", (file) => this.updateFile(file));
    this.watcher.on("unlink", (file) => this.removeFile(file));
    this.watcher.on("error", (error) => {
      this.onNotice(`خطأ في مراقبة مجلد الصور: ${error.message}`, "error");
    });
  }

  async stopWatching() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  addFile(file) {
    if (!this.isSupported(file)) return;
    try {
      const stat = fs.statSync(file);
      if (!stat.size) return;
      const existing = this.items.findIndex((item) => item.path === file);
      const item = {path: file, name: path.basename(file), mtimeMs: stat.mtimeMs, size: stat.size};
      if (existing >= 0) this.items[existing] = item;
      else this.items.push(item);
      this.items.sort((a, b) => a.mtimeMs - b.mtimeMs);
      this.currentIndex = this.items.findIndex((entry) => entry.path === file);
      this.onChanged(this.status());
      this.onNotice(`تم اكتشاف صورة جديدة: ${path.basename(file)}`, "success");
    } catch {}
  }

  updateFile(file) {
    this.addFile(file);
  }

  removeFile(file) {
    const oldCurrentPath = this.current()?.path;
    this.items = this.items.filter((item) => item.path !== file);
    if (!this.items.length) this.currentIndex = -1;
    else if (oldCurrentPath) {
      const restored = this.items.findIndex((item) => item.path === oldCurrentPath);
      this.currentIndex = restored >= 0 ? restored : this.items.length - 1;
    }
    this.onChanged(this.status());
  }

  latest() {
    if (!this.items.length) return null;
    this.currentIndex = this.items.length - 1;
    this.onChanged(this.status());
    return this.current();
  }

  previous() {
    if (!this.items.length) return null;
    this.currentIndex = Math.max(0, this.currentIndex - 1);
    this.onChanged(this.status());
    return this.current();
  }

  next() {
    if (!this.items.length) return null;
    this.currentIndex = Math.min(this.items.length - 1, this.currentIndex + 1);
    this.onChanged(this.status());
    return this.current();
  }

  current() {
    if (this.currentIndex < 0 || this.currentIndex >= this.items.length) return null;
    return this.items[this.currentIndex];
  }

  status() {
    const current = this.current();
    return {
      folder: this.folder,
      count: this.items.length,
      currentIndex: this.currentIndex,
      currentName: current?.name || "",
      currentPath: current?.path || "",
      currentPosition: current ? this.currentIndex + 1 : 0
    };
  }

  toDataUrl(item) {
    if (!item) return null;
    const ext = path.extname(item.path).toLowerCase().replace(".", "");
    const mime = ext === "jpg" ? "jpeg" : ext;
    const data = fs.readFileSync(item.path).toString("base64");
    return `data:image/${mime};base64,${data}`;
  }
}

module.exports = {ImageLibrary};
