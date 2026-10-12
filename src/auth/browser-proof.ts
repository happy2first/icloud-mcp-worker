// Imported only by the setup browser and synthetic differential tests.
// No password, KDF output, ephemeral scalar or shared key is sent to the Worker.
import { p256 } from "@noble/curves/nist.js";
import { appleKdf } from "../crypto/apple-kdf.ts";
import { b64, integer, unb64 } from "../crypto/bytes.ts";
import { srpProof, srpPublic } from "../crypto/srp.ts";
import { spakeScalars, SpakeProver } from "../crypto/spake2.ts";
import { AppError } from "../errors.ts";
import { ACCOUNT, parseChallenge } from "./apple/protocol.ts";

export class BrowserSrpProof {
  private ephemeral: Uint8Array | null = crypto.getRandomValues(
    new Uint8Array(256),
  );
  private used = false;
  readonly accountName: string;
  constructor(accountName: string) {
    this.accountName = accountName;
    if (!ACCOUNT.safeParse(accountName).success) {
      this.clear();
      throw new AppError(
        "VALIDATION_ERROR",
        "Enter a supported Apple account identifier.",
      );
    }
  }
  publicA() {
    if (!this.ephemeral || this.used)
      throw new AppError("AUTH_EXPIRED", "Restart Apple sign-in.", 409);
    return b64(srpPublic(this.ephemeral));
  }
  async prove(password: string, input: unknown) {
    if (!this.ephemeral || this.used)
      throw new AppError("AUTH_EXPIRED", "Restart Apple sign-in.", 409);
    this.used = true;
    let derived: Uint8Array | undefined;
    try {
      const challenge = parseChallenge(input);
      derived = await appleKdf(
        password,
        unb64(challenge.salt, 64),
        challenge.iteration,
        challenge.protocol,
      );
      password = "";
      if (!this.ephemeral)
        throw new AppError(
          "AUTH_EXPIRED",
          "The sign-in attempt was cancelled.",
          409,
        );
      const proof = await srpProof(
        this.accountName,
        this.ephemeral,
        derived,
        unb64(challenge.salt, 64),
        unb64(challenge.b, 256),
      );
      if (!this.ephemeral)
        throw new AppError(
          "AUTH_EXPIRED",
          "The sign-in attempt was cancelled.",
          409,
        );
      return { m1: b64(proof.M1), m2: b64(proof.M2) };
    } finally {
      password = "";
      derived?.fill(0);
      this.clear();
    }
  }
  clear() {
    this.ephemeral?.fill(0);
    this.ephemeral = null;
  }
}

export class BrowserBridgeProof {
  private prover: SpakeProver | null = null;
  private exchange: Awaited<ReturnType<SpakeProver["finish"]>> | null = null;
  private revision = 0;
  private kdf: AbortController | null = null;
  private phase: "new" | "deriving" | "share" | "verified" | "closed" = "new";
  async first(code: string, salt: string) {
    if (this.phase !== "new")
      throw new AppError(
        "AUTH_EXPIRED",
        "Restart trusted-device verification.",
        409,
      );
    this.phase = "deriving";
    const controller = new AbortController();
    this.kdf = controller;
    let scalars: Awaited<ReturnType<typeof spakeScalars>>;
    try {
      scalars = await spakeScalars(code, unb64(salt, 64), controller.signal);
    } finally {
      code = "";
      if (this.kdf === controller) this.kdf = null;
    }
    const { w0, w1 } = scalars;
    if (this.phase !== "deriving")
      throw new AppError(
        "AUTH_EXPIRED",
        "The verification attempt was cancelled.",
        409,
      );
    // Rejection sampling preserves the full subgroup distribution.
    let x: bigint;
    do {
      x = integer(crypto.getRandomValues(new Uint8Array(32)));
    } while (x <= 0n || x >= p256.Point.Fn.ORDER);
    this.prover = new SpakeProver(x, w0, w1);
    this.phase = "share";
    return b64(this.prover.message());
  }
  async confirm(serverShare: string, serverConfirmation: string) {
    if (!this.prover || this.phase !== "share")
      throw new AppError(
        "AUTH_EXPIRED",
        "Restart trusted-device verification.",
        409,
      );
    const revision = this.revision;
    const prover = this.prover;
    this.phase = "closed";
    const exchange = await prover.finish(unb64(serverShare, 65));
    try {
      await exchange.verify(unb64(serverConfirmation, 32));
      if (revision !== this.revision)
        throw new AppError(
          "AUTH_EXPIRED",
          "The verification attempt was cancelled.",
          409,
        );
      this.exchange = exchange;
      this.phase = "verified";
      return b64(this.exchange.confirmation);
    } catch (error) {
      exchange.destroy();
      throw error;
    }
  }
  async decrypt(encryptedCode: string) {
    if (!this.exchange || this.phase !== "verified")
      throw new AppError(
        "AUTH_EXPIRED",
        "The Apple bridge confirmation was not verified.",
        409,
      );
    this.phase = "closed";
    const revision = this.revision;
    try {
      const code = await this.exchange.decrypt(encryptedCode);
      if (revision !== this.revision)
        throw new AppError(
          "AUTH_EXPIRED",
          "The verification attempt was cancelled.",
          409,
        );
      return code;
    } catch (error) {
      if (revision !== this.revision)
        throw new AppError(
          "AUTH_EXPIRED",
          "The verification attempt was cancelled.",
          409,
        );
      throw error;
    } finally {
      this.clear();
    }
  }
  clear() {
    this.revision++;
    this.phase = "closed";
    this.kdf?.abort();
    this.kdf = null;
    this.prover = null;
    this.exchange?.destroy();
    this.exchange = null;
  }
}
