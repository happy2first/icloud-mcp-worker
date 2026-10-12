import { AppError } from "../../errors.ts";
import { object } from "./http.ts";
import { validatedPushURL } from "../../transport/apple-push.ts";

export interface BootContext {
  route: string;
  trustedDevices: boolean;
  securityKeyRequired: boolean;
  bridge: { host: string; topic: string; sourceAppId?: string } | null;
  phone: { id: string | number; mode: "sms" | "voice" } | null;
}
export function parseBootOptions(text: string, json?: unknown): BootContext {
  let value = object(json);
  if (!value) {
    if (text.length > 1_048_576)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple's authentication page exceeded the size budget.",
      );
    const scripts = text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);
    for (const script of scripts) {
      const klass = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
        script[1],
      );
      if (
        !klass ||
        !(klass[1] ?? klass[2] ?? klass[3]).split(/\s+/).includes("boot_args")
      )
        continue;
      try {
        value = object(JSON.parse(script[2]));
      } catch {
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple returned malformed authentication boot data.",
        );
      }
      break;
    }
  }
  if (!value)
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple did not return supported authentication options.",
    );
  const direct = object(value.direct) ?? value;
  const twoSV = object(direct.twoSV) ?? value;
  const data = object(twoSV.bridgeInitiateData);
  const factors = Array.isArray(twoSV.authFactors) ? twoSV.authFactors : [];
  const route =
    typeof direct.authInitialRoute === "string" ? direct.authInitialRoute : "";
  const securityKeyRequired =
    /security.?key|fido|webauthn/i.test(route) ||
    !!value.fsaChallenge ||
    !!direct.fsaChallenge ||
    !!twoSV.fsaChallenge ||
    [value.keyNames, direct.keyNames, twoSV.keyNames].some(
      (keys) => Array.isArray(keys) && keys.length > 0,
    ) ||
    factors.some((f) => typeof f === "string" && /security.?key|fido/i.test(f));
  let bridge: BootContext["bridge"] = null;
  if (
    route === "auth/bridge/step" &&
    direct.hasTrustedDevices === true &&
    data
  ) {
    let host: string;
    if (
      typeof data.webSocketUrl === "string" &&
      data.webSocketUrl.length <= 512
    ) {
      let address: URL;
      try {
        address = new URL(
          data.webSocketUrl.includes("://")
            ? data.webSocketUrl
            : `wss://${data.webSocketUrl}`,
        );
      } catch {
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple returned an invalid push service.",
        );
      }
      validatedPushURL(address.href);
      host = address.hostname;
    } else if (data.apnsEnvironment === "prod")
      host = "websocket.push.apple.com";
    else if (data.apnsEnvironment === "sandbox")
      host = "websocket.sandbox.push.apple.com";
    else
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an unsupported push environment.",
      );
    const topic = data.apnsTopic;
    if (
      typeof topic !== "string" ||
      !topic ||
      topic.length > 512 ||
      /[\x00-\x1f\x7f]/.test(topic)
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an invalid push topic.",
      );
    const appId = twoSV.sourceAppId;
    if (
      appId !== undefined &&
      !(
        (typeof appId === "string" &&
          appId.length <= 128 &&
          /^[a-zA-Z0-9._-]+$/.test(appId)) ||
        (typeof appId === "number" && Number.isSafeInteger(appId))
      )
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an invalid source application.",
      );
    bridge = {
      host,
      topic,
      ...(appId === undefined ? {} : { sourceAppId: String(appId) }),
    };
  }
  const phoneData =
    object(twoSV.phoneNumberVerification) ??
    object(data?.phoneNumberVerification);
  const phoneRaw =
    object(phoneData?.trustedPhoneNumber) ?? object(value.trustedPhoneNumber);
  const phoneId = phoneRaw?.id;
  const phone =
    (typeof phoneId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(phoneId)) ||
    (typeof phoneId === "number" &&
      Number.isSafeInteger(phoneId) &&
      phoneId >= 0)
      ? {
          id: phoneId,
          mode:
            phoneRaw?.pushMode === "voice"
              ? ("voice" as const)
              : ("sms" as const),
        }
      : null;
  return {
    route,
    trustedDevices: direct.hasTrustedDevices === true,
    securityKeyRequired,
    bridge,
    phone,
  };
}
