import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import fixtures from "./fixtures/protocol.json" with { type: "json" };
import { appleKdf } from "../src/crypto/apple-kdf.ts";
import { SRP_N, srpProof, srpPublic } from "../src/crypto/srp.ts";
import {
  b64,
  hex,
  integerBytes,
  unb64,
  unhex,
  utf8,
} from "../src/crypto/bytes.ts";
import {
  SpakeProver,
  spakeScalars,
  derSignatureToRaw,
  rawSignatureToDER,
} from "../src/crypto/spake2.ts";
import { decodeDocument, encodeDocument } from "../src/reminders/crdt.ts";
import {
  decodePushFrame,
  encodeSyntheticPushFrame,
  encodeConnectionMessage,
  encodeTopicFilter,
  encodePushAcknowledgement,
} from "../src/transport/apple-push.ts";
import { fields, getBytes } from "../src/crypto/protobuf.ts";
import { cryptoChecks } from "./helpers/crypto-checks.ts";

test("both Apple KDF protocols and SRP proofs match eight pinned Python transcripts", async () => {
  for (const f of fixtures.srp) {
    const protocol = f.protocol as "s2k" | "s2k_fo";
    const derived = await appleKdf(
      f.password,
      unhex(f.salt),
      f.iterations,
      protocol,
    );
    assert.equal(hex(derived), f.derived);
    const result = await srpProof(
      f.account,
      unhex(f.ephemeral),
      derived,
      unhex(f.salt),
      unhex(f.B),
    );
    assert.equal(hex(result.A), f.A);
    assert.equal(hex(result.M1), f.M1);
    assert.equal(hex(result.M2), f.M2);
  }
  // Bad public values, zero ephemeral, unsupported KDF and attacker CPU budgets.
  const f = fixtures.srp[0];
  for (const B of [new Uint8Array(256), integerBytes(SRP_N, 256)])
    await assert.rejects(
      srpProof(
        f.account,
        unhex(f.ephemeral),
        unhex(f.derived),
        unhex(f.salt),
        B,
      ),
    );
  assert.throws(() => srpPublic(new Uint8Array(256)));
  await assert.rejects(appleKdf("synthetic", unhex(f.salt), 1_000_001, "s2k"));
  await assert.rejects(
    appleKdf("synthetic", unhex(f.salt), 1000, "invalid" as "s2k"),
  );
});

test("SPAKE2/scrypt transcript, confirmations and AES-GCM match pinned Python", async () => {
  const f = fixtures.bridge;
  const { w0, w1 } = await spakeScalars(f.code, unhex(f.salt));
  assert.equal(w0.toString(16), f.w0);
  assert.equal(w1.toString(16), f.w1);
  const prover = new SpakeProver(BigInt(f.x), w0, w1);
  assert.equal(hex(prover.message()), f.clientMessage);
  const result = await prover.finish(unhex(f.serverMessage));
  assert.equal(hex(result.transcript), f.transcript);
  assert.equal(hex(result.confirmation), f.confirmation);
  await assert.rejects(result.decrypt(f.ciphertext));
  await assert.rejects(result.verify(new Uint8Array(32)));
  await result.verify(unhex(f.serverConfirmation));
  assert.equal(await result.decrypt(f.ciphertext), f.plaintext);
  const corrupt = unb64(f.ciphertext);
  corrupt[20] ^= 1;
  await assert.rejects(result.decrypt(b64(corrupt)));
  await assert.rejects(result.decrypt(b64(Uint8Array.of(0))));
  result.destroy();
  await assert.rejects(result.verify(unhex(f.serverConfirmation)));
  await assert.rejects(result.decrypt(f.ciphertext));
  assert.throws(() => new SpakeProver(0n, w0, w1));
  await assert.rejects(prover.finish(new Uint8Array(65)));
  const invalidPoint = new Uint8Array(65);
  invalidPoint[0] = 4;
  await assert.rejects(prover.finish(invalidPoint));
  assert.deepEqual(
    derSignatureToRaw(
      rawSignatureToDER(derSignatureToRaw(unhex(fixtures.push.signatureDER))),
    ),
    derSignatureToRaw(unhex(fixtures.push.signatureDER)),
  );
});

test("document codecs match Python wire bytes and preserve emoji UTF-16 topology", () => {
  for (const f of fixtures.documents) {
    for (const input of [f.zlib, f.gzip, f.raw, f.version, f.string])
      assert.equal(decodeDocument(input).text, f.text);
    const encoded = encodeDocument(f.text);
    assert.deepEqual(inflateSync(unb64(encoded)), Buffer.from(unb64(f.raw)));
    assert.equal(decodeDocument(encoded).text, f.text);
    const doc = fields(unb64(f.raw));
    const version = fields(getBytes(doc, 2)[0]);
    const text = fields(getBytes(version, 3)[0]);
    const content = getBytes(text, 3)
      .map(fields)
      .filter((part) =>
        part.some(
          (field) =>
            field.number === 2 &&
            field.value === BigInt(f.utf16Length) &&
            f.utf16Length > 0,
        ),
      );
    assert.equal(content.length, f.utf16Length ? 1 : 0);
  }
  assert.throws(() => decodeDocument("not base64%"));
  assert.throws(() => decodeDocument(b64(Uint8Array.of(18, 255))));
  assert.throws(() => encodeDocument("x".repeat(64_001)));
});

test("binary push messages match pinned Python framing, subscription and ack", () => {
  const f = fixtures.push;
  assert.equal(
    hex(
      encodeSyntheticPushFrame(
        unhex(f.topicHash),
        unhex(f.payload),
        f.messageId,
      ),
    ),
    f.frame,
  );
  assert.equal(
    hex(
      encodeConnectionMessage(
        unhex(f.publicKey),
        unhex(f.nonce),
        unhex(f.signatureDER),
      ),
    ),
    f.connection,
  );
  assert.equal(hex(encodeTopicFilter(["synthetic.topic"])), f.filter);
  assert.equal(
    hex(encodePushAcknowledgement(unhex(f.topicHash), f.messageId)),
    f.acknowledgement,
  );
  const result = decodePushFrame(unhex(f.frame));
  assert.equal(result[0].type, 2);
  assert.equal(hex(getBytes(result[0].fields, 4)[0]), f.payload);
  assert.throws(() => decodePushFrame(Uint8Array.of(18, 255)));
  assert.throws(() => decodePushFrame(new Uint8Array(65_537)));
  assert.throws(() => fields(utf8("malformed")));
});

test("offline cryptographic reference checks pass together", async () => {
  const result = await cryptoChecks();
  assert.equal(result.srp, "passed");
  assert.equal(result.spake2, "passed");
  assert.equal(result.documents, "passed");
});
