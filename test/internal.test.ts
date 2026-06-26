import { describe, expect, test } from "bun:test";
import { Stack, Stage } from "alchemy";
import * as Effect from "effect/Effect";
import {
  makePhysicalNames,
  requireLocation,
  resourceGroupLocation,
  resourceGroupName,
} from "../src/Internal.ts";

describe("internal resource helpers", () => {
  test("uses explicit physical names unchanged", async () => {
    const names = await runNoContext(
        makePhysicalNames.pipe(
          Effect.provideService(Stage, "test"),
          Effect.provideService(Stack, {
            name: "stack",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
        ),
    );
    const name = names.physicalName("ignored", "0".repeat(32), "explicit-name");

    expect(name).toBe("explicit-name");
  });

  test("resolves resource group name and location for string groups", async () => {
    const name = await runNoContext(resourceGroupName("rg-prod"));
    const location = await runNoContext(resourceGroupLocation("rg-prod"));

    expect(name).toBe("rg-prod");
    expect(location).toBeUndefined();
  });

  test("requires location when resource group is only a string", async () => {
    await expect(runNoContext(requireLocation("App", undefined, "rg-prod"))).rejects.toThrow(
      "App requires location when resourceGroup is a string.",
    );
  });

  test("prefers explicit location", async () => {
    const location = await runNoContext(requireLocation("App", "westeurope", "rg-prod"));

    expect(location).toBe("westeurope");
  });
});

function runNoContext<A, E>(effect: Effect.Effect<A, E, unknown>) {
  return Effect.runPromise(effect as Effect.Effect<A, E, never>);
}
