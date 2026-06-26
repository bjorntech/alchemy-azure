import { WebSiteManagementClient } from "@azure/arm-appservice";
import type { TokenCredential } from "@azure/identity";
import { ContainerAppsAPIClient } from "@azure/arm-appcontainers";
import { ContainerRegistryManagementClient } from "@azure/arm-containerregistry";
import { CognitiveServicesManagementClient } from "@azure/arm-cognitiveservices";
import { ComputeManagementClient } from "@azure/arm-compute";
import { ContainerInstanceManagementClient } from "@azure/arm-containerinstance";
import { CosmosDBManagementClient } from "@azure/arm-cosmosdb";
import { KeyVaultManagementClient } from "@azure/arm-keyvault";
import { ManagedServiceIdentityClient } from "@azure/arm-msi";
import { NetworkManagementClient } from "@azure/arm-network";
import { ResourceManagementClient } from "@azure/arm-resources";
import { ServiceBusManagementClient } from "@azure/arm-servicebus";
import { SqlManagementClient } from "@azure/arm-sql";
import { StorageManagementClient } from "@azure/arm-storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ServiceClientCredentials } from "@azure/ms-rest-js";
import { AzureCredentials } from "./Credentials.ts";

export interface AzureClientsShape {
  resources: ResourceManagementClient;
  storage: StorageManagementClient;
  msi: ManagedServiceIdentityClient;
  appService: WebSiteManagementClient;
  cosmosDB: CosmosDBManagementClient;
  sql: SqlManagementClient;
  network: NetworkManagementClient;
  containerInstance: ContainerInstanceManagementClient;
  compute: ComputeManagementClient;
  keyVault: KeyVaultManagementClient;
  serviceBus: ServiceBusManagementClient;
  cognitiveServices: CognitiveServicesManagementClient;
  appContainers: ContainerAppsAPIClient;
  containerRegistry: ContainerRegistryManagementClient;
  subscriptionId: string;
  tenantId?: string;
}

/**
 * Injectable Azure SDK client bundle. Provider lifecycle effects depend on this
 * service rather than constructing clients directly, so tests can supply a
 * fake implementation via {@link AzureClients} without touching the network.
 */
export class AzureClients extends Context.Service<AzureClients, AzureClientsShape>()(
  "Azure.Clients",
) {}

/**
 * Yield the Azure client bundle from context. Kept as a named export so every
 * provider reads clients the same way (`const clients = yield* makeAzureClients`).
 */
export const makeAzureClients = AzureClients;

/** Build the real Azure SDK clients from resolved {@link AzureCredentials}. */
export const buildAzureClients = (credentials: {
  credential: TokenCredential;
  subscriptionId: string;
  tenantId?: string;
}): AzureClientsShape => {
  const { credential, subscriptionId, tenantId } = credentials;
  const serviceClientCredentials = toServiceClientCredentials(credential);
  return {
    resources: new ResourceManagementClient(credential, subscriptionId),
    storage: new StorageManagementClient(credential, subscriptionId),
    msi: new ManagedServiceIdentityClient(credential, subscriptionId),
    appService: new WebSiteManagementClient(credential, subscriptionId),
    cosmosDB: new CosmosDBManagementClient(serviceClientCredentials, subscriptionId),
    sql: new SqlManagementClient(credential, subscriptionId),
    network: new NetworkManagementClient(credential, subscriptionId),
    containerInstance: new ContainerInstanceManagementClient(credential, subscriptionId),
    compute: new ComputeManagementClient(credential, subscriptionId),
    keyVault: new KeyVaultManagementClient(credential, subscriptionId),
    serviceBus: new ServiceBusManagementClient(credential, subscriptionId),
    cognitiveServices: new CognitiveServicesManagementClient(credential, subscriptionId),
    appContainers: new ContainerAppsAPIClient(credential, subscriptionId),
    containerRegistry: new ContainerRegistryManagementClient(credential, subscriptionId),
    subscriptionId,
    tenantId,
  } satisfies AzureClientsShape;
};

/** Live layer that constructs Azure SDK clients from {@link AzureCredentials}. */
export const AzureClientsLive = Layer.effect(
  AzureClients,
  Effect.gen(function* () {
    const credentials = yield* AzureCredentials;
    const tenantId = credentials.tenantId ?? (yield* resolveTenantId(credentials.credential));
    return buildAzureClients({ ...credentials, tenantId });
  }),
);

const resolveTenantId = (credential: TokenCredential) =>
  Effect.tryPromise(async () => {
    const token = await credential.getToken("https://management.azure.com/.default");
    if (!token) return undefined;
    const [, payload] = token.token.split(".");
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(base64UrlToBase64(payload), "base64").toString("utf8")) as {
      tid?: string;
    };
    return decoded.tid;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

function base64UrlToBase64(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
}

export function toServiceClientCredentials(credential: TokenCredential): ServiceClientCredentials {
  return {
    signRequest: async (webResource) => {
      const token = await credential.getToken("https://management.azure.com/.default");
      if (!token) {
        throw new Error("Failed to acquire Azure management token");
      }
      webResource.headers.set("Authorization", `Bearer ${token.token}`);
      return webResource;
    },
  };
}
