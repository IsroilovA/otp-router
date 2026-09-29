import { verifierInput } from "./crypto.js";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { decrypt, digest, encrypt, operationIdentity } from "../crypto.js";
const config = {
  deploymentId: "test",
  encryption: { active: "a", keys: { a: Buffer.alloc(32, 1).toString("base64url") } },
  verification: { active: "v", keys: { v: Buffer.alloc(32, 2).toString("base64url") } },
  fingerprint: { active: "f", keys: { f: Buffer.alloc(32, 3).toString("base64url") } },
  recipientKey: Buffer.alloc(32, 4).toString("base64url"),
};
it.effect("binds encryption to its deployment, project, operation and field", () =>
  Effect.gen(function* () {
    const encrypted = encrypt(
      config,
      { projectId: "demo", operationId: "challenge" },
      "code",
      "000123",
    );
    expect(
      yield* decrypt(config, { projectId: "demo", operationId: "challenge" }, "code", encrypted),
    ).toBe("000123");
    expect(
      encrypt(config, { projectId: "demo", operationId: "challenge" }, "code", "000123").nonce,
    ).not.toBe(encrypted.nonce);
    expect(
      (yield* decrypt(config, { projectId: "demo", operationId: "other" }, "code", encrypted).pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* decrypt(
        config,
        { projectId: "other", operationId: "challenge" },
        "code",
        encrypted,
      ).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* decrypt(
        { ...config, deploymentId: "other" },
        { projectId: "demo", operationId: "challenge" },
        "code",
        encrypted,
      ).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* decrypt(
        config,
        { projectId: "demo", operationId: "challenge" },
        "phone",
        encrypted,
      ).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* decrypt(config, { projectId: "demo", operationId: "challenge" }, "code", {
        ...encrypted,
        tag: Buffer.alloc(16).toString("base64url"),
      }).pipe(Effect.result))._tag,
    ).toBe("Failure");
  }),
);
it.effect("decrypts existing ciphertext after writer rotation only while its key is retained", () =>
  Effect.gen(function* () {
    const encrypted = encrypt(config, { projectId: "demo", operationId: "c" }, "code", "000001");
    const rotated = {
      ...config,
      encryption: {
        active: "b",
        keys: { ...config.encryption.keys, b: Buffer.alloc(32, 5).toString("base64url") },
      },
    };
    expect(
      yield* decrypt(rotated, { projectId: "demo", operationId: "c" }, "code", encrypted),
    ).toBe("000001");
    expect(
      (yield* decrypt(
        {
          ...config,
          encryption: { active: "b", keys: { b: Buffer.alloc(32, 5).toString("base64url") } },
        },
        { projectId: "demo", operationId: "c" },
        "code",
        encrypted,
      ).pipe(Effect.result))._tag,
    ).toBe("Failure");
  }),
);

it("separates verification bindings and mutation receipt scopes", () => {
  const challenge = { projectId: "demo", id: "c", purpose: "login", contextId: "flow" };
  const inputs = [
    verifierInput(config, challenge, "000001"),
    verifierInput({ ...config, deploymentId: "other" }, challenge, "000001"),
    ...Object.keys(challenge).map((field) =>
      verifierInput(config, { ...challenge, [field]: "other" }, "000001"),
    ),
    verifierInput(config, challenge, "000002"),
  ];
  const values = inputs.map((input) => digest(config.verification, input).value);
  expect(new Set(values).size).toBe(inputs.length);
  expect(operationIdentity("test", "demo", { name: "verify", target: "c", key: "key" })).not.toBe(
    operationIdentity("test", "demo", { name: "cancel", target: "c", key: "key" }),
  );
});
