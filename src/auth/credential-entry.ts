import {
  beginAppleSignIn,
  type BrowserSignInUpdate,
} from "../app/apple-auth-client.ts";
import { APPLE_LOGIN_POLICY } from "./apple/policy.ts";

type Status = {
  generation: number;
  gates: { enabled: boolean; loginPolicy: string };
  message: string;
};
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const form = element<HTMLFormElement>("credentials"),
  fields = element<HTMLFieldSetElement>("fields"),
  verification = element<HTMLFormElement>("verification");
const account = element<HTMLInputElement>("account"),
  password = element<HTMLInputElement>("password"),
  code = element<HTMLInputElement>("code");
const verificationFields = element<HTMLFieldSetElement>("verification-fields");
const trust = element<HTMLInputElement>("apple-trust"),
  retention = element<HTMLInputElement>("retention");
const message = element<HTMLParagraphElement>("message"),
  cancel = element<HTMLButtonElement>("cancel"),
  back = element<HTMLAnchorElement>("continue");
let attempt: ReturnType<typeof beginAppleSignIn> | null = null,
  controller: AbortController | null = null,
  revision = 0,
  busy = false;
function announce(text: string, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
}
function clear() {
  password.value = "";
  code.value = "";
}
function stop() {
  revision++;
  controller?.abort();
  controller = null;
  attempt?.cancel();
  attempt = null;
  clear();
  busy = false;
  cancel.hidden = true;
  verification.hidden = true;
  verificationFields.disabled = true;
}
function paused(status: Status) {
  stop();
  form.hidden = true;
  fields.disabled = true;
  back.hidden = false;
  announce(status.message);
}
async function freshStatus(signal: AbortSignal) {
  const response = await fetch("/api/connection", {
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new Error(
      "Connection status could not be confirmed. Reload before trying again.",
    );
  const value = (await response.json()) as Status;
  if (
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    value.gates?.loginPolicy !== APPLE_LOGIN_POLICY ||
    typeof value.gates.enabled !== "boolean"
  )
    throw new Error("The login policy changed. Reload this page.");
  return value;
}
function update(value: BrowserSignInUpdate) {
  clear();
  if (value.state === "working") {
    verification.hidden = false;
    verificationFields.disabled = true;
    announce(value.message);
  }
  if (value.state === "code") {
    verification.hidden = false;
    verificationFields.disabled = false;
    announce(
      "Approve Apple's prompt on your trusted device and enter its code below.",
    );
    code.focus();
  }
  if (value.state === "failed") {
    stop();
    fields.disabled = false;
    form.hidden = false;
    announce(value.message, true);
  }
  if (value.state === "complete") {
    stop();
    form.hidden = true;
    back.hidden = false;
    announce(
      value.result.state === "READY"
        ? `Device verification completed. This connection expires ${new Date(value.result.expiresAt).toLocaleString()}. Return to run a controlled read.`
        : "Device verification completed. Apple still requires permission to unlock your Reminders data. Return to the connection page to check that separate approval.",
    );
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy || !form.reportValidity()) return;
  busy = true;
  fields.disabled = true;
  cancel.hidden = false;
  announce("Checking whether this login is enabled…");
  const current = ++revision,
    request = new AbortController();
  controller = request;
  const timer = setTimeout(() => request.abort(), 10_000);
  void (async () => {
    // Confirm the current policy before taking the password out of its field.
    const status = await freshStatus(request.signal);
    if (current !== revision) return;
    if (!status.gates.enabled) {
      paused(status);
      return;
    }
    let secret = password.value;
    password.value = "";
    try {
      attempt = beginAppleSignIn(
        account.value.trim(),
        secret,
        { appleTrust: trust.checked, persistentSession: retention.checked },
        status.generation,
        (value) => {
          if (current === revision) update(value);
        },
      );
    } finally {
      secret = "";
    }
  })()
    .catch((error) => {
      if (current === revision) {
        stop();
        fields.disabled = false;
        announce(
          error instanceof Error
            ? error.message
            : "Sign-in could not be started.",
          true,
        );
      }
    })
    .finally(() => {
      clearTimeout(timer);
      if (controller === request) controller = null;
    });
});
verification.addEventListener("submit", (event) => {
  event.preventDefault();
  if (verificationFields.disabled || !verification.reportValidity()) return;
  let value = code.value;
  code.value = "";
  void attempt
    ?.submitCode(value)
    .catch((error) =>
      announce(
        error instanceof Error ? error.message : "Restart device verification.",
        true,
      ),
    );
  value = "";
});
cancel.addEventListener("click", () => {
  stop();
  fields.disabled = false;
  form.hidden = false;
  announce("Sign-in cancelled. No session was retained.");
});
window.addEventListener("pagehide", stop);
const initial = new AbortController();
const initialTimer = setTimeout(() => initial.abort(), 10_000);
controller = initial;
void freshStatus(initial.signal)
  .then((status) => {
    if (initial.signal.aborted) return;
    if (!status.gates.enabled) paused(status);
    else fields.disabled = false;
  })
  .catch(() => {
    clear();
    announce(
      "Connection status could not be confirmed. Reload this page.",
      true,
    );
  })
  .finally(() => {
    clearTimeout(initialTimer);
    if (controller === initial) controller = null;
  });
