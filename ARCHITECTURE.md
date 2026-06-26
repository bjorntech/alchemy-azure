# Architecture

This document explains how `@bjorntech/alchemy-azure` is organised and why. It's aimed at contributors and at anyone who wants to add a new Azure resource type.

For an end-user view of the package, see the [README](./README.md). For the upstream v2 model this package implements, see [v2.alchemy.run](https://v2.alchemy.run/).

## File layout

```
src/
  index.ts                      ← public re-exports
  Providers.ts                  ← the providers() layer (Provider.collection + AuthProvider + Credentials)
  AuthProvider.ts               ← AzureAuth (env + stored) + resolveFromEnv / resolveFromStored
  Credentials.ts                ← AzureCredentials Context.Service + fromAuthProvider() bridge
  Clients.ts                    ← Azure SDK client factory keyed off AzureCredentials
  Errors.ts                     ← AzureError tagged error + isNotFound / isAlreadyExists
  Internal.ts                   ← physicalName / resourceGroupName / requireLocation helpers

  ResourceGroup.ts              ← one file per resource type
  StorageAccount.ts
  BlobContainer.ts
  ContainerAppEnvironment.ts
  ContainerRegistry.ts
  ContainerImage.ts
  ContainerApp.ts               ← experimental Platform host
  MoreResources.ts              ← bulk file containing the simpler "shape" resources

  BlobState.ts                  ← Azure Blob-backed state store (alternative to local state)

test/
  *.test.ts                     ← Bun test suites
```

## How a resource is wired

Every resource follows the same five-step contract from [v2.alchemy.run/concepts/provider](https://v2.alchemy.run/concepts/provider):

1. **Props + Attributes types** describe inputs and outputs.
2. **`Resource<T>(type)`** constructs the typed handle.
3. **`Provider.effect(R, Effect.gen(...))`** wraps the lifecycle methods.
4. **`R.Provider.of({ stables, diff, read, reconcile, delete })`** types each method against the resource's props/attrs.
5. The provider Layer is added to `Provider.collection([...])` in `src/Providers.ts` and `Layer.provide`d to it.

Concretely, a minimal resource looks like this:

```ts
// MyResource.ts
export interface MyResourceProps extends BaseProps { /* ... */ }
export type MyResource = Resource<"Azure.MyResource", MyResourceProps, Attrs<{ ... }>, never, Providers>;
export const MyResource = Resource<MyResource>("Azure.MyResource");

export const MyResourceProvider = () =>
  Provider.effect(
    MyResource,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const nameOf = (id, props) => physicalName(id, props.name, { maxLength: 64 });

      return MyResource.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        diff: Effect.fnUntraced(function* ({ olds, news, output }) { /* replace identity, update mutable */ }),
        read: Effect.fnUntraced(function* ({ id, olds, output }) { /* ... */ }),
        reconcile: Effect.fnUntraced(function* ({ id, news }) { /* ... */ }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) { /* ... */ }),
      });
    }),
  );
```

Then register it in `src/Providers.ts`:

```ts
Provider.collection([..., MyResource])
  .pipe(Layer.provide(Layer.mergeAll(..., MyResourceProvider())))
```

…and re-export from `src/index.ts`.

## Conventions

### Physical names

Use `Internal.physicalName(id, props.name, options)` to derive a deterministic Azure-safe name. The defaults respect Azure's per-service character set (lowercase, length, allowed characters). When the user supplies an explicit `name` it's used verbatim; otherwise we derive `{stack}-{stage}-{logical-id}-{instance-id}` and apply optional sanitization.

The `nameOf` closure is reused by `diff` (to detect identity changes that should trigger replacement) and by `read` (to find the live resource when adopting from cloud). Diff only returns `replace` for durable identity changes such as name, parent resource group, region, parent resource, or Azure-documented create-time properties. Mutable desired-state changes should return `update` so `reconcile` runs.

When mutability is unclear, verify against Microsoft Learn ARM template references, Azure REST API request schemas, and Terraform AzureRM `ForceNew` behavior. Prefer conservative replacement for create-time or conditionally immutable Azure properties unless the provider implements a specific safe migration path.

### Ownership

Azure's API has no built-in concept of "this resource belongs to my IaC tool", so we do it via tags:

- `withAlchemyTags(id, props.tags)` adds `alchemy:logical-id: <id>` to every resource we create.
- `hasAlchemyTags(id, resource.tags)` checks the tag matches the logical ID we expect.
- `read` brands foreign-owned attributes with `Unowned(attrs)` from `alchemy/AdoptPolicy`. The engine then refuses to take them over unless the user passes `--adopt`.
- During state recovery (`output` is defined), still verify the current Azure ownership marker. If a previously owned resource was deleted and recreated out-of-band without our marker, return `Unowned(attrs)` from `read` or fail update reconciliation unless the user explicitly adopts it.

`BlobContainer` uses the `alchemyLogicalId` blob metadata key instead of tags, since blob containers don't support Azure resource tags.

### Reconcile shape

Always **observe → ensure → sync → return**:

- **Observe**: try to GET the resource. If 404, treat as "needs create".
- **Ensure**: create-or-update. Most Azure ARM clients expose `beginCreateOrUpdateAndWait` which is idempotent.
- **Sync**: not all of Azure is convergent on a single `createOrUpdate`. For aspects that aren't (e.g. role assignments, custom domains), check observed state and apply only the delta.
- **Return**: build the `Attributes` object from the response.

Never branch the reconcile body on `output === undefined`. That just renames the old `create`/`update` split. A correct reconcile produces the right cloud state regardless of starting point.

### Errors

Wrap Azure SDK calls with `Effect.tryPromise({ try, catch })`, mapping the `catch` to `azureError({ operation, resource, cause })`. This produces a tagged `AzureError` with `statusCode` / `code` extracted from the SDK error, which downstream code can match with `Effect.catchTag("AzureError", ...)`.

For 404 handling on `read` and `delete`, use `Effect.catchIf(isNotFound, ...)`. For "already exists" race conditions, use `isAlreadyExists`.

### Secrets

Anything that's a credential — storage keys, connection strings, registry passwords, client secrets — is wrapped in `Redacted<string>` from `effect/Redacted`. The wrapper prevents accidental logging. Unwrap with `Redacted.value(x)` only at the SDK boundary.

### Clients

`makeAzureClients` (in `Clients.ts`) is an Effect that yields `AzureCredentials` and constructs every Azure SDK client we need. Each provider's outer `Effect.gen` calls `yield* makeAzureClients` once at layer-construction time, so the clients are created once per stack and shared across `reconcile` / `read` / `delete` invocations.

### Auth

`AzureAuth` registers itself in the `AuthProviders` registry under the name `"Azure"` via `AuthProviderLayer`. Two methods:

- **`env`**: reads `AZURE_*` environment variables. Returns `servicePrincipal` when tenant + client + secret are all set; otherwise returns `default` (the SDK's `DefaultAzureCredential` chain).
- **`stored`**: reads `~/.alchemy/credentials/{profile}/azure-stored.json` written by `alchemy login`. Same fallback logic.

`Credentials.fromAuthProvider()` is the bridge: it loads the profile, reads credentials via the registry, and yields an `AzureCredentialsService` (which contains a real `TokenCredential` ready for the SDK clients).

The two pure helpers `resolveFromEnv()` and `resolveFromStored(creds)` are exported so they can be unit-tested without standing up the full `AuthProvider` layer.

## Testing

Tests live in `test/` and run with `bun test`. They fall into three categories:

1. **Unit tests** for pure helpers — `resolveFromEnv`, `resolveFromStored`, `azureError`, `physicalName`. These run with no I/O.
2. **In-memory state tests** for `BlobState.ts` using a `MemoryBlobContainer` fake.
3. **Type-only tests** in `test/types.test.ts` that build a sample stack to ensure resources compose correctly.

Live cloud tests (real Azure resources) are **not** included. The upstream `alchemy/Test/Bun` harness can be used to add them later — see [v2.alchemy.run/concepts/testing](https://v2.alchemy.run/concepts/testing).

When mocking environment variables, use `ConfigProvider.fromEnv({ env })` and provide it as a Layer. `process.env` mutation does not propagate to Effect's `Config.string` reads.

## Adding a new resource

1. Pick the right Azure SDK package and add it to `dependencies` in `package.json` if it isn't already there.
2. Create `src/MyResource.ts` following the template above. For "shape" resources that don't need anything special, you can add them to `src/MoreResources.ts` instead.
3. Add the SDK client to `Clients.ts`.
4. Register the provider in `src/Providers.ts` (`Provider.collection([...])` and `Layer.mergeAll(...)`).
5. Re-export from `src/index.ts`.
6. Add a row to the resource list in `README.md`.
7. If the resource has non-trivial props, add a unit test that exercises `physicalName` / `diff` / `read` paths.

## Tracking upstream alchemy

This package is exact-pinned to a specific `alchemy@2.0.0-beta.X` because v2 is still in beta and breaking changes happen between betas. To upgrade:

1. Bump `peerDependencies.alchemy` and `devDependencies.alchemy` in `package.json` to the new beta.
2. Run `bun install`.
3. Run `bun run check` and `bun test`. Fix any new type errors or breakages.
4. Bump `@bjorntech/alchemy-azure`'s own version to match: `0.1.0-beta.36` for `alchemy@2.0.0-beta.36`, etc.
5. Update the compatibility matrix in `README.md`.
6. Add a `CHANGELOG.md` entry describing what changed and any required migration.
7. Tag and publish.

When `alchemy` cuts a stable `2.0.0`, this package will graduate to `0.1.0` (or `1.0.0`) with a permissive `^2.0.0` peerDep range.
