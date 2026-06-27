import { describe, expect, spyOn, test } from "bun:test";
import { Stack, Stage } from "alchemy";
import * as Effect from "effect/Effect";
import {
  makePhysicalNames,
  requireLocation,
  resourceGroupLocation,
  resourceGroupName,
  withHeartbeat,
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

describe("withHeartbeat", () => {
  test("passes the value through and stays quiet for fast operations", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const value = await runNoContext(
        Effect.succeed("done").pipe(withHeartbeat("fast op", 10)),
      );
      expect(value).toBe("done");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("emits periodic sign-of-life messages while a slow operation runs", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const value = await runNoContext(
        Effect.sleep("45 millis").pipe(
          Effect.as("ready"),
          withHeartbeat("Container App \"smoke\"", 10),
        ),
      );
      expect(value).toBe("ready");
      expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(errorSpy.mock.calls[0]?.[0]).toContain("still working on Container App \"smoke\"");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("stops the heartbeat when the operation fails", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runNoContext(
          Effect.sleep("25 millis").pipe(
            Effect.flatMap(() => Effect.fail(new Error("boom"))),
            withHeartbeat("flaky op", 10),
          ),
        ),
      ).rejects.toThrow("boom");
      const callsAtFailure = errorSpy.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(errorSpy.mock.calls.length).toBe(callsAtFailure);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

function runNoContext<A, E>(effect: Effect.Effect<A, E, unknown>) {
  return Effect.runPromise(effect as Effect.Effect<A, E, never>);
}
