const path = require("path");
const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain
} = require("electron");

const {SettingsStore} = require("./settings-store");
const {ImageLibrary} = require("./image-library");
const {ChairServer} = require("./server");
const {HotkeyManager} = require("./hotkeys");
const {createTray} = require("./tray");

let mainWindow = null;
let tray = null;
let quitting = false;
let currentDisplayMode = "welcome";

const state = {
  settings: {},
  images: {},
  network: {},
  display: {mode: "welcome", imageVisible: false}
};

let settings;
let images;
let server;
let hotkeys;

function emitState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state:changed", state);
  }
}

function notice(message, type = "info") {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("notice", {message, type, at: Date.now()});
  }
}

function updateDisplay(patch) {
  state.display = {...state.display, ...patch};
  emitState();
}

function send(payload, warnIfOffline = true) {
  const delivered = server.broadcast(payload);
  if (!delivered && warnIfOffline) notice("شاشة الكرسي غير متصلة حاليًا", "warning");
  return delivered;
}

function showImage(item) {
  if (!item) {
    notice("لا توجد صور ضمن مجلد SOPRO المحدد", "error");
    return false;
  }

  try {
    const dataUrl = images.toDataUrl(item);
    send({
      type: "image",
      dataUrl,
      fileName: item.name,
      position: images.currentIndex + 1,
      total: images.items.length
    });
    updateDisplay({imageVisible: true});
    hotkeys.enableImageControls();
    notice(`تم عرض الصورة: ${item.name}`, "success");
    return true;
  } catch (error) {
    notice(`تعذر قراءة الصورة: ${error.message}`, "error");
    return false;
  }
}

function showLatest() {
  return showImage(images.latest());
}

function showPrevious() {
  return showImage(images.previous());
}

function showNext() {
  return showImage(images.next());
}

function hideImage() {
  send({type: "hide", returnTo: "previous"}, false);
  updateDisplay({imageVisible: false});
  hotkeys.disableImageControls();
}

function showMode(mode) {
  currentDisplayMode = mode;
  send({type: "mode", mode}, false);
  updateDisplay({mode, imageVisible: false});
  hotkeys.disableImageControls();
}

function showPatient({displayName, doctorName}) {
  currentDisplayMode = "patient";
  send({
    type: "patient",
    displayName: String(displayName || "").trim() || "ضيفنا الكريم",
    doctorName: String(doctorName || settings.get("doctorName")).trim()
  });
  updateDisplay({mode: "patient", imageVisible: false});
  hotkeys.disableImageControls();
}

function endSession() {
  currentDisplayMode = "welcome";
  send({type: "mode", mode: "welcome"}, false);
  updateDisplay({mode: "welcome", imageVisible: false});
  hotkeys.disableImageControls();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 800,
    minWidth: 760,
    minHeight: 680,
    show: !settings.get("startMinimized"),
    backgroundColor: "#eef7fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
      notice("البرنامج ما زال يعمل بجانب الساعة", "info");
    }
  });

  mainWindow.webContents.on("did-finish-load", emitState);
}

function registerIpc() {
  ipcMain.handle("state:get", () => state);

  ipcMain.handle("settings:choose-sensor-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "اختر مجلد صور SOPRO",
      defaultPath: settings.get("sensorFolder"),
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return state;
    settings.set("sensorFolder", result.filePaths[0]);
    state.settings = settings.all();
    await images.startWatching(result.filePaths[0]);
    return state;
  });

  ipcMain.handle("settings:save", async (_event, values) => {
    settings.patch(values || {});
    state.settings = settings.all();
    app.setLoginItemSettings({openAtLogin: Boolean(settings.get("launchAtLogin"))});
    emitState();
    return state;
  });

  ipcMain.handle("images:reindex", () => {
    images.scan(settings.get("sensorFolder"));
    return state;
  });
  ipcMain.handle("images:latest", showLatest);
  ipcMain.handle("images:previous", showPrevious);
  ipcMain.handle("images:next", showNext);

  ipcMain.handle("display:hide-image", hideImage);
  ipcMain.handle("display:reset-view", () => send({type: "resetView"}, false));
  ipcMain.handle("display:transform", (_event, payload) => send(payload, false));
  ipcMain.handle("display:mode", (_event, mode) => showMode(mode));
  ipcMain.handle("display:patient", (_event, payload) => showPatient(payload || {}));
  ipcMain.handle("display:end-session", endSession);
}

app.whenReady().then(async () => {
  settings = new SettingsStore(app);
  state.settings = settings.all();

  images = new ImageLibrary({
    onChanged: (imageState) => {
      state.images = imageState;
      emitState();
    },
    onNotice: notice
  });

  server = new ChairServer({
    port: settings.get("port"),
    onClientsChanged: (networkState) => {
      state.network = networkState;
      emitState();
    },
    onNotice: notice
  });

  hotkeys = new HotkeyManager({
    globalShortcut,
    onLatest: showLatest,
    onPrevious: showPrevious,
    onNext: showNext,
    onHide: hideImage,
    onTransform: (payload) => send(payload, false),
    onNotice: notice
  });

  registerIpc();
  createWindow();

  tray = createTray({
    onOpen: () => {
      mainWindow.show();
      mainWindow.focus();
    },
    onLatest: showLatest,
    onHide: hideImage,
    onWelcome: () => showMode("welcome"),
    onQuit: () => {
      quitting = true;
      app.quit();
    }
  });

  try {
    await server.start();
  } catch (error) {
    notice(`تعذر تشغيل خادم الشاشة: ${error.message}`, "error");
  }

  await images.startWatching(settings.get("sensorFolder"));
  hotkeys.registerBase();
  app.setLoginItemSettings({openAtLogin: Boolean(settings.get("launchAtLogin"))});
  emitState();
});

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});

app.on("before-quit", () => {
  quitting = true;
  hotkeys?.unregisterAll();
});

app.on("window-all-closed", () => {});
