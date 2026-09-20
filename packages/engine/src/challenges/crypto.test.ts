import { createHmac } from "node:crypto";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  decrypt,
  digest,
  encrypt,
  equalDigest,
  operationIdentity,
  validateCrypto,
  verifierInput,
  type CryptoConfig,
} from "./crypto.js";
const config: CryptoConfig = {
  deploymentId: "test",
  encryption: { active: "a", keys: { a: Buffer.alloc(32, 1).toString("base64url") } },
  verification: { active: "v", keys: { v: Buffer.alloc(32, 2).toString("base64url") } },
  fingerprint: { active: "f", keys: { f: Buffer.alloc(32, 3).toString("base64url") } },
  recipientKey: Buffer.alloc(32, 4).toString("base64url"),
};
it.effect("binds encryption to its deployment, challenge and field, preserving leading zeros", () =>
  Effect.gen(function* () {
    yield* validateCrypto(config);
    const encrypted = encrypt(config, "challenge", "code", "000123");
    expect(yield* decrypt(config, "challenge", "code", encrypted)).toBe("000123");
    expect(encrypt(config, "challenge", "code", "000123").nonce).not.toBe(encrypted.nonce);
    expect((yield* decrypt(config, "other", "code", encrypted).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect((yield* decrypt(config, "challenge", "phone", encrypted).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(
      (yield* decrypt(config, "challenge", "code", {
        ...encrypted,
        tag: Buffer.alloc(16).toString("base64url"),
      }).pipe(Effect.result))._tag,
    ).toBe("Failure");
  }),
);
it.effect("retains old decryption and fingerprint keys during writer rotation", () =>
  Effect.gen(function* () {
    const encrypted = encrypt(config, "c", "code", "000001");
    const rotated = {
      ...config,
      encryption: {
        active: "b",
        keys: { ...config.encryption.keys, b: Buffer.alloc(32, 5).toString("base64url") },
      },
    };
    expect(yield* decrypt(rotated, "c", "code", encrypted)).toBe("000001");
    expect(
      (yield* decrypt(
        {
          ...config,
          encryption: { active: "b", keys: { b: Buffer.alloc(32, 5).toString("base64url") } },
        },
        "c",
        "code",
        encrypted,
      ).pipe(Effect.result))._tag,
    ).toBe("Failure");
    const input = verifierInput(config, { id: "c", purpose: "login", contextId: "flow" }, "000001");
    const expected = createHmac("sha256", Buffer.alloc(32, 2))
      .update('[1,"verifier","test","c","login","flow","000001"]')
      .digest("hex");
    expect(equalDigest(digest(config.verification, input).value, expected)).toBe(true);
    expect(equalDigest(digest(config.verification, [...input, "different"]).value, expected)).toBe(
      false,
    );
    expect(operationIdentity("test", "verify", "c", "key")).not.toBe(
      operationIdentity("test", "cancel", "c", "key"),
    );
  }),
);
