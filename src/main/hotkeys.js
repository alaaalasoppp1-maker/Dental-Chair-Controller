class HotkeyManager {
  constructor({globalShortcut, onLatest, onPrevious, onNext, onHide, onTransform, onNotice}) {
    this.globalShortcut = globalShortcut;
    this.onLatest = onLatest;
    this.onPrevious = onPrevious;
    this.onNext = onNext;
    this.onHide = onHide;
    this.onTransform = onTransform;
    this.onNotice = onNotice || (() => {});
    this.imageControlsActive = false;
  }

  registerBase() {
    this.globalShortcut.unregisterAll();

    const latestRegistered = this.globalShortcut.register("CommandOrControl+`", this.onLatest);
    if (!latestRegistered) {
      this.onNotice("تعذر تسجيل اختصار Ctrl + ` / ذ", "warning");
    }
  }

  enableImageControls() {
    if (this.imageControlsActive) return;
    this.imageControlsActive = true;

    const bindings = [
      ["Escape", this.onHide],
      ["Left", this.onPrevious],
      ["Right", this.onNext],
      ["Up", () => this.onTransform({type: "pan", dx: 0, dy: -70})],
      ["Down", () => this.onTransform({type: "pan", dx: 0, dy: 70})],
      ["Plus", () => this.onTransform({type: "zoom", delta: 0.15})],
      ["numadd", () => this.onTransform({type: "zoom", delta: 0.15})],
      ["-", () => this.onTransform({type: "zoom", delta: -0.15})],
      ["numsub", () => this.onTransform({type: "zoom", delta: -0.15})]
    ];

    for (const [accelerator, callback] of bindings) {
      try { this.globalShortcut.register(accelerator, callback); } catch {}
    }
  }

  disableImageControls() {
    for (const accelerator of ["Escape", "Left", "Right", "Up", "Down", "Plus", "numadd", "-", "numsub"]) {
      try { this.globalShortcut.unregister(accelerator); } catch {}
    }
    this.imageControlsActive = false;
  }

  unregisterAll() {
    this.globalShortcut.unregisterAll();
  }
}

module.exports = {HotkeyManager};
