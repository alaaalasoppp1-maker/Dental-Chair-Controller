const {Menu, nativeImage, Tray} = require("electron");

function createTray({onOpen, onLatest, onHide, onWelcome, onQuit}) {
  const icon = nativeImage.createEmpty();
  const tray = new Tray(icon);
  tray.setToolTip("Dental Chain Chair Controller");
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: "فتح لوحة التحكم", click: onOpen},
    {type: "separator"},
    {label: "عرض أحدث صورة", click: onLatest},
    {label: "إغلاق الصورة", click: onHide},
    {label: "شاشة الترحيب", click: onWelcome},
    {type: "separator"},
    {label: "خروج", click: onQuit}
  ]));
  tray.on("double-click", onOpen);
  return tray;
}

module.exports = {createTray};
