import { spawnSync } from "node:child_process";

if (process.env.AZURE_LIVE_TEST !== "1" && process.env.AZURE_LIVE_NEGATIVE_TEST !== "1") {
  throw new Error("Set AZURE_LIVE_TEST=1 or AZURE_LIVE_NEGATIVE_TEST=1 to run the Azure smoke nuke cleanup");
}

const prefix = process.env.AZURE_SMOKE_PREFIX ?? process.env.AZURE_NEGATIVE_SMOKE_PREFIX;
if (!prefix) throw new Error("AZURE_SMOKE_PREFIX or AZURE_NEGATIVE_SMOKE_PREFIX is required");

const kind = process.env.AZURE_NEGATIVE_SMOKE_PREFIX ? "negative" : "production";
const purpose = kind === "negative"
  ? "alchemy-azure-negative-smoke-test"
  : "alchemy-azure-smoke-test";
const run = azureSlug(prefix, 36);

const keepNonSmokeResources = [
  "!",
  `(resource.tags?.purpose === ${JSON.stringify(purpose)} && resource.tags?.run === ${JSON.stringify(run)})`,
].join("");

console.log(`Azure ${kind} smoke nuke prefix=${prefix} run=${run}`);

const result = spawnSync(
  "bun",
  [
    "alchemy",
    "unsafe",
    "nuke",
    "scripts/azure-nuke-stack.ts",
    "--yes",
    "--verbose",
    "--concurrency",
    process.env.AZURE_SMOKE_NUKE_CONCURRENCY ?? "1",
    "--timeout",
    process.env.AZURE_SMOKE_NUKE_TIMEOUT ?? "1800",
    "--include",
    "Azure.ResourceGroup",
    "--filter",
    keepNonSmokeResources,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
      CI: process.env.CI ?? "1",
    },
  },
);

if (result.status !== 0) {
  throw new Error(`Azure smoke nuke failed with exit code ${result.status ?? "unknown"}`);
}

function azureSlug(value: string, maxLength: number) {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const normalized = /^[a-z]/.test(slug) ? slug : `az-${slug}`;
  return (normalized || "az-smoke").slice(0, maxLength).replace(/-+$/g, "") || "az-smoke";
}
