import { describe, expect, test } from "bun:test";
import type { AccessToken, TokenCredential } from "@azure/identity";
import type { WebResourceLike } from "@azure/ms-rest-js";
import { toServiceClientCredentials } from "../src/Clients.ts";

describe("Azure client credential adapter", () => {
  test("signs ms-rest requests with a management bearer token", async () => {
    const token: AccessToken = {
      token: "secret-token",
      expiresOnTimestamp: Date.now() + 60_000,
    };
    const credential: TokenCredential = {
      getToken: async (scope) => {
        expect(scope).toBe("https://management.azure.com/.default");
        return token;
      },
    };
    const headers = new Map<string, string>();
    const request = {
      headers: {
        set: (name: string, value: string | number) => headers.set(name, String(value)),
      },
    } as unknown as WebResourceLike;

    const signed = await toServiceClientCredentials(credential).signRequest(request);

    expect(signed).toBe(request);
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
  });

  test("fails when no token is available", async () => {
    const credential: TokenCredential = {
      getToken: async () => null,
    };
    const request = {
      headers: { set: () => undefined },
    } as unknown as WebResourceLike;

    await expect(toServiceClientCredentials(credential).signRequest(request)).rejects.toThrow(
      "Failed to acquire Azure management token",
    );
  });
});
