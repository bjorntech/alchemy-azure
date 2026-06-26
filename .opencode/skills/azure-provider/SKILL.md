---
name: azure-provider
description: Use when working on Azure resources, Azure SDK clients, credentials, ownership tags, readiness polling, or AzureError handling.
license: MIT
compatibility: opencode
metadata:
  domain: azure
  repo: alchemy-azure
---

# Azure Provider

Use this skill for Azure-specific API and resource behavior.

## Current Scope

- Resource groups, storage accounts, blob containers, identities, networking, security groups, public IPs.
- Cognitive Services, Service Bus, Cosmos DB, SQL, Key Vault.
- App Service, Function App, Static Web App, Container Instance, Container Registry, Container Apps, and Virtual Machine resources.
- Azure Blob-backed Alchemy state.

## Resource Ergonomics

- Azure resources should be useful application abstractions, not raw SDK wrappers.
- Prefer user intent in props while keeping update/replace semantics explicit.
- Preserve standalone primitive resources for advanced or explicit wiring.
- Use safe ownership markers before adopting existing resources.

## Credentials

- `AZURE_SUBSCRIPTION_ID` is always required.
- Full service principal auth uses `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`.
- With only a subscription ID, auth uses Azure SDK `DefaultAzureCredential`.
- Stored credentials come from Alchemy profile integration and may contain either a full service principal or subscription-only default credential mode.

## API Guidance

- Real Azure SDK clients should be constructed in `src/Clients.ts` and exposed through `AzureClients` / `AzureClientsLive`.
- Provider lifecycle code should consume the injected `AzureClients` service so tests can use the in-memory fake.
- Keep SDK response normalization close to the client/resource boundary.

## Secret Handling

- Keep credentials and cloud-returned secrets in `Redacted<string>` until SDK/API boundaries.
- Never expose storage keys, connection strings, registry passwords, Cosmos DB keys, SQL passwords, or client secrets in resource attributes, logs, fixtures, or errors.

## Error Handling

- Convert SDK/cloud failures into `AzureError` with operation/resource context.
- `Effect.tryPromise(thunk)` wraps rejections; not-found/already-exists helpers must unwrap the cause chain.
- Treat 404/not-found as recoverable for read/delete.
- Treat 409/already-exists carefully: adopt only when ownership is reliable or caller explicitly adopts.

## Ownership

- Prefer Azure tags with `alchemy:logical-id`.
- Blob containers use `alchemyLogicalId` metadata.
- Foreign resources should return `Unowned(attrs)` instead of silently taking ownership.
