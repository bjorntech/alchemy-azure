import { beforeEach, describe, expect } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { adopt as adoptResource } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import type { ScratchStack } from "alchemy/Test/Bun";
import * as Redacted from "effect/Redacted";
import * as Test from "alchemy/Test/Bun";
import * as Azure from "../src/index.ts";
import { recordKey } from "./support/azure-mock.ts";
import { testProviders } from "./support/test-providers.ts";

const { mock, providers } = testProviders();
const { test } = Test.make({ providers });
// `adopt: true` makes the engine call `provider.read` before reconciling a
// resource that has no prior state — the seam that exercises the read path.
const adopt = Test.make({ providers, adopt: true });
const directProviderLayer = Layer.mergeAll(
  Azure.ResourceGroupProvider(),
  Azure.ResourceProviderRegistrationProvider(),
  Azure.StorageAccountProvider(),
  Azure.BlobContainerProvider(),
  Azure.UserAssignedIdentityProvider(),
  Azure.VirtualNetworkProvider(),
  Azure.NetworkSecurityGroupProvider(),
  Azure.PublicIPAddressProvider(),
  Azure.CognitiveServicesProvider(),
  Azure.ServiceBusProvider(),
  Azure.CosmosDBAccountProvider(),
  Azure.SqlServerProvider(),
  Azure.SqlDatabaseProvider(),
  Azure.KeyVaultProvider(),
  Azure.AppServicePlanProvider(),
  Azure.AppServiceProvider(),
  Azure.FunctionAppProvider(),
  Azure.StaticWebAppProvider(),
  Azure.ContainerInstanceProvider(),
  Azure.ContainerAppEnvironmentProvider(),
  Azure.ContainerRegistryProvider(),
  Azure.ContainerImageProvider(),
  Azure.ContainerAppProvider(),
  Azure.VirtualMachineProvider(),
).pipe(
  Layer.provide(Layer.succeed(Azure.AzureClients, Azure.AzureClients.of(mock.clients))),
  Layer.provide(Azure.AzureOperationLockLive),
);

beforeEach(() => {
  mock.records.clear();
  mock.calls.length = 0;
});

const called = (prefix: string) => mock.calls.some((c) => c.startsWith(prefix));
const calls = (prefix: string) => mock.calls.filter((c) => c.startsWith(prefix));

/**
 * Deploy expecting failure, returning the rendered cause. Provider validation
 * uses `throw`, which lands in the defect channel, so `Effect.flip` is not
 * enough — `Effect.exit` captures both failures and defects.
 */
const expectDeployToFail = (stack: ScratchStack, program: Effect.Effect<unknown, unknown, any>) =>
  Effect.exit(stack.deploy(program)).pipe(
    Effect.map((exit) => {
      if (exit._tag === "Success") throw new Error("expected deploy to fail, but it succeeded");
      return Cause.pretty(exit.cause);
    }),
  );

describe("ResourceGroup provider", () => {
  test.provider("creates, tags, and deletes a resource group", (stack) =>
    Effect.gen(function* () {
      const group = yield* stack.deploy(
        Azure.ResourceGroup("Group", {
          location: "westeurope",
          tags: { app: "demo" },
        }),
      );

      expect(group.name).toBeDefined();
      expect(group.location).toBe("westeurope");
      expect(group.resourceGroupId).toContain("/resourceGroups/");
      expect(group.provisioningState).toBe("Succeeded");
      expect(group.tags?.["alchemy:logical-id"]).toBeDefined();
      expect(group.tags?.app).toBe("demo");
      expect(called("resourceGroups.put")).toBe(true);

      yield* stack.destroy();
      expect(called("resourceGroups.delete")).toBe(true);
    }),
  );

  test.provider("replaces the resource group when location changes", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Azure.ResourceGroup("Group", { location: "westeurope" }));
      expect(first.location).toBe("westeurope");

      const second = yield* stack.deploy(Azure.ResourceGroup("Group", { location: "eastus" }));
      expect(second.location).toBe("eastus");
    }),
  );

  test.provider("updates the resource group when tags change", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(Azure.ResourceGroup("Group", { location: "westeurope", tags: { phase: "one" } }));
      yield* stack.deploy(Azure.ResourceGroup("Group", { location: "westeurope", tags: { phase: "two" } }));

      expect(calls("resourceGroups.put")).toHaveLength(2);
      expect(called("resourceGroups.delete")).toBe(false);
    }),
  );

  adopt.test.provider("reads before creating when adopting a resource group", (stack) =>
    Effect.gen(function* () {
      const group = yield* stack.deploy(Azure.ResourceGroup("Group", { location: "westeurope" }));

      // adopt mode runs `read` (a `get`) first, finds nothing, then creates.
      expect(called("resourceGroups.get")).toBe(true);
      expect(called("resourceGroups.put")).toBe(true);
      expect(group.location).toBe("westeurope");
    }),
  );

  test.provider("rejects an invalid resource group name", (stack) =>
    expectDeployToFail(
      stack,
      Azure.ResourceGroup("Group", { name: "bad name!!", location: "westeurope" }),
    ).pipe(Effect.map((cause) => expect(cause).toContain("is invalid"))),
  );
});

describe("StorageAccount provider", () => {
  test.provider("creates a storage account with redacted secrets", (stack) =>
    Effect.gen(function* () {
      const account = yield* stack.deploy(
        Azure.StorageAccount("Store", {
          name: "alchemyteststore01",
          resourceGroup: "rg-test",
          location: "westeurope",
          sku: "Standard_GRS",
        }),
      );

      expect(account.name).toBe("alchemyteststore01");
      expect(account.resourceGroupName).toBe("rg-test");
      expect(account.primaryBlobEndpoint).toContain("blob.core.windows.net");
      expect(Redacted.value(account.primaryAccessKey!)).toBe("fake-account-key");
      expect(Redacted.value(account.primaryConnectionString!)).toContain(
        "AccountKey=fake-account-key",
      );
      expect(called("storageAccounts.listKeys")).toBe(true);

      yield* stack.destroy();
      expect(called("storageAccounts.delete")).toBe(true);
    }),
  );

  test.provider("rejects an invalid storage account name", (stack) =>
    expectDeployToFail(
      stack,
      Azure.StorageAccount("Store", {
        name: "Invalid_Name",
        resourceGroup: "rg-test",
        location: "westeurope",
      }),
    ).pipe(Effect.map((cause) => expect(cause).toContain("is invalid"))),
  );

  test.provider("retained storage account is rediscovered from read path", (stack) =>
    Effect.gen(function* () {
      const program = Azure.StorageAccount("Store", {
        name: "retainstore001",
        resourceGroup: "rg-test",
        location: "westeurope",
      }).pipe(retain());

      const created = yield* stack.deploy(program);
      yield* stack.destroy();
      const redeployed = yield* stack.deploy(program);

      expect(redeployed.storageAccountId).toBe(created.storageAccountId);
      expect(calls("storageAccounts.delete:retainstore001")).toHaveLength(0);
      expect(calls("storageAccounts.get:retainstore001").length).toBeGreaterThan(0);
    }),
  );

  test.provider("resolves storage account location from persisted state on update", (stack) =>
    Effect.gen(function* () {
      // StorageAccount has its own group-location derivation; this guards the
      // same beta.58 regression as the location helper migration: omitting
      // location on update must fall back to the persisted value, not throw.
      const base = { name: "locstore0001", resourceGroup: "rg-test" };

      yield* stack.deploy(
        Azure.StorageAccount("Store", { ...base, location: "westeurope", tags: { phase: "create" } }),
      );
      const updated = yield* stack.deploy(
        Azure.StorageAccount("Store", { ...base, tags: { phase: "update" } }),
      );

      expect(updated.location).toBe("westeurope");
      expect(called("storageAccounts.delete")).toBe(false);
    }),
  );

  test.provider("replaces a storage account when kind changes", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Azure.StorageAccount("Store", {
          name: "kindstore001",
          resourceGroup: "rg-test",
          location: "westeurope",
          kind: "StorageV2",
        }),
      );
      yield* stack.deploy(
        Azure.StorageAccount("Store", {
          name: "kindstore001",
          resourceGroup: "rg-test",
          location: "westeurope",
          kind: "BlobStorage",
        }),
      );

      expect(called("storageAccounts.delete")).toBe(true);
    }),
  );

  test.provider("rejects then adopts an unowned existing storage account", (stack) =>
    Effect.gen(function* () {
      mock.seedKind("storageAccounts", "rg-test", {
        name: "foreignstore001",
        location: "westeurope",
        primaryEndpoints: { blob: "https://foreignstore001.blob.core.windows.net/" },
      });

      yield* expectDeployToFail(
        stack,
        Azure.StorageAccount("Store", {
          name: "foreignstore001",
          resourceGroup: "rg-test",
          location: "westeurope",
        }),
      ).pipe(Effect.map((cause) => expect(cause).toContain("Cannot adopt resource")));

      const adopted = yield* stack.deploy(
        Azure.StorageAccount("Store", {
          name: "foreignstore001",
          resourceGroup: "rg-test",
          location: "westeurope",
        }).pipe(adoptResource()),
      );

      expect(adopted.name).toBe("foreignstore001");
      expect(calls("storageAccounts.get:foreignstore001").length).toBeGreaterThan(0);
    }),
  );

  test.provider("does not trust prior state when ownership tag disappears", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Azure.StorageAccount("Store", {
          name: "ownedstore002",
          resourceGroup: "rg-test",
          location: "westeurope",
          tags: { phase: "create" },
        }),
      );

      const key = recordKey("storageAccounts", "rg-test", "ownedstore002");
      const record = mock.records.get(key)!;
      mock.records.set(key, { ...record, tags: { phase: "foreign" } });

      yield* expectDeployToFail(
        stack,
        Azure.StorageAccount("Store", {
          name: "ownedstore002",
          resourceGroup: "rg-test",
          location: "westeurope",
          tags: { phase: "update" },
        }),
      ).pipe(Effect.map((cause) => expect(cause).toContain("Cannot adopt resource")));
    }),
  );
});

describe("BlobContainer provider", () => {
  test.provider("creates a blob container with a public URL", (stack) =>
    Effect.gen(function* () {
      const container = yield* stack.deploy(
        Azure.BlobContainer("Uploads", {
          storageAccount: "mystore",
          resourceGroup: "rg-test",
          publicAccess: "Blob",
          metadata: { team: "platform" },
        }),
      );

      expect(container.storageAccountName).toBe("mystore");
      expect(container.url).toBe(`https://mystore.blob.core.windows.net/${container.name}`);
      expect(container.publicAccess).toBe("Blob");
      expect(container.metadata?.team).toBe("platform");
      expect(container.metadata?.alchemyLogicalId).toBeDefined();

      yield* stack.destroy();
      expect(called("blobContainers.delete")).toBe(true);
    }),
  );

  test.provider("requires a resource group when storageAccount is a string", (stack) =>
    expectDeployToFail(
      stack,
      Azure.BlobContainer("Uploads", { storageAccount: "mystore" }),
    ).pipe(Effect.map((cause) => expect(cause).toContain("requires resourceGroup"))),
  );

  test.provider("does not trust prior state when ownership metadata disappears", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Azure.BlobContainer("Uploads", {
          name: "owneduploads",
          storageAccount: "mystore",
          resourceGroup: "rg-test",
          metadata: { phase: "create" },
        }),
      );

      const key = recordKey("blobContainers", "rg-test/mystore", first.name);
      const record = mock.records.get(key)!;
      mock.records.set(key, { ...record, metadata: { phase: "foreign" } });

      yield* expectDeployToFail(
        stack,
        Azure.BlobContainer("Uploads", {
          name: "owneduploads",
          storageAccount: "mystore",
          resourceGroup: "rg-test",
          metadata: { phase: "update" },
        }),
      ).pipe(Effect.map((cause) => expect(cause).toContain("Cannot adopt resource")));
    }),
  );
});

describe("Network resource providers", () => {
  test.provider("creates a user-assigned identity with principal metadata", (stack) =>
    Effect.gen(function* () {
      const identity = yield* stack.deploy(
        Azure.UserAssignedIdentity("Id", { resourceGroup: "rg-test", location: "westeurope" }),
      );

      expect(identity.principalId).toBe("principal-id");
      expect(identity.clientId).toBe("client-id");
      expect(identity.tenantId).toBe("tenant-id");

      yield* stack.destroy();
      expect(called("userAssignedIdentities.delete")).toBe(true);
    }),
  );

  test.provider("resolves location from persisted state when omitted on update", (stack) =>
    Effect.gen(function* () {
      // Regression for the beta.58 whole-resource reference change: on update a
      // referenced group no longer exposes its (non-stable) location, so a
      // resource that derives location from the group must fall back to its own
      // persisted location instead of throwing "requires location". A string
      // resourceGroup carries no location, so omitting location on the second
      // deploy reproduces the stripped-attribute condition deterministically.
      const base = { name: "loc-identity", resourceGroup: "rg-test" };

      yield* stack.deploy(
        Azure.UserAssignedIdentity("Id", { ...base, location: "westeurope", tags: { phase: "create" } }),
      );
      const updated = yield* stack.deploy(
        Azure.UserAssignedIdentity("Id", { ...base, tags: { phase: "update" } }),
      );

      expect(updated.location).toBe("westeurope");
      expect(calls("userAssignedIdentities.put:loc-identity")).toHaveLength(2);
      expect(called("userAssignedIdentities.delete")).toBe(false);
    }),
  );

  test.provider("creates a virtual network with default address space", (stack) =>
    Effect.gen(function* () {
      const vnet = yield* stack.deploy(
        Azure.VirtualNetwork("Net", { resourceGroup: "rg-test", location: "westeurope" }),
      );

      expect(vnet.addressSpace).toEqual(["10.0.0.0/16"]);
      expect(vnet.subnets[0]?.name).toBe("default");
      expect(vnet.subnets[0]?.id).toContain("/virtualNetworks/");
      expect(vnet.subnets[0]?.id).toContain("/subnets/default");
      expect(vnet.subnets[0]?.addressPrefix).toBe("10.0.0.0/24");

      yield* stack.destroy();
      expect(called("virtualNetworks.delete")).toBe(true);
    }),
  );

  adopt.test.provider("reads before creating when adopting a virtual network", (stack) =>
    Effect.gen(function* () {
      const vnet = yield* stack.deploy(
        Azure.VirtualNetwork("Net", { resourceGroup: "rg-test", location: "westeurope" }),
      );

      expect(called("virtualNetworks.get")).toBe(true);
      expect(vnet.addressSpace).toEqual(["10.0.0.0/16"]);
    }),
  );

  test.provider("updates a virtual network when mutable properties change", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Azure.VirtualNetwork("Net", {
          name: "mutable-vnet",
          resourceGroup: "rg-test",
          location: "westeurope",
          addressSpace: ["10.0.0.0/16"],
        }),
      );
      yield* stack.deploy(
        Azure.VirtualNetwork("Net", {
          name: "mutable-vnet",
          resourceGroup: "rg-test",
          location: "westeurope",
          addressSpace: ["10.1.0.0/16"],
        }),
      );

      expect(calls("virtualNetworks.put:mutable-vnet")).toHaveLength(2);
    }),
  );

  test.provider("creates a network security group with rules", (stack) =>
    Effect.gen(function* () {
      const nsg = yield* stack.deploy(
        Azure.NetworkSecurityGroup("Nsg", {
          resourceGroup: "rg-test",
          location: "westeurope",
          securityRules: [
            {
              name: "allow-https",
              priority: 100,
              direction: "Inbound",
              access: "Allow",
              protocol: "Tcp",
              destinationPortRange: "443",
            },
          ],
        }),
      );

      expect(nsg.securityRules[0]?.name).toBe("allow-https");
      expect(nsg.securityRules[0]?.priority).toBe(100);
      expect(nsg.securityRules[0]?.destinationPortRange).toBe("443");
      expect(nsg.securityRules[0]?.sourceAddressPrefix).toBe("*");

      yield* stack.destroy();
      expect(called("networkSecurityGroups.delete")).toBe(true);
    }),
  );

  test.provider("creates a standard public IP address", (stack) =>
    Effect.gen(function* () {
      const ip = yield* stack.deploy(
        Azure.PublicIPAddress("Ip", {
          resourceGroup: "rg-test",
          location: "westeurope",
          sku: "Standard",
        }),
      );

      expect(ip.ipAddress).toBe("20.0.0.1");
      expect(ip.resourceId).toContain("/publicIPAddresses/");

      yield* stack.destroy();
      expect(called("publicIPAddresses.delete")).toBe(true);
    }),
  );

  test.provider("replaces a public IP address when SKU changes", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Azure.PublicIPAddress("Ip", { resourceGroup: "rg-test", location: "westeurope", sku: "Basic" }),
      );
      yield* stack.deploy(
        Azure.PublicIPAddress("Ip", { resourceGroup: "rg-test", location: "westeurope", sku: "Standard" }),
      );

      expect(called("publicIPAddresses.delete")).toBe(true);
    }),
  );
});

describe("Data + messaging providers", () => {
  test.provider("creates a cognitive services account with redacted keys", (stack) =>
    Effect.gen(function* () {
      const account = yield* stack.deploy(
        Azure.CognitiveServices("Ai", {
          resourceGroup: "rg-test",
          location: "westeurope",
          kind: "OpenAI",
          sku: "S0",
        }),
      );
      expect(account.kind).toBe("OpenAI");
      expect(account.sku).toBe("S0");
      expect(account.endpoint).toContain("cognitiveservices.azure.com");
      expect(Redacted.value(account.primaryKey!)).toBe("cog-key-1");
      expect(Redacted.value(account.secondaryKey!)).toBe("cog-key-2");

      yield* stack.destroy();
      expect(called("cognitiveAccounts.delete")).toBe(true);
    }),
  );

  test.provider("creates a Service Bus namespace with connection strings", (stack) =>
    Effect.gen(function* () {
      const bus = yield* stack.deploy(
        Azure.ServiceBus("Bus", {
          resourceGroup: "rg-test",
          location: "westeurope",
          sku: "Standard",
        }),
      );
      expect(bus.sku).toBe("Standard");
      expect(bus.endpoint).toContain("servicebus.windows.net");
      expect(Redacted.value(bus.primaryConnectionString!)).toContain("sb://primary");
      expect(Redacted.value(bus.primaryKey!)).toBe("sb-primary-key");

      yield* stack.destroy();
      expect(called("serviceBusNamespaces.delete")).toBe(true);
    }),
  );

  test.provider("creates a Cosmos DB account with a connection string", (stack) =>
    Effect.gen(function* () {
      const cosmos = yield* stack.deploy(
        Azure.CosmosDBAccount("Db", { resourceGroup: "rg-test", location: "westeurope" }),
      );
      expect(cosmos.endpoint).toContain("documents.azure.com");
      expect(Redacted.value(cosmos.primaryKey!)).toBe("cosmos-primary-key");
      expect(Redacted.value(cosmos.connectionString!)).toContain("AccountKey=cosmos-primary-key");

      yield* stack.destroy();
      expect(called("cosmosAccounts.delete")).toBe(true);
    }),
  );

  test.provider("creates a SQL server and database", (stack) =>
    Effect.gen(function* () {
      const server = yield* stack.deploy(
        Azure.SqlServer("Sql", {
          resourceGroup: "rg-test",
          location: "westeurope",
          administratorLogin: "sqladmin",
          administratorLoginPassword: Redacted.make("P@ssw0rd!"),
        }),
      );
      expect(server.administratorLogin).toBe("sqladmin");
      expect(server.fullyQualifiedDomainName).toContain("database.windows.net");

      const database = yield* stack.deploy(
        Azure.SqlDatabase("Database", {
          resourceGroup: "rg-test",
          location: "westeurope",
          server: "my-sql-server",
          sku: "S0",
          tier: "Standard",
        }),
      );
      expect(database.serverName).toBe("my-sql-server");
      expect(database.sku).toBe("S0");

      yield* stack.destroy();
      expect(called("sqlServers.delete")).toBe(true);
      expect(called("sqlDatabases.delete")).toBe(true);
    }),
  );

  test.provider("updates a SQL server when the redacted admin password changes", (stack) =>
    Effect.gen(function* () {
      const props = {
        name: "sqlpasswordtest",
        resourceGroup: "rg-test",
        location: "westeurope",
        administratorLogin: "sqladmin",
      } satisfies Omit<Azure.SqlServerProps, "administratorLoginPassword">;

      yield* stack.deploy(
        Azure.SqlServer("Sql", {
          ...props,
          administratorLoginPassword: Redacted.make("P@ssw0rd1!"),
        }),
      );
      yield* stack.deploy(
        Azure.SqlServer("Sql", {
          ...props,
          administratorLoginPassword: Redacted.make("P@ssw0rd2!"),
        }),
      );

      expect(calls("sqlServers.put:sqlpasswordtest")).toHaveLength(2);
      expect(called("sqlServers.delete")).toBe(false);
    }),
  );

  test.provider("creates a Key Vault", (stack) =>
    Effect.gen(function* () {
      const vault = yield* stack.deploy(
        Azure.KeyVault("Kv", {
          resourceGroup: "rg-test",
          location: "westeurope",
          tenantId: "tenant-id",
          sku: "standard",
        }),
      );
      expect(vault.sku).toBe("standard");
      expect(vault.vaultUri).toContain("vault.azure.net");

      yield* stack.destroy();
      expect(called("keyVaults.delete")).toBe(true);
    }),
  );

  test.provider("replaces a Key Vault when tenant changes from omitted to explicit", (stack) =>
    Effect.gen(function* () {
      const props = {
        name: "tenant-kv",
        resourceGroup: "rg-test",
        location: "westeurope",
      } satisfies Azure.KeyVaultProps;

      yield* stack.deploy(Azure.KeyVault("Kv", props));
      yield* stack.deploy(Azure.KeyVault("Kv", { ...props, tenantId: "tenant-id" }));

      expect(called("keyVaults.delete")).toBe(true);
    }),
  );
});

describe("Compute + hosting providers", () => {
  test.provider("creates an App Service web app", (stack) =>
    Effect.gen(function* () {
      const app = yield* stack.deploy(
        Effect.gen(function* () {
          const plan = yield* Azure.AppServicePlan("Plan", {
            resourceGroup: "rg-test",
            location: "westeurope",
            sku: "B1",
          });
          return yield* Azure.AppService("Web", {
            resourceGroup: "rg-test",
            location: "westeurope",
            serverFarmId: plan,
            appSettings: { NODE_ENV: "production" },
          });
        }),
      );
      expect(app.url).toContain("azurewebsites.net");

      yield* stack.destroy();
      expect(called("appServicePlans.delete")).toBe(true);
      expect(called("webApps.delete")).toBe(true);
    }),
  );

  test.provider("creates a Function App", (stack) =>
    Effect.gen(function* () {
      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          const plan = yield* Azure.AppServicePlan("Plan", {
            resourceGroup: "rg-test",
            location: "westeurope",
            sku: "B1",
          });
          const storage = yield* Azure.StorageAccount("FnStorage", {
            name: "fnstorage001",
            resourceGroup: "rg-test",
            location: "westeurope",
          });
          return yield* Azure.FunctionApp("Fn", {
            resourceGroup: "rg-test",
            location: "westeurope",
            serverFarmId: plan,
            storageAccount: storage,
          });
        }),
      );
      expect(fn.url).toContain("azurewebsites.net");
    }),
  );

  test.provider("re-reads the storage connection string on Function App update", (stack) =>
    Effect.gen(function* () {
      // Regression: FunctionApp sets AzureWebJobsStorage from the storage
      // account's non-stable connection string. A whole-resource reference no
      // longer carries it on update (beta.58), so it must be re-read live from
      // the account's stable identity instead of throwing / dropping the setting.
      const program = (phase: string) =>
        Effect.gen(function* () {
          const plan = yield* Azure.AppServicePlan("Plan", {
            name: "fnplan001",
            resourceGroup: "rg-test",
            location: "westeurope",
            sku: "B1",
          });
          const storage = yield* Azure.StorageAccount("FnStorage", {
            name: "fnstorageupd01",
            resourceGroup: "rg-test",
            location: "westeurope",
          });
          return yield* Azure.FunctionApp("Fn", {
            name: "fn-conn-app",
            resourceGroup: "rg-test",
            location: "westeurope",
            serverFarmId: plan,
            storageAccount: storage,
            appSettings: { PHASE: phase },
          });
        });

      yield* stack.deploy(program("create"));
      yield* stack.deploy(program("update"));

      expect(calls("webApps.put:fn-conn-app")).toHaveLength(2);
      // In-place update, not replace: a referenced serverFarmId/storageAccount
      // must resolve to a stable scalar in the diff, not force a replace.
      expect(called("webApps.delete")).toBe(false);
      // listKeys must be called on update too, proving the live re-read.
      expect(calls("storageAccounts.listKeys:fnstorageupd01").length).toBeGreaterThanOrEqual(2);
    }),
  );

  test.provider("creates a Static Web App and applies app settings", (stack) =>
    Effect.gen(function* () {
      const swa = yield* stack.deploy(
        Azure.StaticWebApp("Swa", {
          resourceGroup: "rg-test",
          location: "westeurope",
          appSettings: { API_KEY: "value" },
        }),
      );
      expect(swa.url).toContain("azurestaticapps.net");
      expect(called("staticSites.appSettings")).toBe(true);

      yield* stack.destroy();
      expect(called("staticSites.delete")).toBe(true);
    }),
  );

  test.provider("creates a container instance with a public IP", (stack) =>
    Effect.gen(function* () {
      const instance = yield* stack.deploy(
        Azure.ContainerInstance("Ci", {
          resourceGroup: "rg-test",
          location: "westeurope",
          image: "nginx:latest",
        }),
      );
      expect(instance.fqdn).toContain("azurecontainer.io");
      expect(instance.ipAddress).toBe("20.1.2.3");

      yield* stack.destroy();
      expect(called("containerGroups.delete")).toBe(true);
    }),
  );

  test.provider("replaces a container instance when runtime shape changes", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Azure.ContainerInstance("Ci", {
          resourceGroup: "rg-test",
          location: "westeurope",
          image: "nginx:1",
        }),
      );
      yield* stack.deploy(
        Azure.ContainerInstance("Ci", {
          resourceGroup: "rg-test",
          location: "westeurope",
          image: "nginx:2",
        }),
      );

      expect(called("containerGroups.delete")).toBe(true);
    }),
  );

  test.provider("creates a virtual machine and its NIC", (stack) =>
    Effect.gen(function* () {
      const vm = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* Azure.VirtualNetwork("Net", {
            resourceGroup: "rg-test",
            location: "westeurope",
            addressSpace: ["10.42.0.0/16"],
            subnets: [{ name: "sip", addressPrefix: "10.42.1.0/24" }],
          });
          const publicIp = yield* Azure.PublicIPAddress("GatewayIp", {
            resourceGroup: "rg-test",
            location: "westeurope",
            sku: "Standard",
            allocationMethod: "Static",
            domainNameLabel: "gateway-test",
          });
          const nsg = yield* Azure.NetworkSecurityGroup("GatewayNsg", {
            resourceGroup: "rg-test",
            location: "westeurope",
            securityRules: [
              {
                name: "allow-sip-udp",
                priority: 100,
                direction: "Inbound",
                access: "Allow",
                protocol: "Udp",
                destinationPortRange: "5060",
              },
            ],
          });
          return yield* Azure.VirtualMachine("Vm", {
            resourceGroup: "rg-test",
            location: "westeurope",
            adminUsername: "azureuser",
            adminPassword: Redacted.make("S3cret-pass!"),
            subnetId: Azure.subnetId(network, "sip"),
            publicIPAddress: publicIp,
            networkSecurityGroup: nsg,
            enableIPForwarding: true,
            customData: "#cloud-config\npackages:\n  - docker.io\n",
          });
        }),
      );
      expect(vm.vmId).toBeDefined();
      expect(vm.networkInterfaceId).toContain("/networkInterfaces/");
      expect(vm.privateIpAddress).toBe("10.0.0.4");
      expect(vm.publicIpAddress).toBe("20.0.0.1");
      expect(vm.publicFqdn).toBe("gateway-test.westeurope.cloudapp.azure.com");
      expect(called("networkInterfaces.put")).toBe(true);
      const nic = mock.records.get(recordKey("networkInterfaces", "rg-test", `${vm.name}-nic`))!;
      expect(nic.enableIPForwarding).toBe(true);
      expect((nic.networkSecurityGroup as { id: string }).id).toContain("/networkSecurityGroups/");
      const ipConfig = (nic.ipConfigurations as Array<{ publicIPAddress?: { id: string } }>)[0];
      expect(ipConfig?.publicIPAddress?.id).toContain("/publicIPAddresses/");
      const vmRecord = mock.records.get(recordKey("virtualMachines", "rg-test", vm.name))!;
      const osProfile = vmRecord.osProfile as { customData?: string };
      expect(Buffer.from(osProfile.customData!, "base64").toString("utf8")).toContain("docker.io");

      yield* stack.destroy();
      expect(called("virtualMachines.delete")).toBe(true);
      expect(called("networkInterfaces.delete")).toBe(true);
    }),
  );

  test.provider("replaces a virtual machine when the redacted admin password changes", (stack) =>
    Effect.gen(function* () {
      const props = {
        resourceGroup: "rg-test",
        location: "westeurope",
        adminUsername: "azureuser",
        subnetId:
          "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.Network/virtualNetworks/vnet/subnets/default",
      } satisfies Omit<Azure.VirtualMachineProps, "adminPassword">;

      yield* stack.deploy(Azure.VirtualMachine("Vm", { ...props, adminPassword: Redacted.make("S3cret-one!") }));
      yield* stack.deploy(Azure.VirtualMachine("Vm", { ...props, adminPassword: Redacted.make("S3cret-two!") }));

      expect(called("virtualMachines.delete")).toBe(true);
    }),
  );

  test.provider("rejects a virtual machine without a subnet", (stack) =>
    expectDeployToFail(
      stack,
      Azure.VirtualMachine("Vm", {
        resourceGroup: "rg-test",
        location: "westeurope",
        adminUsername: "azureuser",
      }),
    ).pipe(Effect.map((cause) => expect(cause).toContain("requires subnetId"))),
  );
});

describe("Container Apps providers", () => {
  test.provider("registers a resource provider namespace", (stack) =>
    Effect.gen(function* () {
      const registration = yield* stack.deploy(
        Azure.ResourceProviderRegistration("MicrosoftApp", {
          namespace: "Microsoft.App",
          pollIntervalSeconds: 0,
        }),
      );

      expect(registration.namespace).toBe("Microsoft.App");
      expect(registration.registrationState).toBe("Registered");
      expect(called("resourceProviders.register:Microsoft.App")).toBe(true);

      yield* stack.destroy();
      expect(called("resourceProviders.unregister:Microsoft.App")).toBe(false);
    }),
  );

  test.provider("waits for provider registration before creating a managed environment", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const registration = yield* Azure.ResourceProviderRegistration("MicrosoftApp", {
            namespace: "Microsoft.App",
            pollIntervalSeconds: 0,
          });
          return yield* Azure.ContainerAppEnvironment("Env", {
            resourceGroup: "rg-test",
            location: "westeurope",
            providerRegistration: registration,
          });
        }),
      );

      const registrationIndex = mock.calls.indexOf("resourceProviders.register:Microsoft.App");
      const environmentCreateIndex = mock.calls.findIndex((call) =>
        call.startsWith("managedEnvironments.put:"),
      );
      expect(registrationIndex).toBeGreaterThanOrEqual(0);
      expect(environmentCreateIndex).toBeGreaterThanOrEqual(0);
      expect(registrationIndex).toBeLessThan(environmentCreateIndex);
      expect(called("managedEnvironments.put")).toBe(true);
    }),
  );

  test.provider("creates a container registry with admin credentials", (stack) =>
    Effect.gen(function* () {
      const registry = yield* stack.deploy(
        Azure.ContainerRegistry("Registry", {
          resourceGroup: "rg-test",
          location: "westeurope",
          sku: "Standard",
        }),
      );
      expect(registry.loginServer).toContain("azurecr.io");
      expect(registry.sku).toBe("Standard");
      expect(registry.username).toBe("registryadmin");
      expect(Redacted.value(registry.password!)).toBe("registry-password");

      yield* stack.destroy();
      expect(called("registries.delete")).toBe(true);
    }),
  );

  test.provider("rejects an invalid container registry name", (stack) =>
    expectDeployToFail(
      stack,
      Azure.ContainerRegistry("Registry", {
        name: "Bad-Name",
        resourceGroup: "rg-test",
        location: "westeurope",
      }),
    ).pipe(Effect.map((cause) => expect(cause).toContain("is invalid"))),
  );

  test.provider("creates a container apps managed environment", (stack) =>
    Effect.gen(function* () {
      const environment = yield* stack.deploy(
        Azure.ContainerAppEnvironment("Env", {
          resourceGroup: "rg-test",
          location: "westeurope",
        }),
      );
      expect(environment.defaultDomain).toContain("azurecontainerapps.io");
      expect(environment.staticIp).toBe("20.4.5.6");

      yield* stack.destroy();
      expect(called("managedEnvironments.delete")).toBe(true);
    }),
  );

  test.provider("creates a container app", (stack) =>
    Effect.gen(function* () {
      const app = yield* stack.deploy(
        Azure.ContainerApp("App", {
          resourceGroup: "rg-test",
          location: "westeurope",
          environment: "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env",
          image: "ghcr.io/acme/api:latest",
          targetPort: 8080,
          buildHash: "abcdef123456",
        }),
      );

      expect(app.image).toBe("ghcr.io/acme/api:latest");
      expect(app.targetPort).toBe(8080);
      expect(app.buildHash).toBe("abcdef123456");

      yield* stack.destroy();
      expect(called("containerApps.delete")).toBe(true);
    }),
  );

  test.provider("updates a container app when runtime settings change", (stack) =>
    Effect.gen(function* () {
      const base = {
        name: "runtime-app",
        resourceGroup: "rg-test",
        location: "westeurope",
        environment: "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env",
        image: "ghcr.io/acme/api:latest",
        targetPort: 8080,
      } satisfies Azure.ContainerAppProps;

      yield* stack.deploy(Azure.ContainerApp("App", { ...base, env: { PHASE: "create" } }));
      yield* stack.deploy(Azure.ContainerApp("App", { ...base, env: { PHASE: "update" } }));

      expect(calls("containerApps.put:runtime-app")).toHaveLength(2);
    }),
  );

  test.provider("re-reads registry credentials on update for a referenced registry", (stack) =>
    Effect.gen(function* () {
      // Regression for issue #2.2: a whole-resource registry reference no longer
      // carries non-stable `username`/`password` on update. The Container App
      // must re-read admin credentials live (listCredentials) so the image pull
      // secret survives updates instead of silently dropping to no-auth.
      const program = (phase: string) =>
        Effect.gen(function* () {
          const registry = yield* Azure.ContainerRegistry("Registry", {
            name: "appregistry01",
            resourceGroup: "rg-test",
            location: "westeurope",
          });
          return yield* Azure.ContainerApp("App", {
            name: "registry-app",
            resourceGroup: "rg-test",
            location: "westeurope",
            environment:
              "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env",
            image: "appregistry01.azurecr.io/api:latest",
            registry,
            targetPort: 8080,
            env: { PHASE: phase },
          });
        });

      yield* stack.deploy(program("create"));
      yield* stack.deploy(program("update"));

      const record = mock.records.get(recordKey("containerApps", "rg-test", "registry-app"))!;
      const configuration = record.configuration as {
        secrets?: Array<{ name: string; value: string }>;
        registries?: Array<{ server: string; username: string; passwordSecretRef: string }>;
      };
      expect(calls("containerApps.put:registry-app")).toHaveLength(2);
      // Pull secret + registry auth present after the update — only possible if
      // credentials were re-read live rather than taken from the reference.
      expect(configuration.secrets).toContainEqual({ name: "registry-password", value: "registry-password" });
      expect(configuration.registries?.[0]?.username).toBe("registryadmin");
      expect(configuration.registries?.[0]?.server).toBe("appregistry01.azurecr.io");
      expect(calls("registries.listCredentials:appregistry01").length).toBeGreaterThanOrEqual(2);
    }),
  );

  test.provider("updates a container app when redacted env changes", (stack) =>
    Effect.gen(function* () {
      const base = {
        name: "secret-app",
        resourceGroup: "rg-test",
        location: "westeurope",
        environment: "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/env",
        image: "ghcr.io/acme/api:latest",
        targetPort: 8080,
      } satisfies Azure.ContainerAppProps;

      yield* stack.deploy(Azure.ContainerApp("App", { ...base, env: { SECRET: Redacted.make("one") } }));
      yield* stack.deploy(Azure.ContainerApp("App", { ...base, env: { SECRET: Redacted.make("two") } }));

      const record = mock.records.get(recordKey("containerApps", "rg-test", "secret-app"))!;
      const configuration = record.configuration as { secrets?: Array<{ name: string; value: string }> };
      const template = record.template as { containers: Array<{ env: Array<{ name: string; secretRef: string }> }> };
      expect(calls("containerApps.put:secret-app")).toHaveLength(2);
      expect(configuration.secrets).toContainEqual({ name: "env-secret-1jrly4", value: "two" });
      expect(template.containers[0]?.env).toContainEqual({ name: "SECRET", secretRef: "env-secret-1jrly4" });
    }),
  );
});

describe("provider list stubs", () => {
  test.provider("list methods enumerate only owned Azure resources", () =>
    Effect.gen(function* () {
      seedListFixtures();

      const listed = {
        resourceGroups: yield* listFrom(Azure.ResourceGroup.Provider),
        storageAccounts: yield* listFrom(Azure.StorageAccount.Provider),
        blobContainers: yield* listFrom(Azure.BlobContainer.Provider),
        identities: yield* listFrom(Azure.UserAssignedIdentity.Provider),
        virtualNetworks: yield* listFrom(Azure.VirtualNetwork.Provider),
        networkSecurityGroups: yield* listFrom(Azure.NetworkSecurityGroup.Provider),
        publicIps: yield* listFrom(Azure.PublicIPAddress.Provider),
        cognitiveAccounts: yield* listFrom(Azure.CognitiveServices.Provider),
        serviceBusNamespaces: yield* listFrom(Azure.ServiceBus.Provider),
        cosmosAccounts: yield* listFrom(Azure.CosmosDBAccount.Provider),
        sqlServers: yield* listFrom(Azure.SqlServer.Provider),
        sqlDatabases: yield* listFrom(Azure.SqlDatabase.Provider),
        keyVaults: yield* listFrom(Azure.KeyVault.Provider),
        appServicePlans: yield* listFrom(Azure.AppServicePlan.Provider),
        appServices: yield* listFrom(Azure.AppService.Provider),
        functionApps: yield* listFrom(Azure.FunctionApp.Provider),
        staticSites: yield* listFrom(Azure.StaticWebApp.Provider),
        containerGroups: yield* listFrom(Azure.ContainerInstance.Provider),
        providerRegistrations: yield* listFrom(Azure.ResourceProviderRegistration.Provider),
        managedEnvironments: yield* listFrom(Azure.ContainerAppEnvironment.Provider),
        registries: yield* listFrom(Azure.ContainerRegistry.Provider),
        containerApps: yield* listFrom(Azure.ContainerApp.Provider),
        virtualMachines: yield* listFrom(Azure.VirtualMachine.Provider),
        containerImages: yield* listFrom(Azure.ContainerImage.Provider),
      };

      expect(names(listed.resourceGroups)).toEqual(["rg-owned"]);
      expect(names(listed.storageAccounts)).toEqual(["ownedstore001"]);
      expect(names(listed.blobContainers)).toEqual(["uploads"]);
      expect(names(listed.identities)).toEqual(["owned-identity"]);
      expect(names(listed.virtualNetworks)).toEqual(["owned-vnet"]);
      expect(names(listed.networkSecurityGroups)).toEqual(["owned-nsg"]);
      expect(names(listed.publicIps)).toEqual(["owned-ip"]);
      expect(names(listed.cognitiveAccounts)).toEqual(["owned-ai"]);
      expect(names(listed.serviceBusNamespaces)).toEqual(["owned-bus"]);
      expect(names(listed.cosmosAccounts)).toEqual(["owned-cosmos"]);
      expect(names(listed.sqlServers)).toEqual(["owned-sql"]);
      expect(names(listed.sqlDatabases)).toEqual(["owned-db"]);
      expect(names(listed.keyVaults)).toEqual(["owned-kv"]);
      expect(names(listed.appServicePlans)).toEqual(["owned-plan"]);
      expect(names(listed.appServices)).toEqual(["owned-web"]);
      expect(names(listed.functionApps)).toEqual(["owned-fn"]);
      expect(names(listed.staticSites)).toEqual(["owned-swa"]);
      expect(names(listed.containerGroups)).toEqual(["owned-ci"]);
      expect(listed.providerRegistrations.map((item) => item.namespace).sort()).toEqual([
        "Microsoft.App",
      ]);
      expect(names(listed.managedEnvironments)).toEqual(["owned-env"]);
      expect(names(listed.registries)).toEqual(["ownedregistry"]);
      expect(names(listed.containerApps)).toEqual(["owned-app"]);
      expect(names(listed.virtualMachines)).toEqual(["owned-vm"]);
      expect(listed.containerImages).toEqual([]);

      expect(called("resourceGroups.list:*")).toBe(true);
      expect(called("sqlDatabases.list:rg-list/external-sql")).toBe(true);
    }),
  );
});

function listFrom<A>(
  service: Effect.Effect<{ list: () => Effect.Effect<ReadonlyArray<A>, unknown, never> }, unknown, unknown>,
) {
  return service.pipe(
    Effect.provide(directProviderLayer),
    Effect.flatMap((provider) => provider.list()),
  );
}

function names(items: ReadonlyArray<{ name: string }>) {
  return items.map((item) => item.name).sort();
}

function owned(logicalId: string, tags: Record<string, string> = {}) {
  return { ...tags, "alchemy:logical-id": logicalId };
}

function seedListFixtures() {
  mock.seed(recordKey("resourceGroups", "", "rg-list"), {
    name: "rg-list",
    id: "/subscriptions/test/resourceGroups/rg-list",
    location: "westeurope",
  });
  mock.seed(recordKey("resourceGroups", "", "rg-owned"), {
    name: "rg-owned",
    id: "/subscriptions/test/resourceGroups/rg-owned",
    location: "westeurope",
    tags: owned("Group"),
  });

  mock.seedKind("storageAccounts", "rg-list", {
    name: "storageparent",
    location: "westeurope",
    primaryEndpoints: { blob: "https://storageparent.blob.core.windows.net/" },
  });
  mock.seedKind("storageAccounts", "rg-list", {
    name: "ownedstore001",
    location: "westeurope",
    primaryEndpoints: { blob: "https://ownedstore001.blob.core.windows.net/" },
    tags: owned("Store"),
  });
  mock.seedKind("storageAccounts", "rg-list", {
    name: "ignoredstore001",
    location: "westeurope",
    primaryEndpoints: { blob: "https://ignoredstore001.blob.core.windows.net/" },
  });
  mock.seedKind("blobContainers", "rg-list/storageparent", {
    name: "uploads",
    metadata: { alchemyLogicalId: "Uploads" },
    publicAccess: "Blob",
  });
  mock.seedKind("blobContainers", "rg-list/storageparent", {
    name: "ignored-uploads",
    metadata: {},
  });

  mock.seedKind("userAssignedIdentities", "rg-list", {
    name: "owned-identity",
    location: "westeurope",
    principalId: "principal-id",
    clientId: "client-id",
    tenantId: "tenant-id",
    tags: owned("Id"),
  });
  mock.seedKind("virtualNetworks", "rg-list", {
    name: "owned-vnet",
    location: "westeurope",
    addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
    subnets: [{ name: "default", addressPrefix: "10.0.0.0/24" }],
    tags: owned("Net"),
  });
  mock.seedKind("networkSecurityGroups", "rg-list", {
    name: "owned-nsg",
    location: "westeurope",
    securityRules: [],
    tags: owned("Nsg"),
  });
  mock.seedKind("publicIPAddresses", "rg-list", {
    name: "owned-ip",
    location: "westeurope",
    ipAddress: "20.0.0.1",
    tags: owned("Ip"),
  });
  mock.seedKind("cognitiveAccounts", "rg-list", {
    name: "owned-ai",
    location: "westeurope",
    kind: "OpenAI",
    sku: { name: "S0" },
    properties: { endpoint: "https://owned-ai.cognitiveservices.azure.com/" },
    tags: owned("Ai"),
  });
  mock.seedKind("serviceBusNamespaces", "rg-list", {
    name: "owned-bus",
    location: "westeurope",
    sku: { name: "Standard" },
    serviceBusEndpoint: "https://owned-bus.servicebus.windows.net/",
    tags: owned("Bus"),
  });
  mock.seedKind("cosmosAccounts", "rg-list", {
    name: "owned-cosmos",
    location: "westeurope",
    documentEndpoint: "https://owned-cosmos.documents.azure.com:443/",
    tags: owned("Db"),
  });
  mock.seedKind("sqlServers", "rg-list", {
    name: "owned-sql",
    location: "westeurope",
    administratorLogin: "sqladmin",
    fullyQualifiedDomainName: "owned-sql.database.windows.net",
    tags: owned("Sql"),
  });
  mock.seedKind("sqlServers", "rg-list", {
    name: "external-sql",
    location: "westeurope",
    administratorLogin: "sqladmin",
    fullyQualifiedDomainName: "external-sql.database.windows.net",
  });
  mock.seedKind("sqlDatabases", "rg-list/external-sql", {
    name: "owned-db",
    location: "westeurope",
    sku: { name: "S0" },
    tags: owned("Database"),
  });
  mock.seedKind("keyVaults", "rg-list", {
    name: "owned-kv",
    location: "westeurope",
    properties: { vaultUri: "https://owned-kv.vault.azure.net/" },
    tags: owned("Kv"),
  });
  mock.seedKind("appServicePlans", "rg-list", {
    name: "owned-plan",
    location: "westeurope",
    sku: { name: "B1", tier: "Basic", capacity: 1 },
    tags: owned("Plan"),
  });
  mock.seedKind("webApps", "rg-list", {
    name: "owned-web",
    location: "westeurope",
    kind: "app",
    defaultHostName: "owned-web.azurewebsites.net",
    tags: owned("Web"),
  });
  mock.seedKind("webApps", "rg-list", {
    name: "owned-fn",
    location: "westeurope",
    kind: "functionapp,linux",
    defaultHostName: "owned-fn.azurewebsites.net",
    tags: owned("Fn"),
  });
  mock.seedKind("staticSites", "rg-list", {
    name: "owned-swa",
    location: "westeurope",
    defaultHostname: "owned-swa.azurestaticapps.net",
    tags: owned("Swa"),
  });
  mock.seedKind("containerGroups", "rg-list", {
    name: "owned-ci",
    location: "westeurope",
    ipAddress: { fqdn: "owned-ci.westeurope.azurecontainer.io", ip: "20.1.2.3" },
    tags: owned("Ci"),
  });
  mock.seed(recordKey("resourceProviders", "", "Microsoft.App"), {
    name: "Microsoft.App",
    id: "/subscriptions/test/providers/Microsoft.App",
    namespace: "Microsoft.App",
    registrationState: "Registered",
  });
  mock.seedKind("managedEnvironments", "rg-list", {
    name: "owned-env",
    location: "westeurope",
    defaultDomain: "owned-env.westeurope.azurecontainerapps.io",
    staticIp: "20.4.5.6",
    tags: owned("Env"),
  });
  mock.seedKind("registries", "rg-list", {
    name: "ownedregistry",
    location: "westeurope",
    loginServer: "ownedregistry.azurecr.io",
    adminUserEnabled: true,
    sku: { name: "Basic" },
    tags: owned("Registry"),
  });
  mock.seedKind("containerApps", "rg-list", {
    name: "owned-app",
    location: "westeurope",
    environmentId: "/subscriptions/test/resourceGroups/rg-list/providers/Microsoft.App/managedEnvironments/owned-env",
    template: { containers: [{ name: "app", image: "ghcr.io/acme/api:latest" }] },
    configuration: { ingress: { targetPort: 8080, fqdn: "owned-app.example.test" } },
    tags: owned("App", { "alchemy:build-hash": "abcdef123456" }),
  });
  mock.seedKind("virtualMachines", "rg-list", {
    name: "owned-vm",
    location: "westeurope",
    vmId: "11111111-2222-3333-4444-555555555555",
    tags: owned("Vm"),
  });
}
