import { spawnSync } from "node:child_process";
import { ContainerAppsAPIClient } from "@azure/arm-appcontainers";
import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.AZURE_LIVE_TEST !== "1") {
  throw new Error("Set AZURE_LIVE_TEST=1 to run the live Azure production smoke test");
}

const subscriptionId = required("AZURE_SUBSCRIPTION_ID");
const suffix = process.env.AZURE_SMOKE_RUN_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const stage = process.env.AZURE_SMOKE_STAGE ?? `smoke-${suffix}`;
const prefix = process.env.AZURE_SMOKE_PREFIX ?? `alchemy-azure-smoke-${suffix}`;
const stackFile = "scripts/azure-production-stack.ts";
const resourceGroupName = `${azureSlug(prefix, 36)}-rg`;
const containerAppName = azureSlug(`${azureSlug(prefix, 36)}-app`, 32);

console.log(`Azure production smoke stage=${stage} prefix=${prefix} resourceGroup=${resourceGroupName}`);

if (process.env.AZURE_SMOKE_BUILD_IMAGE === "1") {
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (docker.status !== 0) {
    throw new Error("Docker is required when AZURE_SMOKE_BUILD_IMAGE=1");
  }
}

function runAlchemy(command: "deploy" | "destroy", phase: "create" | "update" | "replace" | "settle") {
  console.log(`alchemy ${command} ${phase}`);
  const result = spawnSync("bun", ["alchemy", command, stackFile, "--stage", stage, "--yes"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
      CI: process.env.CI ?? "1",
      AZURE_SMOKE_PHASE: phase,
      AZURE_SMOKE_PREFIX: prefix,
    },
  });
  if (result.status !== 0) {
    throw new Error(`alchemy ${command} ${phase} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function runNuke() {
  console.log("alchemy unsafe nuke smoke resources");
  const result = spawnSync("bun", ["run", "scripts/azure-smoke-nuke.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
      CI: process.env.CI ?? "1",
      AZURE_SMOKE_PREFIX: prefix,
    },
  });
  if (result.status !== 0) {
    throw new Error(`Azure smoke nuke failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function fetchContainerApp() {
  const credential = process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET
    ? new ClientSecretCredential(process.env.AZURE_TENANT_ID, process.env.AZURE_CLIENT_ID, process.env.AZURE_CLIENT_SECRET)
    : new DefaultAzureCredential();
  const client = new ContainerAppsAPIClient(credential, subscriptionId);
  let fqdn: string | undefined;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const app = await client.containerApps.get(resourceGroupName, containerAppName);
    fqdn = app.configuration?.ingress?.fqdn ?? app.latestRevisionFqdn;
    if (fqdn) break;
    console.log(`waiting for Container App fqdn ${attempt}/30`);
    await delay(10_000);
  }
  if (!fqdn) throw new Error(`Container App ${containerAppName} did not expose an fqdn`);

  const url = `https://${fqdn}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok) {
        console.log(`fetched ${url} (${response.status})`);
        return;
      }
      lastError = new Error(`unexpected response ${response.status}: ${body.slice(0, 120)}`);
    } catch (error) {
      lastError = error;
    }
    console.log(`waiting for ${url} fetch attempt ${attempt}/30`);
    await delay(10_000);
  }
  throw lastError instanceof Error ? lastError : new Error(`failed to fetch ${url}`);
}

try {
  runAlchemy("deploy", "create");
  runAlchemy("deploy", "update");
  runAlchemy("deploy", "replace");
  runAlchemy("deploy", "settle");
  await fetchContainerApp();
  console.log("Azure production smoke deploy/update/replace paths succeeded");
} finally {
  let destroyError: unknown;
  try {
    runAlchemy("destroy", "settle");
  } catch (error) {
    destroyError = error;
  } finally {
    runNuke();
  }
  if (destroyError) {
    console.warn("Azure production smoke destroy failed, but scoped resource-group nuke succeeded");
  } else {
    console.log("Azure production smoke destroy path succeeded");
  }
}

function azureSlug(value: string, maxLength: number) {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const normalized = /^[a-z]/.test(slug) ? slug : `az-${slug}`;
  return (normalized || "az-smoke").slice(0, maxLength).replace(/-+$/g, "") || "az-smoke";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
