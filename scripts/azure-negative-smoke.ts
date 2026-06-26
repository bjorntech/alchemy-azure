import { spawnSync } from "node:child_process";
import { ResourceManagementClient } from "@azure/arm-resources";
import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.AZURE_LIVE_NEGATIVE_TEST !== "1") {
  throw new Error("Set AZURE_LIVE_NEGATIVE_TEST=1 to run the live Azure negative smoke test");
}

const subscriptionId = required("AZURE_SUBSCRIPTION_ID");
const suffix = process.env.AZURE_NEGATIVE_SMOKE_RUN_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const stage = process.env.AZURE_NEGATIVE_SMOKE_STAGE ?? `negative-smoke-${suffix}`;
const prefix = process.env.AZURE_NEGATIVE_SMOKE_PREFIX ?? `alchemy-azure-negative-smoke-${suffix}`;
const stackFile = "scripts/azure-negative-stack.ts";
const resourceGroupName = `${azureSlug(prefix, 36)}-rg`;

console.log(`Azure negative smoke stage=${stage} prefix=${prefix} resourceGroup=${resourceGroupName}`);

function runAlchemy(command: "deploy" | "destroy") {
  console.log(`alchemy ${command}`);
  const result = spawnSync("bun", ["alchemy", command, stackFile, "--stage", stage, "--yes"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
      CI: process.env.CI ?? "1",
      AZURE_NEGATIVE_SMOKE_PREFIX: prefix,
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function runNuke() {
  console.log("alchemy unsafe nuke negative smoke resources");
  const result = spawnSync("bun", ["run", "scripts/azure-smoke-nuke.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
      CI: process.env.CI ?? "1",
      AZURE_NEGATIVE_SMOKE_PREFIX: prefix,
    },
  });
  if (result.status !== 0) {
    throw new Error(`Azure negative smoke nuke failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function resourceGroupExists() {
  const credential = process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET
    ? new ClientSecretCredential(process.env.AZURE_TENANT_ID, process.env.AZURE_CLIENT_ID, process.env.AZURE_CLIENT_SECRET)
    : new DefaultAzureCredential();
  const client = new ResourceManagementClient(credential, subscriptionId);
  try {
    await client.resourceGroups.get(resourceGroupName);
    return true;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return false;
    throw error;
  }
}

const deploy = runAlchemy("deploy");
let failure: Error | undefined;

if (deploy.status === 0) {
  failure = new Error("negative smoke deploy unexpectedly succeeded; invalid registry name was not rejected");
} else {
  const output = `${deploy.stdout ?? ""}\n${deploy.stderr ?? ""}`;
  if (!output.includes("Container Registry name") && !output.includes("is invalid")) {
    failure = new Error(`negative smoke deploy failed for an unexpected reason with exit code ${deploy.status ?? "unknown"}`);
  }
}

const destroy = runAlchemy("destroy");
const destroyFailed = destroy.status !== 0;

try {
  runNuke();
} catch (error) {
  failure ??= error instanceof Error ? error : new Error(String(error));
}

if (await resourceGroupExists()) {
  failure ??= new Error(`negative smoke leaked resource group ${resourceGroupName}`);
}

if (destroyFailed && !failure) {
  console.log("negative smoke destroy failed after expected partial deploy failure; scoped nuke cleanup succeeded");
}

if (failure) throw failure;
console.log("Azure negative smoke verified failed create cleanup");

function azureSlug(value: string, maxLength: number) {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const normalized = /^[a-z]/.test(slug) ? slug : `az-${slug}`;
  return (normalized || "az-negative-smoke").slice(0, maxLength).replace(/-+$/g, "") || "az-negative-smoke";
}
