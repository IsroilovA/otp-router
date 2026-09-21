import { Context, Effect } from "effect";

// A fresh set belongs to each outer delivery transaction. Nested callback merges
// share it, so a commit publishes only the resulting snapshot for each delivery.
export const Changes = Context.Reference<Set<string> | undefined>("otp-router/DeliveryChanges", {
  defaultValue: () => undefined,
});
export const changed = (id: string) =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    if (changes === undefined)
      return yield* Effect.die(new Error("Delivery operation mutation outside its transaction"));
    changes.add(id);
  });
