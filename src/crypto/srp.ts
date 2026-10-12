// Apple SRP wire behavior: RFC 5054, SHA-256, NG_2048, no_username_in_x.
// Feasibility implementation only: BigInt modular exponentiation is not constant-time.
// This must receive a crypto review before a browser password flow is enabled.
import { concat, digest, integer, integerBytes, utf8 } from "./bytes.ts";
import { requireValue } from "../errors.ts";
export const SRP_N = BigInt(
  "0xAC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73",
);
const G = 2n;
function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  base = ((base % SRP_N) + SRP_N) % SRP_N;
  while (exponent) {
    if (exponent & 1n) result = (result * base) % SRP_N;
    base = (base * base) % SRP_N;
    exponent >>= 1n;
  }
  return result;
}
export function srpPublic(ephemeral: Uint8Array): Uint8Array {
  requireValue(
    ephemeral.length === 256 && integer(ephemeral) > 0n,
    "Invalid SRP ephemeral state.",
  );
  return integerBytes(modPow(G, integer(ephemeral)));
}
export async function srpProof(
  account: string,
  ephemeral: Uint8Array,
  derivedPassword: Uint8Array,
  salt: Uint8Array,
  serverPublic: Uint8Array,
) {
  requireValue(
    utf8(account).length >= 1 &&
      utf8(account).length <= 320 &&
      derivedPassword.length === 32,
    "Invalid SRP inputs.",
  );
  requireValue(
    salt.length >= 1 &&
      salt.length <= 64 &&
      serverPublic.length >= 1 &&
      serverPublic.length <= 256,
    "Invalid SRP challenge size.",
  );
  const A = integer(srpPublic(ephemeral));
  const B = integer(serverPublic);
  requireValue(B > 0n && B < SRP_N, "Invalid SRP server public value.");
  const k = integer(
    await digest(concat(integerBytes(SRP_N, 256), integerBytes(G, 256))),
  );
  const u = integer(
    await digest(concat(integerBytes(A, 256), integerBytes(B, 256))),
  );
  requireValue(u !== 0n, "Invalid SRP scrambling parameter.");
  const x = integer(
    await digest(
      concat(salt, await digest(concat(utf8(":"), derivedPassword))),
    ),
  );
  const S = modPow(B - k * modPow(G, x), integer(ephemeral) + u * x);
  requireValue(S !== 0n, "Invalid SRP shared secret.");
  const K = await digest(integerBytes(S));
  const hn = await digest(integerBytes(SRP_N));
  const hg = await digest(integerBytes(G, 256));
  const xor = hn.map((b, i) => b ^ hg[i]);
  // Only k/u/g hashing is RFC-padded. M1/M2 and K use minimal unsigned encodings.
  let first: Uint8Array | undefined;
  let second: Uint8Array | undefined;
  try {
    first = concat(
      xor,
      await digest(utf8(account)),
      salt,
      integerBytes(A),
      integerBytes(B),
      K,
    );
    const M1 = await digest(first);
    second = concat(integerBytes(A), M1, K);
    const M2 = await digest(second);
    return { A: integerBytes(A), M1, M2 };
  } finally {
    K.fill(0);
    first?.fill(0);
    second?.fill(0);
  }
}
