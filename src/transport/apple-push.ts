// Binary application messages inside a WebSocket, not raw TLS/WebSocket frames.
import { bytesField, fields, getBytes, uint } from "../crypto/protobuf.ts";
import { concat, utf8 } from "../crypto/bytes.ts";
import { requireValue } from "../errors.ts";
export function validatedPushURL(value: string) {
  const url = new URL(value);
  requireValue(
    url.protocol === "wss:" &&
      ["websocket.push.apple.com", "websocket.sandbox.push.apple.com"].includes(
        url.hostname,
      ) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash,
    "Unsupported Apple push endpoint.",
  );
  return url;
}
export function decodePushFrame(bytes: Uint8Array) {
  requireValue(
    bytes.length >= 1 && bytes.length <= 65_536,
    "Invalid Apple push frame size.",
  );
  const outer = fields(bytes);
  requireValue(
    outer.length > 0 &&
      outer.every((f) => [1, 2, 3, 7].includes(f.number) && f.wire === 2),
    "Unknown Apple push message.",
  );
  return outer.map((message) => ({
    type: message.number,
    fields: fields(message.value as Uint8Array),
  }));
}
export function encodeSyntheticPushFrame(
  topicHash: Uint8Array,
  payload: Uint8Array,
  messageId: number,
) {
  requireValue(
    topicHash.length === 20 &&
      payload.length <= 60_000 &&
      Number.isSafeInteger(messageId) &&
      messageId >= 0,
    "Invalid synthetic push fixture.",
  );
  return bytesField(
    2,
    concat(
      bytesField(1, topicHash),
      uint(2, messageId),
      bytesField(4, payload),
    ),
  );
}
export function encodeConnectionMessage(
  publicKey: Uint8Array,
  nonce: Uint8Array,
  signatureDER: Uint8Array,
) {
  requireValue(
    publicKey.length === 65 &&
      nonce.length <= 1024 &&
      nonce.length > 0 &&
      signatureDER.length <= 80,
    "Invalid bridge bootstrap fixture.",
  );
  return bytesField(
    1,
    concat(
      bytesField(1, publicKey),
      bytesField(2, nonce),
      bytesField(3, concat(Uint8Array.of(1, 3), signatureDER)),
      bytesField(5, uint(1, 86400)),
    ),
  );
}
export const encodeTopicFilter = (topics: string[]) => {
  requireValue(
    topics.length <= 8 && topics.every((t) => t.length > 0 && t.length <= 512),
    "Invalid push topic filter.",
  );
  return bytesField(3, concat(...topics.map((t) => bytesField(1, utf8(t)))));
};
export const encodePushAcknowledgement = (
  topic: Uint8Array,
  messageId: number,
) => bytesField(2, concat(bytesField(1, topic), uint(2, messageId)));
