import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  AzureAuthConfigSchema,
  AzureStoredCredentialsSchema,
  azureDetails,
  resolveFromStored,
} from "../src/AuthProvider.ts";
import { createAzureCredentials } from "../src/Credentials.ts";

describe("Azure beta.80 native auth", () => {
  test("uses schema-backed named auth configurations", async () => {
    const decode = Schema.decodeUnknownEffect(AzureAuthConfigSchema);
    await expect(Effect.runPromise(decode({ method: "env" }))).resolves.toEqual({ method: "env" });
    await expect(Effect.runPromise(decode({ method: "legacy" }))).rejects.toThrow();
  });

  test("resolves stored service principal secrets as redacted values", async () => {
    const credentials = await Effect.runPromise(
      resolveFromStored({
        subscriptionId: "subscription",
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret-value",
      }),
    );
    expect(credentials.method).toBe("servicePrincipal");
    if (credentials.method !== "servicePrincipal") throw new Error("unreachable");
    expect(Redacted.value(credentials.clientSecret)).toBe("secret-value");
    const rendered = azureDetails(credentials)
      .lines.map((line) => `${line.key}: ${line.value}`)
      .join("\n");
    expect(rendered).not.toContain("secret-value");
  });

  test("schema accepts subscription-only stored default credentials", async () => {
    const stored = await Effect.runPromise(
      Schema.decodeUnknownEffect(AzureStoredCredentialsSchema)({
        subscriptionId: "subscription",
      }),
    );
    expect(stored.subscriptionId).toBe("subscription");
    const credentials = createAzureCredentials(await Effect.runPromise(resolveFromStored(stored)));
    expect(credentials.subscriptionId).toBe("subscription");
    expect(credentials.clientSecret).toBeUndefined();
  });
});
