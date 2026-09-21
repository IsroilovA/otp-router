import { Schema } from "effect";
export const Identifier = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
);
export const Opaque = Schema.String.pipe(Schema.check(Schema.isPattern(/^[!-~]{1,128}$/)));
export const Locale = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/)));
export const Code = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9]{6,8}$/)));
export const Primitive = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]);
export const RoutingContext = Schema.Record(Schema.String, Primitive).pipe(
  Schema.check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= 4096)),
);
export const Choice = Schema.Union([
  Schema.Struct({ type: Schema.Literal("channel"), channel: Identifier }),
  Schema.Struct({ type: Schema.Literal("provider"), providerInstanceId: Identifier }),
]);
export type Choice = typeof Choice.Type;
export const DeliveryInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("resend") }),
  Schema.Struct({ action: Schema.Literal("next") }),
  Schema.Struct({ action: Schema.Literal("select"), choice: Choice }),
]);
export type DeliveryInput = typeof DeliveryInput.Type;
