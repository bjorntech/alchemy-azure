import { describe, expect, test } from "bun:test";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Azure from "../src/index.ts";

describe("alchemy-azure", () => {
  test("exports a provider layer and resource constructors", () => {
    expect(typeof Azure.providers).toBe("function");
    expect(typeof Azure.blobState).toBe("function");
    expect(typeof Azure.ResourceGroup).toBe("function");
    expect(typeof Azure.StorageAccount).toBe("function");
    expect(typeof Azure.BlobContainer).toBe("function");
    expect(typeof Azure.UserAssignedIdentity).toBe("function");
    expect(typeof Azure.VirtualNetwork).toBe("function");
    expect(typeof Azure.NetworkSecurityGroup).toBe("function");
    expect(typeof Azure.PublicIPAddress).toBe("function");
    expect(typeof Azure.CognitiveServices).toBe("function");
    expect(typeof Azure.ServiceBus).toBe("function");
    expect(typeof Azure.CosmosDBAccount).toBe("function");
    expect(typeof Azure.SqlServer).toBe("function");
    expect(typeof Azure.SqlDatabase).toBe("function");
    expect(typeof Azure.KeyVault).toBe("function");
    expect(typeof Azure.AppService).toBe("function");
    expect(typeof Azure.FunctionApp).toBe("function");
    expect(typeof Azure.StaticWebApp).toBe("function");
    expect(typeof Azure.ContainerInstance).toBe("function");
    expect(typeof Azure.ContainerAppEnvironment).toBe("function");
    expect(typeof Azure.ContainerRegistry).toBe("function");
    expect(typeof Azure.ContainerImage).toBe("function");
    expect(typeof Azure.ContainerApp).toBe("function");
    expect(typeof Azure.VirtualMachine).toBe("function");
  });

  test("resources compose in a stack program", () => {
    const stack = Alchemy.Stack(
      "typecheck",
      { providers: Azure.providers() as any, state: Alchemy.inMemoryState() },
      Effect.gen(function* () {
        const group = yield* Azure.ResourceGroup("Group", {
          location: "westeurope",
        });
        const storage = yield* Azure.StorageAccount("Storage", {
          resourceGroup: group,
        });
        const container = yield* Azure.BlobContainer("Uploads", {
          storageAccount: storage,
        });
        const environment = yield* Azure.ContainerAppEnvironment("Env", {
          resourceGroup: group,
        });
        const registry = yield* Azure.ContainerRegistry("Registry", {
          resourceGroup: group,
        });
        const image = yield* Azure.ContainerImage("Image", {
          registry,
          context: ".",
          buildHash: "abc123",
        });
        const app = yield* Azure.ContainerApp("Api", {
          resourceGroup: group,
          environment,
          image,
          registry,
          buildHash: "abc123",
          targetPort: 3000,
        });
        return { uploads: container.url, app: app.url };
      }),
    );

    expect(stack).toBeDefined();
  });
});
