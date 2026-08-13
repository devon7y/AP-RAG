// Runs sandboxed in every in-app page (context-isolated; the page cannot see
// this script). Two jobs, both scoped to the auth pages:
//   - /login: ask the main process for saved credentials and fill the form
//   - /login + /register: on submit, hand the entered credentials to the main
//     process as a save *candidate* — it only offers to save them after the
//     navigation that proves the login succeeded.
const { ipcRenderer } = require("electron");

const LOGIN_PATH = "/login";
const AUTH_PATHS = new Set(["/login", "/register"]);

function fields() {
  return {
    email: document.querySelector('input[name="email"], input[type="email"]'),
    password: document.querySelector('input[name="password"], input[type="password"]'),
  };
}

// React reads input state through the native value setter; setting .value
// directly on a controlled/uncontrolled hybrid can be swallowed on re-render.
function setNativeValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

let attemptedThisVisit = false;

async function attemptFill() {
  const { email, password } = fields();
  if (!email || !password) return; // form not rendered yet; next tick retries
  attemptedThisVisit = true; // one attempt per /login visit, even if declined
  if (email.value || password.value) return; // user already typing
  const creds = await ipcRenderer.invoke("creds:request-fill");
  if (!creds) return;
  const f = fields(); // re-query: the Touch ID prompt took time
  if (!f.email || !f.password || f.email.value || f.password.value) return;
  setNativeValue(f.email, creds.email);
  setNativeValue(f.password, creds.password);
}

// Client-side route changes don't re-run the preload, so watch the location.
setInterval(() => {
  if (location.pathname !== LOGIN_PATH) {
    attemptedThisVisit = false;
    return;
  }
  if (!attemptedThisVisit) attemptFill();
}, 500);

document.addEventListener(
  "submit",
  () => {
    if (!AUTH_PATHS.has(location.pathname)) return;
    const { email, password } = fields();
    if (email?.value && password?.value) {
      ipcRenderer.send("creds:candidate", {
        email: email.value,
        password: password.value,
      });
    }
  },
  true
);
