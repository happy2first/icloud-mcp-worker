// Narrow port of the pinned MIT HSA2 bridge. Prover secrets stay in the browser.
import { z } from "zod";
import { AppError } from "../../errors.ts";
import { b64, buffer, equal, hex, unb64, utf8 } from "../../crypto/bytes.ts";
import { rawSignatureToDER } from "../../crypto/spake2.ts";
import { getBytes, type ProtoField } from "../../crypto/protobuf.ts";
import {
  decodePushFrame,
  encodeConnectionMessage,
  encodePushAcknowledgement,
  encodeTopicFilter,
} from "../../transport/apple-push.ts";
import {
  connectApplePush,
  type BinaryChannel,
  type PushConnector,
} from "../../transport/apple-websocket.ts";
import { AppleAuthHTTP, object } from "./http.ts";
import type { BootContext } from "./boot-context.ts";
import { requireNoAppleRejection } from "./policy.ts";

const text = (max = 8192) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const PushPayload = z.object({
  sessionUUID: text(128).optional(),
  flowid: text(128).optional(),
  nextStep: z
    .union([z.string().max(10), z.number().int().min(0).max(6)])
    .optional(),
  txnid: text(256).optional(),
  salt: text(88).optional(),
  idmsdata: text().optional(),
  akdata: z.unknown().optional(),
  data: text().optional(),
  encryptedCode: text().optional(),
  ec: z.number().int().optional(),
});
type Push = z.infer<typeof PushPayload>;
function singleBytes(fields: ProtoField[], number: number, required = true) {
  const values = getBytes(fields, number);
  if (values.length > 1 || (required && values.length !== 1))
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned an ambiguous bridge message.",
    );
  return values[0] ?? new Uint8Array();
}
function number(fields: ProtoField[], number: number, fallback = 0) {
  const values = fields.filter((field) => field.number === number);
  if (!values.length) return fallback;
  if (
    values.length !== 1 ||
    values[0].wire !== 0 ||
    typeof values[0].value !== "bigint" ||
    values[0].value > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned an invalid bridge integer.",
    );
  return Number(values[0].value);
}
export function bridgePayload(bytes: Uint8Array): Push {
  if (!bytes.length || bytes.length > 60_000)
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned an oversized bridge payload.",
    );
  const source = new TextDecoder().decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    // Some APNS payloads embed their JSON after a binary prefix. Scan balanced
    // objects with a fixed candidate budget; never evaluate HTML/JavaScript.
    let start = source.indexOf("{");
    let parsed = false;
    for (
      let attempt = 0;
      attempt < 8 && start >= 0;
      attempt++, start = source.indexOf("{", start + 1)
    ) {
      let depth = 0,
        quoted = false,
        escaped = false;
      for (let index = start; index < source.length; index++) {
        const char = source[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) {
          try {
            value = JSON.parse(source.slice(start, index + 1));
            parsed = true;
          } catch {
            /* Try another bounded candidate. */
          }
          break;
        }
      }
      if (parsed) break;
    }
  }
  const parsed = PushPayload.safeParse(value);
  if (
    !parsed.success ||
    !(parsed.data.sessionUUID ?? parsed.data.flowid) ||
    (parsed.data.ec !== undefined && parsed.data.ec !== 0)
  )
    throw new AppError(
      "VERIFICATION_REQUIRED",
      "Apple rejected or changed the trusted-device challenge. Restart sign-in.",
      409,
    );
  if (
    parsed.data.akdata !== undefined &&
    JSON.stringify(parsed.data.akdata).length > 8192
  )
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned oversized bridge metadata.",
    );
  return parsed.data;
}

class InvalidNonce extends Error {
  readonly timestampMs: number;
  constructor(timestampMs: number) {
    super("Apple bridge nonce must be restarted.");
    this.timestampMs = timestampMs;
  }
}
export class AppleBridge {
  private channel: BinaryChannel | null = null;
  private token = "";
  private sessionUUID = "";
  private current: Push | null = null;
  private phase: "new" | "share" | "confirmation" | "validation" | "closed" =
    "new";
  private topicHash: Uint8Array | null = null;
  readonly http: AppleAuthHTTP;
  readonly context: NonNullable<BootContext["bridge"]>;
  readonly signal: AbortSignal;
  readonly connect: PushConnector;
  constructor(
    http: AppleAuthHTTP,
    context: NonNullable<BootContext["bridge"]>,
    signal: AbortSignal,
    connect: PushConnector = connectApplePush,
  ) {
    this.http = http;
    this.context = context;
    this.signal = signal;
    this.connect = connect;
  }
  async start() {
    if (this.phase !== "new")
      throw new AppError(
        "RESTART_REQUIRED",
        "Restart the verification attempt.",
        409,
      );
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", keys.publicKey),
    );
    this.topicHash = new Uint8Array(
      await crypto.subtle.digest("SHA-1", buffer(utf8(this.context.topic))),
    );
    let timestampMs = Date.now();
    try {
      for (let retry = 0; retry < 2; retry++) {
        const nonce = new Uint8Array(17);
        new DataView(nonce.buffer).setBigUint64(1, BigInt(timestampMs), false);
        nonce.set(crypto.getRandomValues(new Uint8Array(8)), 9);
        const signature = rawSignatureToDER(
          new Uint8Array(
            await crypto.subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              keys.privateKey,
              buffer(nonce),
            ),
          ),
        );
        const connection = encodeConnectionMessage(publicKey, nonce, signature);
        if (this.signal.aborted)
          throw new AppError(
            "RESTART_REQUIRED",
            "The authentication attempt was cancelled.",
            409,
          );
        this.channel = await this.connect(
          `wss://${this.context.host}/v2/${hex(connection)}`,
          this.signal,
        );
        try {
          this.token = await this.pushToken();
          break;
        } catch (error) {
          this.channel.close();
          this.channel = null;
          if (!(error instanceof InvalidNonce) || retry !== 0) throw error;
          timestampMs = error.timestampMs;
        }
      }
      if (!this.channel || !this.token)
        throw new AppError(
          "RESTART_REQUIRED",
          "Apple did not open the verification bridge.",
          409,
        );
      this.channel.send(encodeTopicFilter([this.context.topic]));
      this.sessionUUID = `${crypto.randomUUID()}-${Math.floor(Date.now() / 1000)}`;
      // Do not wait for a push before step 0: Apple requires this ordering.
      const reply = await this.http.auth(
        "/bridge/step/0",
        "POST",
        { sessionUUID: this.sessionUUID, ptkn: this.token },
        this.headers(),
      );
      this.http.expect(reply, [200, 204, 409]);
      requireNoAppleRejection(reply.body);
      const first = await this.push();
      if (first.txnid?.endsWith("_W"))
        throw new AppError(
          "UNSUPPORTED_AUTH",
          "Apple selected legacy device verification. This connection only supports the modern trusted-device bridge.",
        );
      if (String(first.nextStep) !== "2" || !first.salt)
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple did not return the expected trusted-device prover challenge.",
        );
      unb64(first.salt, 64);
      // The pinned protocol distinguishes a sessionUUID echo from Apple's
      // newer server-assigned flowid. Only this first, expected step-2 push on
      // our fresh token/topic channel can establish the latter. An explicit
      // sessionUUID must still echo step 0. As in the pinned upstream, it
      // takes precedence over secondary flowid metadata when both exist.
      if (first.sessionUUID !== undefined) {
        if (first.sessionUUID !== this.sessionUUID)
          throw new AppError(
            "PROTOCOL_CHANGED",
            "Apple did not echo this sign-in's bridge identity. Cancel and start a new sign-in.",
          );
      } else {
        if (!first.flowid)
          throw new AppError(
            "PROTOCOL_CHANGED",
            "Apple omitted the bridge transaction identity.",
          );
        this.sessionUUID = first.flowid;
      }
      this.current = first;
      this.phase = "share";
      return { method: "bridge" as const, salt: first.salt };
    } catch (error) {
      this.close();
      if (error instanceof AppError) throw error;
      throw new AppError(
        "RESTART_REQUIRED",
        "The trusted-device bridge could not be established. Restart sign-in.",
        409,
        true,
      );
    }
  }
  async share(data: string) {
    this.requirePhase("share");
    this.phase = "closed";
    const point = unb64(data, 65);
    if (point.length !== 65 || point[0] !== 4)
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid trusted-device prover share.",
      );
    try {
      await this.step(2, data);
      this.apply(await this.push());
      if (String(this.current?.nextStep) !== "4" || !this.current?.data)
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple returned an unexpected prover response.",
        );
      const combined = new TextDecoder("utf-8", { fatal: true }).decode(
        unb64(this.current.data, 512),
      );
      const parts = combined.split("_");
      if (
        parts.length !== 2 ||
        unb64(parts[0], 65).length !== 65 ||
        unb64(parts[1], 32).length !== 32
      )
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple returned malformed prover messages.",
        );
      this.phase = "confirmation";
      return { serverShare: parts[0], serverConfirmation: parts[1] };
    } catch (error) {
      this.close();
      throw error;
    }
  }
  async confirm(data: string) {
    this.requirePhase("confirmation");
    this.phase = "closed";
    if (unb64(data, 32).length !== 32)
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid trusted-device confirmation.",
      );
    try {
      await this.step(4, data);
      this.apply(await this.push());
      if (
        !["4", "6"].includes(String(this.current?.nextStep)) ||
        !this.current?.encryptedCode
      )
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple returned an unexpected final bridge response.",
        );
      this.phase = "validation";
      return { encryptedCode: this.current.encryptedCode };
    } catch (error) {
      this.close();
      throw error;
    }
  }
  async validate(code: string) {
    this.requirePhase("validation");
    this.phase = "closed";
    try {
      const reply = await this.http.auth(
        "/bridge/code/validate",
        "POST",
        { sessionUUID: this.sessionUUID, code },
        this.headers(),
      );
      this.http.expect(reply, [200, 204, 409, 412]);
      requireNoAppleRejection(reply.body);
      if (reply.status === 412)
        throw new AppError(
          "VERIFICATION_REQUIRED",
          "Apple rejected the verification code. Restart sign-in.",
          409,
        );
      const completionStep = String(this.current?.nextStep) === "6" ? 6 : 4;
      await this.step(completionStep, b64(utf8("done")));
    } finally {
      this.close();
    }
  }
  close() {
    this.phase = "closed";
    this.channel?.close();
    this.channel = null;
    this.current = null;
    this.token = "";
    this.sessionUUID = "";
    this.topicHash?.fill(0);
    this.topicHash = null;
  }
  private requirePhase(phase: typeof this.phase) {
    if (this.phase !== phase || this.signal.aborted)
      throw new AppError(
        "RESTART_REQUIRED",
        "This bridge step is stale or the socket was lost. Restart sign-in.",
        409,
      );
  }
  private headers(): Record<string, string> {
    return this.context.sourceAppId
      ? { "X-Apple-App-Id": this.context.sourceAppId }
      : {};
  }
  private async step(step: 2 | 4 | 6, data: string) {
    const metadata = this.current;
    const reply = await this.http.auth(
      `/bridge/step/${step}`,
      "POST",
      {
        sessionUUID: this.sessionUUID,
        data,
        ptkn: this.token,
        nextStep: step,
        ...(metadata?.idmsdata === undefined
          ? {}
          : { idmsdata: metadata.idmsdata }),
        ...(metadata?.akdata === undefined
          ? {}
          : {
              akdata: object(metadata.akdata)
                ? JSON.stringify(metadata.akdata)
                : metadata.akdata,
            }),
      },
      this.headers(),
    );
    this.http.expect(reply, [200, 204, 409]);
    requireNoAppleRejection(reply.body);
  }
  private apply(push: Push) {
    if ((push.sessionUUID ?? push.flowid) !== this.sessionUUID)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple changed the bridge identity during device verification. Cancel and start a new sign-in.",
      );
    this.current = push;
  }
  private async pushToken() {
    const deadline = Date.now() + 30_000;
    for (let received = 0; received < 16; received++) {
      if (Date.now() >= deadline) break;
      const messages = decodePushFrame(
        await this.channel!.receive(Math.max(1, deadline - Date.now())),
      );
      const connection = messages.find((message) => message.type === 1);
      if (!connection) continue;
      const status = number(connection.fields, 2);
      if (status === 2) {
        const timestamp = number(connection.fields, 3);
        if (timestamp > 0 && Number.isSafeInteger(timestamp * 1000))
          throw new InvalidNonce(timestamp * 1000);
      }
      if (status !== 0)
        throw new AppError(
          "RESTART_REQUIRED",
          "Apple rejected the bridge bootstrap.",
          409,
        );
      const token = new TextDecoder("utf-8", { fatal: true }).decode(
        singleBytes(connection.fields, 1),
      );
      const decoded = unb64(token, 256);
      if (!decoded.length)
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple returned an empty push token.",
        );
      return hex(decoded);
    }
    throw new AppError(
      "RESTART_REQUIRED",
      "Apple did not return a push token within the frame budget.",
      409,
    );
  }
  private async push() {
    if (!this.channel || !this.topicHash)
      throw new AppError(
        "RESTART_REQUIRED",
        "The verification socket is unavailable.",
        409,
      );
    const deadline = Date.now() + 30_000;
    for (let received = 0; received < 32; received++) {
      if (Date.now() >= deadline) break;
      for (const message of decodePushFrame(
        await this.channel.receive(Math.max(1, deadline - Date.now())),
      )) {
        if (message.type === 3 && number(message.fields, 3) !== 0)
          throw new AppError(
            "RESTART_REQUIRED",
            "Apple rejected the bridge topic subscription.",
            409,
          );
        if (message.type !== 2) continue;
        const topic = singleBytes(message.fields, 1);
        const id = number(message.fields, 2);
        this.channel.send(encodePushAcknowledgement(topic, id));
        if (
          !equal(topic, this.topicHash) &&
          new TextDecoder().decode(topic) !== this.context.topic
        )
          continue;
        return bridgePayload(singleBytes(message.fields, 4));
      }
    }
    throw new AppError(
      "RESTART_REQUIRED",
      "Apple did not return the expected verification push within the frame budget.",
      409,
    );
  }
}
