# alchemy-azure

Microsoft Azure providers for [Alchemy v2](https://v2.alchemy.run/).

This package follows Alchemy's official custom-provider model: resources are declared with `Resource`, lifecycle implementations are registered with `Provider.effect`, credentials resolve through an `AuthProvider`, and all Azure providers are exposed as a single `Azure.providers()` layer.

## Compatibility

`@bjorntech/alchemy-azure` tracks the `alchemy` v2 beta line. The trailing number in our beta releases mirrors the `alchemy` beta we were tested against.

| `@bjorntech/alchemy-azure` | `alchemy` (peer) | `effect` (peer) | Notes |
| --------------- | ---------------- | --------------- | ----- |
| `0.2.1-beta.58` | `2.0.0-beta.58`  | `>=4.0.0-beta.84 || >=4.0.0` | Current beta. |
| `0.2.0-beta.57` | `2.0.0-beta.57`  | `>=4.0.0-beta.84 || >=4.0.0` | Heartbeat groundwork. |
| `0.1.1-beta.57` | `2.0.0-beta.57`  | `>=4.0.0-beta.84 || >=4.0.0` | Blob container fix and heartbeat groundwork. |
| `0.1.0-beta.57` | `2.0.0-beta.57`  | `>=4.0.0-beta.84 || >=4.0.0` | Initial beta.57 compatibility release. |
| `0.1.0-beta.35` | `2.0.0-beta.35`  | `>=4.0.0-beta.60` | Initial public beta. |

The `alchemy` peer dependency is exact-pinned to a specific beta because the v2 API is still evolving. The `effect` peer accepts the tested beta line or stable Effect 4. Bump compatibility docs and release metadata together when the tested Alchemy beta changes.

## Install

```sh
bun add alchemy@2.0.0-beta.58 effect @bjorntech/alchemy-azure
```

`alchemy` and `effect` are peer dependencies — install them in your app, not just transitively.

`@bjorntech/alchemy-azure` ships raw TypeScript (matching the upstream `alchemy` package) and uses `.ts` import suffixes internally. Your `tsconfig.json` needs `"moduleResolution": "Bundler"` (or `"NodeNext"`) and `"allowImportingTsExtensions": true`. This is the default for Bun, Vite, and tsx; plain `tsc`-without-bundler users will need to set it explicitly.

## Alignment with Alchemy v2 principles

This package follows the patterns documented at [v2.alchemy.run](https://v2.alchemy.run/):

- **Resource declarations** use `Resource<Type, Props, Attributes>` with deterministic physical names via `createPhysicalName`.
- **Provider implementations** use `Provider.effect(R, Effect.gen(...))` returning `R.Provider.of({ ... })` with a single convergent `reconcile` (observe → ensure → sync → return), idempotent `delete`, optional `diff` (with `isResolved` guards and `stables`), and `read` for state recovery + adoption.
- **Ownership** is detected via the `alchemy:logical-id` tag (or `alchemyLogicalId` blob metadata for blob containers); foreign resources surface as `Unowned(attrs)` so `--adopt` is required to take them over.
- **Authentication** follows the `AuthProviderLayer` pattern with `env` and `stored` methods, interactive `Clank` prompts in TTYs, and non-interactive defaults in CI.
- **Secrets** (storage keys, connection strings, registry passwords, client secrets) are returned as `Redacted<string>`; Container App `Redacted` env values are sent through Container Apps secrets and `secretRef`.
- **Errors** use a tagged `AzureError` (via `Schema.TaggedErrorClass`) for `Effect.catchTag` interop.
- **Provider layers** bundle into `Azure.providers()` alongside `ProfileLive`, `CredentialsStoreLive`, and the `AzureAuth` registration — same shape as `Cloudflare.providers()` / `Axiom.providers()`.

For a deeper walkthrough, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Credentials

Two authentication methods are supported via Alchemy's profile system:

### `env` (default)

Set `AZURE_SUBSCRIPTION_ID`. Authentication uses a service principal when all of these are present:

```sh
AZURE_SUBSCRIPTION_ID=...
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
```

If only `AZURE_SUBSCRIPTION_ID` is set, Azure SDK `DefaultAzureCredential` is used, so `az login`, managed identity, and other Azure SDK credential sources can work.

### `stored`

Run `alchemy login` and select **Service Principal or Subscription** to walk through an interactive flow that stores credentials under `~/.alchemy/credentials/{profile}/azure-stored.json`. You can store either a Service Principal (tenant + client + secret) or just a subscription id when relying on `DefaultAzureCredential`.

CI environments always default to `env` regardless of profile config, so unattended runs work as long as the environment variables are set.

## Errors

Azure SDK failures inside provider lifecycle methods are wrapped as the tagged `AzureError`, carrying `operation`, `resource`, `statusCode`, `code`, and the original `cause`. The Alchemy engine surfaces them in `plan` / `deploy` output.

If you build your own custom resource on top of `@bjorntech/alchemy-azure` clients, you can match `AzureError` with `Effect.catchTag` inside the provider effect:

```ts
import * as Effect from "effect/Effect";
import { AzureError } from "@bjorntech/alchemy-azure";

const ensureContainer = Effect.gen(function* () {
  // ...your reconcile body, calling Azure clients via Effect.tryPromise
}).pipe(
  Effect.catchTag("AzureError", (error) =>
    error.statusCode === 409
      ? Effect.logWarning(`Skipping: ${error.resource} already exists`)
      : Effect.fail(error),
  ),
);
```

> Note: `Effect.catchTag` does not intercept errors from `yield* Azure.X(...)` directly — resource declarations register on the stack, and the engine runs `reconcile` later. To inspect or recover from `AzureError`, do it inside a custom resource's `reconcile`.

## Usage

```ts
import * as Alchemy from "alchemy";
import * as Azure from "@bjorntech/alchemy-azure";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "azure-demo",
  { providers: Azure.providers() },
  Effect.gen(function* () {
    const group = yield* Azure.ResourceGroup("Group", {
      location: "westeurope",
      tags: { app: "azure-demo" },
    });

    const storage = yield* Azure.StorageAccount("Storage", {
      resourceGroup: group,
      sku: "Standard_LRS",
    });

    const uploads = yield* Azure.BlobContainer("Uploads", {
      storageAccount: storage,
      publicAccess: "None",
    });

    return {
      resourceGroup: group.name,
      storageAccount: storage.name,
      uploadsUrl: uploads.url,
    };
  }),
);
```

## Resources

- `ResourceGroup` - Azure Resource Group lifecycle.
- `ResourceProviderRegistration` - Azure resource provider namespace registration.
- `StorageAccount` - Azure Storage Account lifecycle with keys and connection string returned as `Redacted` values.
- `BlobContainer` - Azure Blob container lifecycle.
- `UserAssignedIdentity` - User-assigned managed identity lifecycle.
- `VirtualNetwork` - Virtual network and subnet lifecycle, including subnet ARM ID outputs and `subnetId(network, name)` lookup.
- `NetworkSecurityGroup` - Network security group lifecycle.
- `PublicIPAddress` - Public IP address lifecycle.
- `CognitiveServices` - Azure AI/Cognitive Services account lifecycle.
- `ServiceBus` - Service Bus namespace lifecycle.
- `CosmosDBAccount` - Cosmos DB account lifecycle.
- `SqlServer` - Azure SQL server lifecycle.
- `SqlDatabase` - Azure SQL database lifecycle.
- `KeyVault` - Key Vault lifecycle.
- `AppServicePlan` - App Service plan lifecycle.
- `AppService` - App Service web app lifecycle.
- `FunctionApp` - Function App lifecycle.
- `StaticWebApp` - Static Web App lifecycle.
- `ContainerInstance` - Azure Container Instance lifecycle.
- `ContainerAppEnvironment` - Azure Container Apps managed environment lifecycle.
- `ContainerRegistry` - Azure Container Registry lifecycle with admin credentials returned as `Redacted` values.
- `ContainerImage` - Local Docker build and push to Azure Container Registry.
- `ContainerApp` - Experimental Azure Container Apps runtime host from an explicit image.
- `VirtualMachine` - Virtual Machine lifecycle with managed NIC, optional public IP / NSG attachment, IP forwarding, custom data, and private/public address outputs.

## Gateway VM Pattern

For SIP/RTP or other host-networked edge workloads, wire Azure networking primitives into the VM's managed NIC:

```ts
const network = yield* Azure.VirtualNetwork("Network", {
  resourceGroup: group,
  addressSpace: ["10.42.0.0/16"],
  subnets: [{ name: "sip", addressPrefix: "10.42.1.0/24" }],
});

const publicIp = yield* Azure.PublicIPAddress("GatewayIp", {
  resourceGroup: group,
  sku: "Standard",
  allocationMethod: "Static",
  domainNameLabel: "my-sip-gateway",
});

const nsg = yield* Azure.NetworkSecurityGroup("GatewayNsg", {
  resourceGroup: group,
  securityRules: [
    { name: "ssh", priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", destinationPortRange: "22" },
    { name: "sip", priority: 110, direction: "Inbound", access: "Allow", protocol: "*", destinationPortRange: "5060" },
    { name: "rtp", priority: 120, direction: "Inbound", access: "Allow", protocol: "Udp", destinationPortRange: "10000-20000" },
  ],
});

const vm = yield* Azure.VirtualMachine("GatewayVm", {
  resourceGroup: group,
  subnetId: Azure.subnetId(network, "sip"),
  publicIPAddress: publicIp,
  networkSecurityGroup: nsg,
  enableIPForwarding: true,
  adminUsername: "gateway",
  sshPublicKey,
  customData: cloudInit,
});
```

## Experimental Container App Host

`ContainerApp` is an experimental v2 `Platform` host. It deploys either an explicit image or an `Azure.ContainerImage` build artifact to Azure Container Apps; pass an external build hash to force a new revision when your build output changes.

```ts
const environment =
  yield *
  Azure.ContainerAppEnvironment("Env", {
    resourceGroup: group,
  });

const registry =
  yield *
  Azure.ContainerRegistry("Registry", {
    resourceGroup: group,
  });

const image =
  yield *
  Azure.ContainerImage("Image", {
    registry,
    context: ".",
    buildHash: build.hash,
  });

const api =
  yield *
  Azure.ContainerApp("Api", {
    resourceGroup: group,
    environment,
    image,
    registry,
    buildHash: build.hash,
    targetPort: 3000,
    env: {
      NODE_ENV: "production",
    },
  });

return api.url;
```

## Provider Layer

Merge Azure with other providers using Effect layers:

```ts
import * as Layer from "effect/Layer";

providers: Layer.mergeAll(Cloudflare.providers(), Azure.providers());
```

## Azure Blob State

Use an existing Azure Blob container as the Alchemy state backend:

```ts
export default Alchemy.Stack(
  "MyApp",
  {
    providers: Azure.providers(),
    state: Azure.blobState({
      accountName: process.env.AZURE_STORAGE_ACCOUNT!,
      accountKey: process.env.AZURE_STORAGE_KEY!,
      containerName: "alchemy-state",
    }),
  },
  Effect.gen(function* () {
    // resources...
  }),
);
```

## Live Smoke Tests

Live Azure smoke tests are opt-in and create real Azure resources. They require `AZURE_SUBSCRIPTION_ID` plus either service principal env vars (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`) or an Azure SDK-compatible login such as `az login`.

```sh
AZURE_LIVE_TEST=1 bun run smoke:azure
AZURE_LIVE_TEST=1 AZURE_SMOKE_PREFIX=<prefix-from-run> bun run smoke:azure:nuke
AZURE_LIVE_NEGATIVE_TEST=1 bun run smoke:azure:negative
```

The production and negative smoke runners both execute a scoped `alchemy unsafe nuke` cleanup after `destroy`, targeting only smoke resource groups and using smoke run tags to spare non-smoke groups. Azure then deletes all contained resources. `smoke:azure:nuke` is also exposed for manual cleanup if a smoke process is interrupted before its `finally` block runs.

Useful flags:

- `AZURE_SMOKE_LOCATION` - Azure region, defaults to `westeurope`.
- `AZURE_SMOKE_FULL=1` - include quota/cost-sensitive optional resources such as Cosmos DB, SQL, VM, Cognitive Services, Key Vault, and Static Web App. App Service Plan, App Service, and Function App are included in the default smoke stack.
- `AZURE_SMOKE_BUILD_IMAGE=1` - build and push the included Docker smoke image to ACR; requires Docker.
