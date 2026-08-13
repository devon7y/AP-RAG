// AP-RAG desktop shell: a thin Chromium window around the deployed web app.
// Like aprag/, this is a client — it runs no models and holds no data — so the
// main process only manages windows, navigation policy, and failure states.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} from "electron";

import { clearCreds, getNeverAsk, readCreds, setNeverAsk, writeCreds } from "./credentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// APRAG_APP_URL lets `npm start` point at a local `next dev` instance.
const APP_URL = process.env.APRAG_APP_URL ?? "https://aprag.devon7y.com";
const ALLOWED_HOSTS = new Set(["aprag.devon7y.com", new URL(APP_URL).host]);
const ALLOWED_PERMISSIONS = new Set([
  "notifications",
  "fullscreen",
  "pointerLock",
  "clipboard-sanitized-write",
]);

let mainWindow = null;

function securePrefs() {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.join(__dirname, "preload.js"),
  };
}

function isAllowed(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && ALLOWED_HOSTS.has(u.host);
  } catch {
    return false;
  }
}

function openExternally(url) {
  try {
    if (["https:", "http:", "mailto:"].includes(new URL(url).protocol)) {
      shell.openExternal(url);
    }
  } catch {
    // not a URL; drop it
  }
}

// ---------------------------------------------------------------------------
// macOS frameless chrome. The native title bar duplicated the site's own
// header, so it's hidden and only the traffic lights remain, floating over
// the page. This CSS is injected into the site (main window, macOS only) to
// keep the top-left controls clear of the lights and the window draggable.

const MAC_SHELL_CSS = `
  /* Sidebar open: its header row is the top-left element — clear the lights */
  [data-sidebar="header"] { padding-left: 76px; }
  /* Sidebar collapsed (offcanvas): the chat header becomes leftmost */
  div[data-state="collapsed"] ~ main header.sticky.top-0 { padding-left: 76px; }
  /* Top bars move the window; their controls stay clickable */
  [data-sidebar="header"], main header.sticky.top-0 { -webkit-app-region: drag; }
  [data-sidebar="header"] :is(a, button, input, [role="button"]),
  main header.sticky.top-0 :is(a, button, input, select, [role="button"]) {
    -webkit-app-region: no-drag;
  }
  /* Fallback grab strip on pages without those bars (atlas, login) */
  html::after {
    content: "";
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 12px;
    z-index: 2147483647;
    -webkit-app-region: drag;
  }
`;

// ---------------------------------------------------------------------------
// Window state persistence

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  const fallback = { width: 1440, height: 900 };
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return fallback;
  }
  if (!Number.isFinite(state.width) || !Number.isFinite(state.height)) return fallback;
  // Drop the saved position if it no longer intersects any display
  // (e.g. the external monitor it was on is gone).
  if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
    const visible = screen.getAllDisplays().some(({ workArea }) => {
      return (
        state.x < workArea.x + workArea.width &&
        state.x + state.width > workArea.x &&
        state.y < workArea.y + workArea.height &&
        state.y + state.height > workArea.y
      );
    });
    if (!visible) {
      delete state.x;
      delete state.y;
    }
  }
  return state;
}

function saveWindowState(win) {
  try {
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // best-effort; next launch just uses defaults
  }
}

// ---------------------------------------------------------------------------
// Per-webContents policies (applies to the main window and any child windows)

function attachNavigationPolicy(contents) {
  contents.on("will-navigate", (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      openExternally(url);
    }
  });
  // Same-origin popups (e.g. a PDF opened in a new tab) become app windows;
  // everything else goes to the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: securePrefs(),
        },
      };
    }
    openExternally(url);
    return { action: "deny" };
  });
}

function attachContextMenu(contents) {
  contents.on("context-menu", (_event, params) => {
    const items = [];
    for (const suggestion of params.dictionarySuggestions.slice(0, 3)) {
      items.push({
        label: suggestion,
        click: () => contents.replaceMisspelling(suggestion),
      });
    }
    if (params.misspelledWord) {
      items.push(
        {
          label: "Add to Dictionary",
          click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: "separator" }
      );
    }
    if (params.linkURL) {
      items.push(
        { label: "Open Link in Browser", click: () => openExternally(params.linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" }
      );
    }
    if (params.isEditable) {
      items.push(
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      );
    } else if (params.selectionText.trim()) {
      items.push({ role: "copy" });
    }
    if (items.length > 0) {
      Menu.buildFromTemplate(items).popup();
    }
  });
}

// ---------------------------------------------------------------------------
// Login autofill: credentials live in the OS keystore (see credentials.js).
// The preload submits a save *candidate* on every auth-form submit; only the
// navigation away from /login (proof the login worked) triggers the offer.

let pendingCandidate = null; // { email, password, at }

function isTrustedSender(event) {
  try {
    return ALLOWED_HOSTS.has(new URL(event.senderFrame.url).host);
  } catch {
    return false;
  }
}

function registerCredentialIpc() {
  ipcMain.on("creds:candidate", (event, payload) => {
    if (!isTrustedSender(event)) return;
    if (typeof payload?.email !== "string" || typeof payload?.password !== "string") return;
    pendingCandidate = { email: payload.email, password: payload.password, at: Date.now() };
  });

  ipcMain.handle("creds:request-fill", async (event) => {
    if (!isTrustedSender(event)) return null;
    if (new URL(event.senderFrame.url).pathname !== "/login") return null;
    const creds = readCreds();
    if (!creds) return null;
    if (process.platform === "darwin" && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID("autofill your AP-RAG login");
      } catch {
        return null; // cancelled or failed — leave the form untouched
      }
    }
    return creds;
  });
}

async function maybeOfferSave(contents, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (!ALLOWED_HOSTS.has(u.host)) return;
  if (u.pathname === "/login" || u.pathname === "/register") return;
  if (!pendingCandidate) return;
  const candidate = pendingCandidate;
  pendingCandidate = null;
  if (Date.now() - candidate.at > 120_000) return;
  if (getNeverAsk() || !safeStorage.isEncryptionAvailable()) return;
  const existing = readCreds();
  if (existing?.email === candidate.email && existing?.password === candidate.password) return;

  const detail =
    process.platform === "darwin"
      ? "Stored encrypted via the macOS Keychain and autofilled (after Touch ID) the next time you sign in. Remove it any time with Help → Forget Saved Login."
      : "Stored encrypted with your OS user account and autofilled the next time you sign in. Remove it any time with Help → Forget Saved Login.";
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(contents) ?? mainWindow, {
    type: "question",
    message: existing ? "Update your saved AP-RAG login?" : "Save your AP-RAG login for autofill?",
    detail,
    buttons: ["Save", "Not Now", "Never Ask"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) writeCreds(candidate);
  else if (response === 2) setNeverAsk();
}

function attachCredentialPrompts(contents) {
  contents.on("did-navigate", (_event, url) => maybeOfferSave(contents, url));
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) maybeOfferSave(contents, url);
  });
}

function forgetSavedLogin() {
  clearCreds();
  dialog.showMessageBox({
    type: "info",
    message: "Saved login removed.",
    detail: "The app will offer to save it again after your next sign-in.",
  });
}

// ---------------------------------------------------------------------------
// Menu

function focusedContents() {
  return BrowserWindow.getFocusedWindow()?.webContents;
}

function goBack() {
  const wc = focusedContents();
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
}

function goForward() {
  const wc = focusedContents();
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: goBack },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: goForward },
        {
          label: "Home",
          accelerator: "CmdOrCtrl+Shift+H",
          click: () => focusedContents()?.loadURL(APP_URL),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Open in Browser", click: () => shell.openExternal(APP_URL) },
        { type: "separator" },
        { label: "Forget Saved Login", click: forgetSavedLogin },
      ],
    },
  ]);
}

// ---------------------------------------------------------------------------
// Main window

function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 560,
    show: false,
    ...(process.platform === "darwin"
      ? {
          // Lights centered for the site's 56px (h-14) header row.
          titleBarStyle: "hidden",
          trafficLightPosition: { x: 16, y: 20 },
        }
      : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#09090b" : "#ffffff",
    webPreferences: securePrefs(),
  });
  mainWindow = win;

  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());

  let saveTimer;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 400);
  };
  win.on("resize", queueSave);
  win.on("move", queueSave);
  win.on("close", () => saveWindowState(win));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (process.platform === "darwin") {
    win.webContents.on("did-finish-load", () => {
      if (isAllowed(win.webContents.getURL())) {
        win.webContents.insertCSS(MAC_SHELL_CSS);
      }
    });
  }

  win.webContents.on("did-fail-load", (_event, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: superseded navigation */) return;
    win.loadFile(path.join(__dirname, "error.html"), { query: { to: APP_URL } });
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "error",
      message: "The AP-RAG page crashed.",
      detail: `Reason: ${details.reason}`,
      buttons: ["Reload", "Close Window"],
      defaultId: 0,
    });
    if (choice === 0) win.webContents.reload();
    else win.close();
  });

  win.loadURL(APP_URL);
  return win;
}

// ---------------------------------------------------------------------------
// App lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (app.isReady()) {
      createWindow();
    }
  });

  app.on("web-contents-created", (_event, contents) => {
    attachNavigationPolicy(contents);
    attachContextMenu(contents);
    attachCredentialPrompts(contents);
  });

  registerCredentialIpc();

  app.whenReady().then(() => {
    if (process.platform === "win32") {
      app.setAppUserModelId("com.devon7y.aprag");
    }

    // Present as plain Chrome: the Electron and app-name UA tokens trip
    // bot heuristics (the site fronts with Vercel BotID) for no benefit.
    app.userAgentFallback = app.userAgentFallback
      .replace(/\sElectron\/\S+/i, "")
      .replace(new RegExp(`\\s${app.name}/\\S+`, "i"), "");

    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      callback(
        ALLOWED_PERMISSIONS.has(permission) && isAllowed(details.requestingUrl ?? wc?.getURL() ?? "")
      );
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      return ALLOWED_PERMISSIONS.has(permission) && isAllowed(requestingOrigin);
    });

    Menu.setApplicationMenu(buildMenu());
    createWindow();
  });

  app.on("activate", () => {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
