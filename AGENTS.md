# AGENTS

## Repo Purpose

This repository implements `@bjorntech/alchemy-azure`, a Microsoft Azure provider package for Alchemy v2.

The package should keep a flat Alchemy v2 provider layout and avoid nested provider-specific source trees.

## Current Package Shape

- Runtime package: raw TypeScript ESM.
- Public entrypoint: `src/index.ts`.
- Provider bundle: `Azure.providers()` from `src/Providers.ts`.
- Tests: Bun test runner.
- Package manager/runtime: Bun.

## Dependency Policy

- Keep `alchemy`, `effect`, `package.json` version, README compatibility table, and `CHANGELOG.md` aligned.
- The package beta suffix follows the tested Alchemy beta line, for example `0.1.0-beta.57` with `alchemy@2.0.0-beta.57`.
- Do not bump dependency pins independently from release metadata.

## Architecture Rules

- Keep the flat package layout under `src/`.
- Use Alchemy v2 `Resource` plus `Provider.effect(...Provider.of({ read, reconcile, delete, diff }))`.
- Keep real Azure SDK client construction in `src/Clients.ts` behind the injectable `AzureClients` service.
- Keep provider lifecycles unit-testable with the in-memory fake in `test/support/azure-mock.ts`.
- Use `AzureError` for typed cloud/API errors and unwrap Azure SDK error causes consistently.
- Return secrets as `Redacted<string>`.
- Use `alchemy:logical-id` tags, or `alchemyLogicalId` blob metadata, for ownership/adoption checks.

## Quality Gates

Before considering work complete, run all of these:

```sh
bun run check
bun test
bun run coverage:check
```

`coverage:check` enforces the repository coverage floor.

## Documentation Rules

- Keep `README.md` end-user focused: compatibility, install, credentials, usage, resources.
- Keep `ARCHITECTURE.md` contributor focused: layout, provider conventions, porting notes, resource rules.
- Update docs when dependency pins, provider shape, credential requirements, or resource behavior change.

## Safety Notes

- Never commit secrets or local `.env` files.
- Never commit local `.alchemy/` state or logs.
- Live Azure tests must be opt-in and gated by explicit environment variables.
- Azure credentials include `AZURE_CLIENT_SECRET`, storage keys, connection strings, registry passwords, Cosmos DB keys, and SQL administrator passwords; keep them redacted.
