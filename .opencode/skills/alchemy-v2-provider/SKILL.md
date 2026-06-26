---
name: alchemy-v2-provider
description: Use when adding or changing Alchemy v2 provider resources, Provider.effect lifecycle methods, Provider.collection wiring, adoption behavior, docs, or compatibility pins.
license: MIT
compatibility: opencode
metadata:
  domain: alchemy-provider
  repo: alchemy-azure
---

# Alchemy V2 Provider

Use this skill for resource/provider changes in `@bjorntech/alchemy-azure`.

## Target Shape

- Flat package files under `src/`.
- Public exports from `src/index.ts`.
- Provider bundle from `src/Providers.ts` as `Azure.providers()`.
- Resource declaration with Alchemy v2 `Resource`.
- Lifecycle with `Provider.effect(Resource, Effect.gen(... Resource.Provider.of({ read, reconcile, delete, diff })))`.

## Resource Design

- Model programmer-facing workflows, not a strict one-to-one mapping of Azure SDK operations.
- A resource may orchestrate multiple provider operations when that is the useful abstraction.
- Prefer intent-shaped props, safe defaults, readiness/stabilization handling, and derived outputs over exposing raw SDK payload shape.
- Keep standalone primitive resources available when callers need explicit control.
- Keep provider quirks, retries, sequencing, and readiness polling inside lifecycle reconciliation.

## Lifecycle Rules

- `read` recovers from persisted IDs and returns `undefined` on not-found.
- `reconcile` should be convergent: observe if needed, create or update, sync mutable fields, return durable attributes.
- `delete` must be idempotent and tolerate already-missing resources.
- `diff` should return `replace` only for identity changes and `update` for mutable changes.
- `stables` should list durable identity outputs only.
- Do not assume unchanged-props deploys can detect external drift unless Alchemy exposes a read-on-noop mechanism.

## Ownership

- Prefer explicit ownership markers where Azure resources support tags.
- Use `alchemy:logical-id` tags for Azure resources with tags.
- Use `alchemyLogicalId` blob metadata for blob containers.
- Foreign resources should surface as `Unowned(attrs)` so `--adopt` is required.

## Documentation

Update `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, and `AGENTS.md` when resource behavior, credentials, provider shape, or dependency pins change.

## References

- Use this repo's `ARCHITECTURE.md` and `AGENTS.md` as the public source of truth for provider shape and porting decisions.
- Use `@alchemy-effect` for upstream Alchemy v2 provider APIs, `Resource` / `Provider.effect` patterns, `Platform` behavior, and Effect integration details when API details are unclear.
