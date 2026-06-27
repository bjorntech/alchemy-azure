# Changelog

All notable changes to `@bjorntech/alchemy-azure` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows the alchemy beta line — see [README › Compatibility](./README.md#compatibility).

## [Unreleased]

## [0.2.1-beta.58] - 2026-06-27

### Changed

- Updated compatibility target to `alchemy@2.0.0-beta.58`. Effect peer is unchanged (`>=4.0.0-beta.84`).

### Fixed

- Migrated to alchemy beta.58 whole-resource reference resolution, which exposes only a referenced resource's *stable* attributes on update. `ResourceGroup` now lists `location` as a stable attribute, and every resource that derives its location from a `ResourceGroup` reference resolves `location` from its own persisted state on update. Previously, updating (or replacing during an update) resources such as identities, networking, data, messaging, compute, App Service, and Container Apps resources failed with `… requires location when resourceGroup is a string.`
- Container App and Container Image registry credentials, and Function App storage connection strings, are now re-read live from the source resource's stable identity (`resourceGroupName` + `name`) instead of dereferencing the non-stable secret attributes off a whole-resource reference, which are stripped on update.
- App Service / Function App no longer plan a spurious **replace** on update: the diff fingerprint now compares the resolved stable scalar of cross-resource references (`serverFarmId`, `storageAccount`) instead of the reference objects, whose serialization changed under beta.58.

### Added

- `AzureOperationLock`: a scoped serialization service that models Azure control-plane mutual-exclusion that the dependency graph cannot express. App Service plan and its sites serialize on the webspace (resource group); Container Apps serialize on their managed environment. This removes `409 operation in progress` and `environment has not been provisioned successfully` conflicts when a plan/environment and its dependents update concurrently.

## [0.2.0-beta.57] - 2026-06-27

### Added

- Long-running "sign of life" heartbeat: the slowest resources now log a progress
  message to stderr every 60 seconds while an operation is in flight, so slow Azure
  provisioning and teardown no longer look like a hung process. Applied selectively to
  Container Apps managed environment, Container App, Cosmos DB account, SQL server, and
  virtual machine create/delete paths; fast resources stay quiet.

### Fixed

- Blob container create/update no longer fails at runtime with
  `undefined is not an object (evaluating 'this.client')`. The reconcile path aliased
  the Azure SDK method and invoked it unbound, detaching `this`; it now calls
  `blobContainers.create` (an idempotent create-or-update PUT) directly so the SDK
  method keeps its binding.

## [0.1.1-beta.57] - 2026-06-26

### Fixed

- Container App `Redacted` environment variables now use Container Apps secrets plus `secretRef` entries instead of writing plaintext values into normal environment variable configuration.
- Azure SDK lifecycle calls now consistently wrap failures as tagged `AzureError` values with operation/resource context.
- Key Vault tenant changes, including omitted-to-explicit changes, now plan replacement.
- Tightened Azure diff semantics against public ARM documentation and Terraform AzureRM replacement behavior: create-time fields such as storage account kind, public IP SKU/version/zones, service bus tier, Cosmos DB kind/free tier, SQL version/collation, Key Vault tenant/soft-delete retention, App Service plan OS kind, container instance runtime shape, and VM OS identity/image/network credentials now plan replacement instead of unsafe in-place updates.
- Hardened the release workflow to publish only from `main`, use deterministic package tarballs, and create/verify GitHub releases.

## [0.1.0-beta.57] - 2026-06-21

### Changed

- Updated compatibility target to `alchemy@2.0.0-beta.57` and Effect `>=4.0.0-beta.84`.
- Azure SDK clients are now provided through an injectable `AzureClients` Effect
  service (with `AzureClientsLive` for production), so provider lifecycles can
  be unit-tested with an in-memory fake. Public API is unchanged.

### Fixed

- `isNotFound` / `isAlreadyExists` now unwrap the `cause` chain. `Effect.tryPromise(thunk)` wraps a rejected promise in `UnknownError`, so the previous top-level checks never matched a 404/409, which broke idempotent `read` / `delete` paths and `AzureError` status extraction for not-found resources. `azureError` now also extracts `statusCode` / `code` from the wrapped cause.

### Added

- Provider lifecycle test suite covering reconcile/read/delete/diff and attribute mapping for every non-experimental resource, plus a coverage-floor gate (`coverage:check`) wired into CI and `prepublishOnly`.
- Repository hygiene: `SECURITY.md`, `CONTRIBUTING.md`, `env.example`, `.editorconfig`, Dependabot config, and issue/PR templates.

## [0.1.0-beta.35] - 2026-06-20

Tested against `alchemy@2.0.0-beta.35`.

### Added

- Azure resource providers: `ResourceGroup`, `StorageAccount`, `BlobContainer`, `UserAssignedIdentity`, `VirtualNetwork`, `NetworkSecurityGroup`, `PublicIPAddress`, `CognitiveServices`, `ServiceBus`, `CosmosDBAccount`, `SqlServer`, `SqlDatabase`, `KeyVault`, `AppServicePlan`, `AppService`, `FunctionApp`, `StaticWebApp`, `ContainerInstance`, `ContainerAppEnvironment`, `ContainerRegistry`, `ContainerImage`, `ContainerApp` (experimental Platform host), `VirtualMachine`.
- `Azure.providers()` layer bundling every provider, the `AzureAuth` registration, and credential resolution.
- `Azure.blobState({ ... })` for using an existing Azure Blob container as the Alchemy state store.
- `AzureAuth` AuthProvider with `env` and `stored` methods. `alchemy login` walks users through configuring a Service Principal interactively; CI defaults to `env`.
- Tagged `AzureError` (via `Schema.TaggedErrorClass`) wrapping all Azure SDK failures inside provider lifecycle methods. Carries `operation`, `resource`, `statusCode`, `code`, and the original `cause` (with stack via `Schema.DefectWithStack`). Match with `Effect.catchTag("AzureError", ...)` inside custom resources.
- `resolveFromEnv()` and `resolveFromStored(creds)` exported as pure helpers for unit testing credential resolution without standing up the full layer.
- Tag-based ownership (`alchemy:logical-id`) for safe adoption — foreign-owned resources surface as `Unowned(attrs)` and require `--adopt` to take over.
- Secrets (storage keys, connection strings, registry passwords, client secrets) returned as `Redacted<string>`.

### Notes

- `peerDependencies.alchemy` is exact-pinned to the alchemy v2 beta this release was tested against. `peerDependencies.effect` accepts the tested Effect beta line or stable Effect 4.
- `ContainerApp` is marked experimental — its `Platform` integration with the upstream v2 binding model is still evolving.
