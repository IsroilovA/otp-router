import { Effect, Layer, type Schema } from "effect";
import {
  ProviderConfigurationError,
  ProviderInstance,
  type ProviderDefinition,
  type ReadyProvider,
} from "./contract.js";
import {
  makeTemplateResolver,
  readyMetadata,
  resolveNoTemplate,
  validateAllTemplates,
  validateProviderConfiguration,
  validateTimeout,
} from "./internal.js";

type ProviderBehavior = Pick<ReadyProvider, "send" | "callback"> &
  Partial<Pick<ReadyProvider, "resolveTemplate">>;

type ProviderSpecification<A, AI, S, SI, C, CI, E, EI, T extends Schema.Json, TI> = Omit<
  ProviderDefinition,
  | "make"
  | "makeCallback"
  | "identitySchema"
  | "secretsSchema"
  | "callbackSecretsSchema"
  | "executionSchema"
  | "templateSchema"
> & {
  readonly identitySchema: Schema.Codec<A, AI>;
  readonly secretsSchema: Schema.Codec<S, SI>;
  readonly callbackSecretsSchema: Schema.Codec<C, CI>;
  readonly executionSchema: Schema.Codec<E, EI>;
  readonly templateSchema: Schema.Codec<T, TI> | null;
  readonly create: (config: {
    readonly identity: A;
    readonly secrets: S;
    readonly execution: E;
  }) => ProviderBehavior;
  readonly callback?: (config: {
    readonly identity: A;
    readonly callbackSecrets: C;
    readonly execution: E;
  }) => NonNullable<ReadyProvider["callback"]>;
};

const validConstraint = (value: number, minimum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum;

/** Validates trusted adapter definitions and deployment settings before constructing an instance. */
export const defineProvider = <
  A,
  AI,
  S,
  SI,
  C,
  CI,
  E,
  EI,
  T extends Schema.Json = Schema.Json,
  TI = T,
>(
  specification: ProviderSpecification<A, AI, S, SI, C, CI, E, EI, T, TI>,
): ProviderDefinition => ({
  ...specification,
  makeCallback: (options) =>
    Effect.gen(function* () {
      if (specification.callback === undefined) return undefined;
      const identity = yield* validateProviderConfiguration(
        specification.identitySchema,
        options.identity,
      );
      const callbackSecrets = yield* validateProviderConfiguration(
        specification.callbackSecretsSchema,
        options.callbackSecrets,
      );
      const execution = yield* validateProviderConfiguration(
        specification.executionSchema,
        options.execution,
      );
      return specification.callback({ identity, callbackSecrets, execution });
    }),
  make: (options) =>
    Layer.effect(
      ProviderInstance,
      Effect.gen(function* () {
        const identity = yield* validateProviderConfiguration(
          specification.identitySchema,
          options.identity,
        );
        const secrets = yield* validateProviderConfiguration(
          specification.secretsSchema,
          options.secrets,
        );
        const execution = yield* validateProviderConfiguration(
          specification.executionSchema,
          options.execution,
        );
        const sendTimeoutMs = yield* validateTimeout(
          options.sendTimeoutMs,
          specification.defaultSendTimeoutMs,
        );
        const { constraints } = specification;
        if (
          !validConstraint(constraints.minCodeLength, 1) ||
          !validConstraint(constraints.maxCodeLength, constraints.minCodeLength) ||
          !validConstraint(constraints.minDeliveryWindowMs, 0)
        ) {
          return yield* new ProviderConfigurationError({ diagnosticCode: "invalid_constraints" });
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.revision)) {
          return yield* new ProviderConfigurationError({
            diagnosticCode: "invalid_revision",
          });
        }
        if (specification.diagnosticCodes.some((code) => !/^[a-z][a-z0-9_]{0,127}$/u.test(code))) {
          return yield* new ProviderConfigurationError({
            diagnosticCode: "invalid_diagnostic_codes",
          });
        }
        const schema = specification.templateSchema;
        if (schema !== null) yield* validateAllTemplates(schema, options.templates);
        const behavior = specification.create({ identity, secrets, execution });
        return {
          ...readyMetadata(specification, options, sendTimeoutMs),
          ...behavior,
          ...(options.callbackSecrets === undefined || specification.callback === undefined
            ? {}
            : {
                callback: specification.callback({
                  identity,
                  execution,
                  callbackSecrets: yield* validateProviderConfiguration(
                    specification.callbackSecretsSchema,
                    options.callbackSecrets,
                  ),
                }),
              }),
          resolveTemplate:
            behavior.resolveTemplate ??
            (schema === null ? resolveNoTemplate : makeTemplateResolver(schema, options.templates)),
        };
      }),
    ),
});
