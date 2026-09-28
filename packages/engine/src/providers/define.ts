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

type ProviderSpecification<C, I, T extends Schema.Json, TI> = Omit<
  ProviderDefinition<C, I>,
  "make" | "templateSchema"
> & {
  readonly templateSchema: Schema.Codec<T, TI> | null;
  readonly create: (config: C) => ProviderBehavior;
};

const validConstraint = (value: number, minimum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum;

/** Validates trusted adapter definitions and deployment settings before constructing an instance. */
export const defineProvider = <C, I, T extends Schema.Json = Schema.Json, TI = T>(
  specification: ProviderSpecification<C, I, T, TI>,
): ProviderDefinition<C, I> => ({
  ...specification,
  make: (options) =>
    Layer.effect(
      ProviderInstance,
      Effect.gen(function* () {
        const config = yield* validateProviderConfiguration(
          specification.configSchema,
          options.config,
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
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.compatibilityRevision)) {
          return yield* new ProviderConfigurationError({
            diagnosticCode: "invalid_compatibility_revision",
          });
        }
        if (specification.diagnosticCodes.some((code) => !/^[a-z][a-z0-9_]{0,127}$/u.test(code))) {
          return yield* new ProviderConfigurationError({
            diagnosticCode: "invalid_diagnostic_codes",
          });
        }
        const schema = specification.templateSchema;
        if (schema !== null) yield* validateAllTemplates(schema, options.templates);
        const behavior = specification.create(config);
        return {
          ...readyMetadata(specification, options, sendTimeoutMs),
          ...behavior,
          resolveTemplate:
            behavior.resolveTemplate ??
            (schema === null ? resolveNoTemplate : makeTemplateResolver(schema, options.templates)),
        };
      }),
    ),
});
