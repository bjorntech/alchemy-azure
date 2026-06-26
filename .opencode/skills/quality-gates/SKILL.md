---
name: quality-gates
description: Use before finishing any change or diagnosing CI failures. Covers bun run check, bun test, bun run coverage:check, and dependency/doc update expectations.
license: MIT
compatibility: opencode
metadata:
  domain: quality
  repo: alchemy-azure
---

# Quality Gates

Use this skill before marking work complete.

## Required Commands

Run all gates in this order:

```sh
bun run check
bun test
bun run coverage:check
```

`bun run coverage:check` enforces the repository coverage floor.

## Completion Checklist

- Typecheck passes.
- Tests pass.
- Coverage floor passes.
- Docs are updated for any user-visible behavior or dependency changes.
- No secrets, local `.env` files, or `.alchemy/` state/log files are added.
