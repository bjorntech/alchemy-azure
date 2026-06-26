# Contributing

Thanks for helping improve `@bjorntech/alchemy-azure`.

## Development

Use Bun for local development:

```sh
bun install
```

Before opening a pull request, run:

```sh
bun run check
bun test
bun run coverage:check
```

`bun run coverage:check` enforces the repository coverage floor.

## Provider Guidelines

- Keep the flat source layout under `src/`. Smaller resources live together in `MoreResources.ts`; larger ones get their own file.
- Use Alchemy v2 `Resource` plus `Provider.effect(...Provider.of({ read, reconcile, delete, diff }))` with a single convergent `reconcile`.
- Resolve the Azure SDK clients through the injectable `AzureClients` service (`makeAzureClients`); construct real clients only in `src/Clients.ts`. This keeps provider lifecycles unit-testable with the in-memory fake in `test/support/azure-mock.ts`.
- Wrap Azure SDK failures with the tagged `AzureError` (via `azureError(...)`), and use `isNotFound` / `isAlreadyExists` for idempotent `read` / `delete` paths. Remember `Effect.tryPromise(thunk)` wraps rejections in `UnknownError`, so these helpers unwrap the `cause` chain.
- Return secrets as `Redacted<string>`.
- Detect ownership via the `alchemy:logical-id` tag (or `alchemyLogicalId` blob metadata); surface foreign resources as `Unowned(attrs)`.
- Do not commit secrets or local `.env` files.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for deeper conventions.

## Testing

- Add provider lifecycle tests in `test/providers.test.ts` using the `alchemy/Test/Bun` harness and the `AzureClients` fake. New resources should cover at least create + delete, and the attribute mapper.
- Keep `bun run check` and `bun test` green, and avoid regressing coverage.

## Pull Requests

- Keep pull requests small and focused.
- Explain what changed, why it changed, and how you verified it.
- Use conventional commit-style PR titles: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, or `test:`. Optional scopes are fine, for example `feat(keyvault): add soft-delete retention`.
- For new resources, major behavior changes, or adoption/ownership changes, open an issue or short design note first.
- Keep descriptions concise and specific; avoid long AI-generated walls of text.
