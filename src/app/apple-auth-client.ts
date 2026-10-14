import { BrowserBridgeProof, BrowserSrpProof } from "../auth/browser-proof.ts";
import {
  APPLE_AUTH_PROTOCOL,
  AUTH_LIFETIME_MS,
} from "../auth/apple/protocol.ts";
import type { AuthEvent } from "../auth/apple/flow.ts";
import { AuthResponseSequence } from "../auth/apple/events.ts";

export type BrowserSignInUpdate =
  | { state: "working"; message: string }
  | { state: "code"; method: string }
  | { state: "complete"; result: Extract<AuthEvent, { type: "complete" }> }
  | { state: "failed"; message: string; code?: string };
export function beginAppleSignIn(
  accountName: string,
  initialPassword: string,
  consent: {
    appleTrust: boolean;
    persistentSession: boolean;
    region?: "cn" | "international";
    service?: "findmy";
  },
  generation: number,
  update: (value: BrowserSignInUpdate) => void,
) {
  if (
    location.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(location.hostname)
  )
    throw new Error("Open the secure private Site to connect your account.");
  if (
    !consent.appleTrust ||
    !consent.persistentSession ||
    !initialPassword ||
    initialPassword.length > 4096
  )
    throw new Error(
      "Enter your Apple credentials and confirm Apple session trust and encrypted retention.",
    );
  let password = initialPassword;
  initialPassword = "";
  const srp = new BrowserSrpProof(accountName);
  const bridge = new BrowserBridgeProof();
  const url = new URL("/api/auth/socket", location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("generation", String(generation));
  url.searchParams.set("region", consent.region ?? "international");
  if (consent.service === "findmy") url.searchParams.set("service", "findmy");
  const socket = new WebSocket(url, APPLE_AUTH_PROTOCOL);
  const events = new AuthResponseSequence(generation);
  let binding: { transactionId: string; nonce: string } | null = null;
  let sequence = 0;
  let phase:
    | "hello"
    | "srp"
    | "device-challenge"
    | "code-bridge"
    | "bridge-response"
    | "bridge-encrypted"
    | "completion"
    | "closed" = "hello";
  let salt = "";
  let busy = false;
  let completed = false;
  const clean = () => {
    phase = "closed";
    password = "";
    salt = "";
    srp.clear();
    bridge.clear();
    clearTimeout(timer);
  };
  const live = () => phase !== "closed" && socket.readyState === WebSocket.OPEN;
  const fail = (message: string, code?: string) => {
    if (phase === "closed") return;
    clean();
    socket.close();
    update({ state: "failed", message, ...(code ? { code } : {}) });
  };
  const send = (type: string, data: Record<string, unknown>) => {
    if (!live() || !binding)
      throw new Error(
        "Sign-in expired or its connection was lost. Restart sign-in.",
      );
    socket.send(
      JSON.stringify({
        type,
        transactionId: binding.transactionId,
        nonce: binding.nonce,
        sequence: sequence++,
        ...data,
      }),
    );
  };
  const timer = setTimeout(
    () => fail("Sign-in exceeded its interactive lifetime. Restart sign-in."),
    AUTH_LIFETIME_MS,
  );
  socket.addEventListener("error", () =>
    fail(
      "The secure sign-in connection could not be opened. Refresh status and retry.",
    ),
  );
  socket.addEventListener("close", () => {
    if (!completed && phase !== "closed")
      fail("The sign-in connection ended. Refresh status and restart sign-in.");
    else clean();
  });
  socket.addEventListener("message", (event) => {
    void (async () => {
      if (phase === "closed") return;
      if (typeof event.data !== "string" || event.data.length > 16_384 || busy)
        throw new Error(
          "The sign-in response was out of order. Restart sign-in.",
        );
      const value = events.consume(JSON.parse(event.data));
      if (value.type === "failed")
        throw Object.assign(new Error(value.error.message), {
          code: value.error.code,
        });
      busy = true;
      try {
        if (value.type === "hello" && phase === "hello") {
          binding = { transactionId: value.transactionId, nonce: value.nonce };
          // Browser and Worker wall clocks need not agree. The local relative
          // timer bounds this page; the Worker enforces its own absolute lease.
          phase = "srp";
          send("start", {
            accountName,
            publicA: srp.publicA(),
            consentAppleTrust: true,
            consentPersistentSession: true,
          });
          return;
        }
        if (value.type === "srp-challenge" && phase === "srp") {
          update({
            state: "working",
            message: "Computing the sign-in proof in your browser…",
          });
          const pending = srp.prove(password, value.challenge);
          password = "";
          const proof = await pending;
          if (!live()) return;
          phase = "device-challenge";
          send("srp-proof", proof);
          return;
        }
        if (value.type === "bridge-challenge" && phase === "device-challenge") {
          salt = value.salt;
          phase = "code-bridge";
          update({ state: "code", method: "trusted-device" });
          return;
        }
        if (
          value.type === "bridge-response" &&
          phase === "bridge-response" &&
          typeof value.serverShare === "string" &&
          typeof value.serverConfirmation === "string"
        ) {
          const confirmation = await bridge.confirm(
            value.serverShare,
            value.serverConfirmation,
          );
          if (!live()) return;
          phase = "bridge-encrypted";
          send("bridge-confirmation", { data: confirmation });
          return;
        }
        if (
          value.type === "bridge-encrypted" &&
          phase === "bridge-encrypted" &&
          typeof value.encryptedCode === "string"
        ) {
          let code = await bridge.decrypt(value.encryptedCode);
          if (!live()) {
            code = "";
            return;
          }
          phase = "completion";
          send("bridge-validation", { code });
          code = "";
          return;
        }
        if (
          value.type === "complete" &&
          (phase === "completion" ||
            (consent.service === "findmy" &&
              phase === "device-challenge" &&
              value.state === "READY")) &&
          ["READY", "DEVICE_APPROVAL_PENDING"].includes(String(value.state))
        ) {
          const result: Extract<AuthEvent, { type: "complete" }> = {
            type: "complete",
            state: value.state,
            ...(value.action ? { action: value.action } : {}),
            nextAttemptAt: value.nextAttemptAt,
            expiresAt: value.expiresAt,
          };
          completed = true;
          clean();
          socket.close();
          update({ state: "complete", result });
          return;
        }
        throw new Error("Apple changed the sign-in exchange. Restart sign-in.");
      } finally {
        busy = false;
      }
    })().catch((error) =>
      fail(
        error instanceof Error
          ? error.message
          : "Sign-in could not be completed.",
        error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
          ? error.code
          : undefined,
      ),
    );
  });
  update({
    state: "working",
    message: "Opening a secure Apple sign-in exchange…",
  });
  return {
    async submitCode(code: string) {
      if (!/^\d{6}$/.test(code) || busy || !live() || phase !== "code-bridge")
        throw new Error("Enter the six-digit code for this sign-in attempt.");
      busy = true;
      try {
        update({ state: "working", message: "Verifying your device…" });
        const data = await bridge.first(code, salt);
        code = "";
        salt = "";
        if (!live()) return;
        phase = "bridge-response";
        send("bridge-share", { data });
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : "Device verification failed. Restart sign-in.",
        );
      } finally {
        busy = false;
      }
    },
    cancel() {
      if (live() && binding) {
        try {
          send("cancel", {});
        } catch {
          /* Lost socket. */
        }
      }
      clean();
      socket.close();
    },
  };
}
