import fixtures from "../fixtures/protocol.json" with { type: "json" };
import { AppError } from "../../src/errors.ts";
import { appleKdf } from "../../src/crypto/apple-kdf.ts";
import { srpProof } from "../../src/crypto/srp.ts";
import { buffer, hex, unhex, utf8 } from "../../src/crypto/bytes.ts";
import { SpakeProver, spakeScalars, derSignatureToRaw, rawSignatureToDER } from "../../src/crypto/spake2.ts";
import { decodeDocument, encodeDocument } from "../../src/reminders/crdt.ts";

function same(actual: string, expected: string) {
  if (actual !== expected) throw new AppError("PROTOCOL_CHANGED", "A synthetic protocol check did not match the pinned reference.");
}
export async function cryptoChecks(deadline = performance.now() + 20_000) {
  const measurements: Record<string, number> = {};
  function budget() { if (performance.now() > deadline) throw new AppError("UNSUPPORTED_FEATURE", "Synthetic cryptography exceeded this request's wall-clock budget."); }
  let start = performance.now();
  for (const protocol of ["s2k", "s2k_fo"] as const) {
    budget(); const f = fixtures.srp.find((v) => v.protocol === protocol)!;
    const derived = await appleKdf(f.password, unhex(f.salt), f.iterations, protocol); same(hex(derived), f.derived);
    const proof = await srpProof(f.account, unhex(f.ephemeral), derived, unhex(f.salt), unhex(f.B));
    same(hex(proof.A), f.A); same(hex(proof.M1), f.M1); same(hex(proof.M2), f.M2);
  }
  measurements.srpWallMs = Math.round(performance.now() - start);
  start = performance.now(); budget();
  const f = fixtures.bridge; const scalars = await spakeScalars(f.code, unhex(f.salt));
  same(scalars.w0.toString(16), f.w0); same(scalars.w1.toString(16), f.w1);
  const prover = new SpakeProver(BigInt(f.x), scalars.w0, scalars.w1); same(hex(prover.message()), f.clientMessage);
  const exchange = await prover.finish(unhex(f.serverMessage)); same(hex(exchange.transcript), f.transcript); same(hex(exchange.confirmation), f.confirmation);
  await exchange.verify(unhex(f.serverConfirmation)); same(await exchange.decrypt(f.ciphertext), f.plaintext);
  measurements.spakeScryptWallMs = Math.round(performance.now() - start);
  budget(); start = performance.now();
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const message = buffer(utf8("synthetic-signature-probe"));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, message));
  const roundTrip = derSignatureToRaw(rawSignatureToDER(raw));
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.publicKey, buffer(roundTrip), message)) throw new AppError("PROTOCOL_CHANGED", "The P-256 signature check failed.");
  for (const d of fixtures.documents) {
    for (const form of [d.zlib, d.gzip, d.raw, d.version, d.string]) same(decodeDocument(form).text, d.text);
    same(decodeDocument(encodeDocument(d.text)).text, d.text);
  }
  measurements.signatureCodecWallMs = Math.round(performance.now() - start); budget();
  return { srp: "passed", spake2: "passed", scrypt: "passed", signature: "passed", documents: "passed", measurements, evidence: "synthetic-reference-only" };
}
