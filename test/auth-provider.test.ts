import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { AuthError } from "alchemy/Auth/AuthProvider";
import {
  resolveFromEnv,
  resolveFromStored,
  type AzureStoredCredentials,
} from "../src/AuthProvider.ts";

const withEnv = <A, E>(
  env: Record<string, string>,
  effect: Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.provide(effect, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

const exitWithEnv = <A, E>(
  env: Record<string, string>,
  effect: Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.exit(effect),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    ),
  );

describe("resolveFromEnv", () => {
  test("fails when AZURE_SUBSCRIPTION_ID is missing", async () => {
    const exit = await exitWithEnv({}, resolveFromEnv());
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    const error = Cause.findErrorOption(exit.cause);
    expect(error._tag).toBe("Some");
    if (error._tag !== "Some") throw new Error("unreachable");
    expect(error.value).toBeInstanceOf(AuthError);
    expect((error.value as AuthError).message).toContain(
      "Azure env credentials not found",
    );
  });

  test("returns DefaultAzureCredential mode when only subscription is set", async () => {
    const credentials = await withEnv(
      { AZURE_SUBSCRIPTION_ID: "sub-1" },
      resolveFromEnv(),
    );

    expect(credentials.method).toBe("default");
    expect(credentials.subscriptionId).toBe("sub-1");
    expect(credentials.source.type).toBe("env");
  });

  test("returns service principal when full env is set", async () => {
    const credentials = await withEnv(
      {
        AZURE_SUBSCRIPTION_ID: "sub-1",
        AZURE_TENANT_ID: "tenant-1",
        AZURE_CLIENT_ID: "client-1",
        AZURE_CLIENT_SECRET: "secret-1",
      },
      resolveFromEnv(),
    );

    expect(credentials.method).toBe("servicePrincipal");
    if (credentials.method !== "servicePrincipal") throw new Error("unreachable");
    expect(credentials.tenantId).toBe("tenant-1");
    expect(credentials.clientId).toBe("client-1");
    expect(Redacted.value(credentials.clientSecret)).toBe("secret-1");
    expect(credentials.source.type).toBe("env");
  });

  test("falls back to default when one service principal field is missing", async () => {
    const credentials = await withEnv(
      {
        AZURE_SUBSCRIPTION_ID: "sub-1",
        AZURE_TENANT_ID: "tenant-1",
        AZURE_CLIENT_ID: "client-1",
        // AZURE_CLIENT_SECRET intentionally omitted
      },
      resolveFromEnv(),
    );

    expect(credentials.method).toBe("default");
    if (credentials.method !== "default") throw new Error("unreachable");
    expect(credentials.tenantId).toBe("tenant-1");
  });
});

describe("resolveFromStored", () => {
  test("fails with AuthError when credentials are missing", async () => {
    const exit = await Effect.runPromise(Effect.exit(resolveFromStored(undefined)));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    const error = Cause.findErrorOption(exit.cause);
    expect(error._tag).toBe("Some");
    if (error._tag !== "Some") throw new Error("unreachable");
    expect(error.value).toBeInstanceOf(AuthError);
    expect((error.value as AuthError).message).toContain(
      "Azure stored credentials not found",
    );
  });

  test("returns service principal when full credentials are stored", async () => {
    const stored: AzureStoredCredentials = {
      subscriptionId: "sub-1",
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "secret-1",
    };

    const credentials = await Effect.runPromise(resolveFromStored(stored));

    expect(credentials.method).toBe("servicePrincipal");
    if (credentials.method !== "servicePrincipal") throw new Error("unreachable");
    expect(credentials.subscriptionId).toBe("sub-1");
    expect(Redacted.value(credentials.clientSecret)).toBe("secret-1");
    expect(credentials.source.type).toBe("stored");
  });

  test("returns DefaultAzureCredential mode when only subscription is stored", async () => {
    const credentials = await Effect.runPromise(
      resolveFromStored({ subscriptionId: "sub-1" }),
    );

    expect(credentials.method).toBe("default");
    expect(credentials.subscriptionId).toBe("sub-1");
    expect(credentials.source.type).toBe("stored");
  });

  test("falls back to default when partial service principal fields are stored", async () => {
    const credentials = await Effect.runPromise(
      resolveFromStored({
        subscriptionId: "sub-1",
        tenantId: "tenant-1",
        clientId: "client-1",
        // clientSecret missing
      }),
    );

    expect(credentials.method).toBe("default");
  });
});
