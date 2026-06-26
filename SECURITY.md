# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues.

Report suspected vulnerabilities privately through GitHub Security Advisories for this repository, or contact the repository owner directly if advisories are unavailable.

Include:

- Affected version or commit.
- Steps to reproduce.
- Impact and affected Azure resources.
- Any relevant logs with secrets removed.

We aim to acknowledge reports within 7 days.

## Secret Handling

Never include a real `AZURE_CLIENT_SECRET`, storage account keys, connection strings, Container Registry passwords, Cosmos DB keys, SQL administrator passwords, stored credential files (`~/.alchemy/credentials/...`), local `.alchemy/` state, or local `.env` files in issues, pull requests, tests, or commits. Alchemy `Redacted` values are still stored as real payloads in local state files.

Secrets returned from resources (storage keys, connection strings, registry passwords, client secrets) are wrapped in Effect `Redacted<string>`. Keep them redacted — do not log or interpolate their plaintext into resource outputs, test fixtures, or error messages.

## Threat Model

`@bjorntech/alchemy-azure` is an infrastructure provider package. It runs locally (or in CI) during deployment and uses the credentials you provide to create, update, and delete Azure resources.

In scope:

- Provider bugs that expose secret values in resource outputs, logs, test fixtures, or error messages.
- Provider bugs that send credentials or secret values to the wrong API endpoint.
- Authentication or credential-resolution bugs that use a different profile, subscription, or tenant than requested.
- Delete/update lifecycle bugs that can unexpectedly affect resources owned by this provider.
- Ownership/adoption bugs (`alchemy:logical-id` tag handling) that take over or destroy foreign resources without `--adopt`.

Out of scope:

- Azure subscription, Entra ID, RBAC, or billing vulnerabilities.
- Costs from intentionally deploying live Azure resources.
- Secrets committed by users to their own repositories or `.env` files.
- Behavior of container images, workloads, or third-party services deployed with this provider.
- Reports generated only by automated AI/security scanners without a concrete, reproducible impact.

## Live Resources

Deployments and any live reproductions create billable Azure resources. Only run them when you intentionally opt in and understand the resources being created.
