// Rasterise icon.svg → icon.png with its alpha intact.
//
// qlmanage (the obvious one-liner on macOS) composites onto opaque white, which
// silently fills the icon's transparent margins — the app then shows as a white
// square with the squircle inside it. Electron is already a dependency here and
// is Chromium, so it renders the SVG exactly as the pitch board does and keeps
// the alpha channel.
//
//   npx electron build/render-icon.mjs                    (run from desktop/)
//   npx electron build/render-icon.mjs in.svg out.png     (variants)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;

const [inArg, outArg] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const inFile = inArg ? path.resolve(inArg) : path.join(dir, "icon.svg");
const outFile = outArg ? path.resolve(outArg) : path.join(dir, "icon.png");

const svg = fs.readFileSync(inFile, "utf8");
const html = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  svg { display: block; width: ${SIZE}px; height: ${SIZE}px; }
</style>${svg}`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Give the compositor a frame to settle before grabbing it.
  await new Promise((r) => setTimeout(r, 400));

  let img = await win.webContents.capturePage();
  const { width } = img.getSize();
  if (width !== SIZE) {
    // Retina capture comes back at the device scale factor.
    img = img.resize({ width: SIZE, height: SIZE, quality: "best" });
  }

  fs.writeFileSync(outFile, img.toPNG());
  console.log(`wrote ${path.basename(outFile)} at ${img.getSize().width}px`);
  app.quit();
});
