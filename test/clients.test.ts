import { describe, expect, test } from "bun:test";
import type { TokenCredential } from "@azure/identity";
import { buildAzureClients } from "../src/Clients.ts";

describe("Azure client credential surfaces", () => {
  test("builds the Cosmos client directly from a TokenCredential and pins the supported api-version", () => {
    const credential: TokenCredential = {
      getToken: async () => null,
    };

    const clients = buildAzureClients({ credential, subscriptionId: "sub-id" });

    expect(clients.subscriptionId).toBe("sub-id");
    expect((clients.cosmosDB as { apiVersion?: string }).apiVersion).toBe("2024-05-15");
  });
});
