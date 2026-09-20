import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { Data, Effect, Schema } from "effect";

export const KeyRing = Schema.Struct({
  active: Schema.String,
  keys: Schema.Record(Schema.String, Schema.String),
});
export type KeyRing = typeof KeyRing.Type;
export const CryptoConfig = Schema.Struct({
  deploymentId: Schema.String,
  encryption: KeyRing,
  verification: KeyRing,
  fingerprint: KeyRing,
  recipientKey: Schema.String,
});
export type CryptoConfig = typeof CryptoConfig.Type;
export const Ciphertext = Schema.Struct({
  version: Schema.Literal(1),
  keyId: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String,
  tag: Schema.String,
});
export type Ciphertext = typeof Ciphertext.Type;
export const Digest = Schema.Struct({ keyId: Schema.String, value: Schema.String });
export type Digest = typeof Digest.Type;
export class CryptoError extends Data.TaggedError("CryptoError")<{}> {}
const keyBytes = (value: string): Buffer => {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) throw new CryptoError();
  return bytes;
};
const key = (ring: KeyRing, id: string) => {
  const value = ring.keys[id];
  if (value === undefined) throw new CryptoError();
  return keyBytes(value);
};
export const validateCrypto = (config: CryptoConfig) =>
  Effect.try({
    try: () => {
      const keys = [config.recipientKey];
      for (const ring of [config.encryption, config.verification, config.fingerprint]) {
        key(ring, ring.active);
        for (const value of Object.values(ring.keys)) {
          keyBytes(value);
          keys.push(value);
        }
      }
      if (new Set(keys).size !== keys.length) throw new CryptoError();
      keyBytes(config.recipientKey);
    },
    catch: () => new CryptoError(),
  });
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonical(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
export const generateCode = (length: number): string =>
  randomInt(10 ** length)
    .toString()
    .padStart(length, "0");
export const operationIdentity = (
  deployment: string,
  operation: string,
  target: string,
  id: string,
) =>
  createHash("sha256")
    .update(JSON.stringify([deployment, operation, target, id]))
    .digest("hex");
export const digest = (ring: KeyRing, input: readonly unknown[], keyId = ring.active): Digest => ({
  keyId,
  value: createHmac("sha256", key(ring, keyId)).update(canonical(input)).digest("hex"),
});
export const equalDigest = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex"),
    right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
};
export const recipientToken = (config: CryptoConfig, phone: string) =>
  createHmac("sha256", keyBytes(config.recipientKey))
    .update(JSON.stringify([1, "recipient", config.deploymentId, phone]))
    .digest("hex");
export const encrypt = (
  config: CryptoConfig,
  challengeId: string,
  field: string,
  plaintext: string,
): Ciphertext => {
  const nonce = randomBytes(12),
    ring = config.encryption;
  const cipher = createCipheriv("aes-256-gcm", key(ring, ring.active), nonce);
  cipher.setAAD(
    Buffer.from(JSON.stringify([1, "encryption", config.deploymentId, challengeId, field])),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: 1,
    keyId: ring.active,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
};
export const decrypt = (
  config: CryptoConfig,
  challengeId: string,
  field: string,
  encrypted: Ciphertext,
) =>
  Effect.try({
    try: () => {
      const nonce = Buffer.from(encrypted.nonce, "base64url"),
        tag = Buffer.from(encrypted.tag, "base64url");
      if (nonce.length !== 12 || tag.length !== 16) throw new CryptoError();
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key(config.encryption, encrypted.keyId),
        nonce,
      );
      cipher.setAAD(
        Buffer.from(JSON.stringify([1, "encryption", config.deploymentId, challengeId, field])),
      );
      cipher.setAuthTag(tag);
      return Buffer.concat([
        cipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
        cipher.final(),
      ]).toString("utf8");
    },
    catch: () => new CryptoError(),
  });
export const verifierInput = (
  config: CryptoConfig,
  challenge: { readonly id: string; readonly purpose: string; readonly contextId: string },
  code: string,
) => [
  1,
  "verifier",
  config.deploymentId,
  challenge.id,
  challenge.purpose,
  challenge.contextId,
  code,
];
