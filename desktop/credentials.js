// Saved-login store. The password is encrypted with Electron safeStorage —
// key held by the macOS Keychain / Windows DPAPI — and kept in a userData
// file, so it never leaves the machine and only this OS user can decrypt it.

import fs from "node:fs";
import path from "node:path";

import { app, safeStorage } from "electron";

const credsFile = () => path.join(app.getPath("userData"), "credentials.json");

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(credsFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeRaw(data) {
  fs.writeFileSync(credsFile(), JSON.stringify(data), { mode: 0o600 });
}

export function readCreds() {
  const raw = readRaw();
  if (!raw?.email || !raw?.cipher) return null;
  try {
    return {
      email: raw.email,
      password: safeStorage.decryptString(Buffer.from(raw.cipher, "base64")),
    };
  } catch {
    return null;
  }
}

export function writeCreds({ email, password }) {
  writeRaw({
    email,
    cipher: safeStorage.encryptString(password).toString("base64"),
  });
}

export function clearCreds() {
  try {
    fs.unlinkSync(credsFile());
  } catch {
    // nothing saved
  }
}

export function getNeverAsk() {
  return Boolean(readRaw()?.neverAsk);
}

export function setNeverAsk() {
  writeRaw({ ...(readRaw() ?? {}), neverAsk: true });
}
