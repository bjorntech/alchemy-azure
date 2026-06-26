import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { destroy } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Azure from "../src/index.ts";

const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
const location = process.env.AZURE_SMOKE_LOCATION ?? "westeurope";
const replacementLocation = process.env.AZURE_SMOKE_REPLACE_LOCATION ?? location;
const prefix = process.env.AZURE_SMOKE_PREFIX ?? "alchemy-azure-smoke";
const phase = process.env.AZURE_SMOKE_PHASE === "create"
  ? "create"
  : process.env.AZURE_SMOKE_PHASE === "replace"
    ? "replace"
    : process.env.AZURE_SMOKE_PHASE === "settle"
      ? "settle"
      : "update";
const updated = phase !== "create";
const replaced = phase === "replace" || phase === "settle";
const full = process.env.AZURE_SMOKE_FULL === "1";
const buildImage = process.env.AZURE_SMOKE_BUILD_IMAGE === "1";
const includeCognitive = full || process.env.AZURE_SMOKE_COGNITIVE === "1";
const includeCosmos = full || process.env.AZURE_SMOKE_COSMOS === "1";
const includeSql = full || process.env.AZURE_SMOKE_SQL === "1";
const includeVm = full || process.env.AZURE_SMOKE_VM === "1";
const includeStaticWebApp = full || process.env.AZURE_SMOKE_STATIC_WEB_APP === "1";
const activeLocation = replaced ? replacementLocation : location;

const slug = azureSlug(prefix, 36);
const compact = compactName(prefix, 18);
const smokePassword = process.env.AZURE_SMOKE_PASSWORD ?? `Az9!Smoke#${hashString(prefix)}`;
const tags = {
  purpose: "alchemy-azure-smoke-test",
  phase,
  run: slug,
};

export const resourceGroupName = `${slug}-rg`;
export const containerAppName = azureSlug(`${slug}-app`, 32);

export default Alchemy.Stack(
  "alchemy-azure-production-smoke",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    if (!subscriptionId) throw new Error("AZURE_SUBSCRIPTION_ID is required");

    const group = yield* Azure.ResourceGroup("Group", {
      name: resourceGroupName,
      location: activeLocation,
      tags,
    });

    const appProvider = yield* Azure.ResourceProviderRegistration("MicrosoftAppProvider", {
      namespace: "Microsoft.App",
    });

    const storage = yield* Azure.StorageAccount("Storage", {
      name: `${compact}st01`.slice(0, 24),
      resourceGroup: group,
      sku: "Standard_LRS",
      allowBlobPublicAccess: true,
      tags,
    });

    const uploads = yield* Azure.BlobContainer("Uploads", {
      name: "uploads",
      storageAccount: storage,
      publicAccess: updated ? "Container" : "Blob",
      metadata: { purpose: "alchemy-azure-smoke", phase, run: slug },
    });

    const identity = yield* Azure.UserAssignedIdentity("Identity", {
      name: replaced ? `${slug}-identity-repl` : `${slug}-identity`,
      resourceGroup: group,
      tags,
    });

    const vnet = yield* Azure.VirtualNetwork("Network", {
      name: `${slug}-vnet`,
      resourceGroup: group,
      addressSpace: ["10.41.0.0/16"],
      subnets: [{ name: "default", addressPrefix: "10.41.1.0/24" }],
      tags,
    });

    const nsg = yield* Azure.NetworkSecurityGroup("Nsg", {
      name: `${slug}-nsg`,
      resourceGroup: group,
      securityRules: [
        {
          name: updated ? "allow-http" : "allow-https",
          priority: 100,
          direction: "Inbound",
          access: "Allow",
          protocol: "Tcp",
          destinationPortRange: updated ? "80" : "443",
        },
      ],
      tags,
    });

    const publicIp = yield* Azure.PublicIPAddress("PublicIp", {
      name: replaced ? `${slug}-ip-repl` : `${slug}-ip`,
      resourceGroup: group,
      sku: "Standard",
      tags,
    });

    const serviceBus = yield* Azure.ServiceBus("ServiceBus", {
      name: `${compact}bus`.slice(0, 50),
      resourceGroup: group,
      sku: "Standard",
      tags,
    });

    const keyVault = yield* Azure.KeyVault("KeyVault", {
      name: `${compact}kv`.slice(0, 24),
      resourceGroup: group,
      enableRbacAuthorization: true,
      tags,
    });

    const registry = yield* Azure.ContainerRegistry("Registry", {
      name: `${compact}acr`.slice(0, 50),
      resourceGroup: group,
      sku: updated ? "Standard" : "Basic",
      tags,
    });

    const image = buildImage
      ? yield* Azure.ContainerImage("Image", {
          registry,
          context: "scripts/smoke-container",
          repository: "nginx-smoke",
          tag: updated ? "updated" : "create",
          buildHash: phase,
        })
      : undefined;

    const environment = yield* Azure.ContainerAppEnvironment("Environment", {
      name: azureSlug(`${slug}-env`, 32),
      resourceGroup: group,
      providerRegistration: appProvider,
      tags,
    });

    const app = yield* Azure.ContainerApp("App", {
      name: containerAppName,
      resourceGroup: group,
      environment,
      image: image ?? "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest",
      providerRegistration: appProvider,
      registry: image ? registry : undefined,
      targetPort: 80,
      buildHash: phase,
      env: { ALCHEMY_AZURE_SMOKE_PHASE: phase },
      minReplicas: 0,
      maxReplicas: 1,
      tags,
    });

    const cognitive = includeCognitive
      ? yield* Azure.CognitiveServices("Cognitive", {
          name: `${compact}ai`.slice(0, 64),
          resourceGroup: group,
          kind: process.env.AZURE_SMOKE_COGNITIVE_KIND ?? "CognitiveServices",
          sku: process.env.AZURE_SMOKE_COGNITIVE_SKU ?? "S0",
          customSubDomain: `${compact}ai`.slice(0, 64),
          tags,
        }).pipe(destroy())
      : undefined;

    const cosmos = includeCosmos
      ? yield* Azure.CosmosDBAccount("Cosmos", {
          name: `${compact}cosmos`.slice(0, 44),
          resourceGroup: group,
          enableFreeTier: process.env.AZURE_SMOKE_COSMOS_FREE_TIER === "1",
          tags,
        }).pipe(destroy())
      : undefined;

    const sqlServer = includeSql
      ? yield* Azure.SqlServer("SqlServer", {
          name: `${compact}sql`.slice(0, 63),
          resourceGroup: group,
          administratorLogin: "alchemy",
          administratorLoginPassword: Redacted.make(smokePassword),
          tags,
        }).pipe(destroy())
      : undefined;

    const sqlDatabase = sqlServer
      ? yield* Azure.SqlDatabase("SqlDatabase", {
          name: `${slug}-db`,
          resourceGroup: group,
          server: sqlServer,
          sku: "Basic",
          tags,
        }).pipe(destroy())
      : undefined;

    const appServicePlan = yield* Azure.AppServicePlan("AppServicePlan", {
      name: `${compact}plan`.slice(0, 40),
      resourceGroup: group,
      sku: "B1",
      tags,
    });

    const appService = yield* Azure.AppService("WebApp", {
      name: `${slug}-web`,
      resourceGroup: group,
      serverFarmId: appServicePlan,
      appSettings: { ALCHEMY_AZURE_SMOKE_PHASE: phase },
      tags,
    }).pipe(destroy());

    const functionApp = yield* Azure.FunctionApp("FunctionApp", {
      name: `${slug}-fn`,
      resourceGroup: group,
      serverFarmId: appServicePlan,
      storageAccount: storage,
      appSettings: { ALCHEMY_AZURE_SMOKE_PHASE: phase },
      tags,
    }).pipe(destroy());

    const staticWebApp = includeStaticWebApp
      ? yield* Azure.StaticWebApp("StaticWebApp", {
          name: `${slug}-swa`,
          resourceGroup: group,
          sku: "Free",
          appSettings: { ALCHEMY_AZURE_SMOKE_PHASE: phase },
          tags,
        }).pipe(destroy())
      : undefined;

    const containerInstance = yield* Azure.ContainerInstance("ContainerInstance", {
      name: `${slug}-ci`,
      resourceGroup: group,
      image: "mcr.microsoft.com/azuredocs/aci-helloworld:latest",
      ports: [{ port: 80 }],
      tags,
    });

    const vm = includeVm
      ? yield* Azure.VirtualMachine("Vm", {
          name: `${slug}-vm`,
          resourceGroup: group,
          adminUsername: "azureuser",
          adminPassword: Redacted.make(smokePassword),
          subnetId: Output.interpolate`/subscriptions/${subscriptionId}/resourceGroups/${group.name}/providers/Microsoft.Network/virtualNetworks/${vnet.name}/subnets/default`,
          tags,
        }).pipe(destroy())
      : undefined;

    return {
      phase,
      resourceGroupName: group.name,
      storageAccountName: storage.name,
      blobContainerUrl: uploads.url,
      identityClientId: identity.clientId,
      vnetName: vnet.name,
      networkSecurityGroupName: nsg.name,
      publicIpAddress: publicIp.ipAddress,
      serviceBusEndpoint: serviceBus.endpoint,
      keyVaultUri: keyVault.vaultUri,
      registryLoginServer: registry.loginServer,
      image: image?.image,
      containerAppName: app.name,
      containerAppUrl: app.url,
      cognitiveEndpoint: cognitive?.endpoint,
      cosmosEndpoint: cosmos?.endpoint,
      sqlServer: sqlServer?.fullyQualifiedDomainName,
      sqlDatabase: sqlDatabase?.name,
      appServiceUrl: appService.url,
      functionAppUrl: functionApp.url,
      staticWebAppUrl: staticWebApp?.url,
      containerInstanceFqdn: containerInstance.fqdn,
      vmId: vm?.vmId,
    };
  }),
);

function azureSlug(value: string, maxLength: number) {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const normalized = /^[a-z]/.test(slug) ? slug : `az-${slug}`;
  return (normalized || "az-smoke").slice(0, maxLength).replace(/-+$/g, "") || "az-smoke";
}

function compactName(value: string, maxLength: number) {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalized = /^[a-z]/.test(compact) ? compact : `az${compact}`;
  if (normalized.length <= maxLength) return normalized || "azsmoke";
  const suffixLength = Math.min(8, maxLength - 2);
  const prefixLength = maxLength - suffixLength;
  return `${normalized.slice(0, prefixLength)}${normalized.slice(-suffixLength)}`;
}

function hashString(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}
