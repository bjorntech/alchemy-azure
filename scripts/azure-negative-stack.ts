import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Azure from "../src/index.ts";

const prefix = process.env.AZURE_NEGATIVE_SMOKE_PREFIX ?? "alchemy-azure-negative-smoke";
const location = process.env.AZURE_SMOKE_LOCATION ?? "westeurope";
export const resourceGroupName = `${azureSlug(prefix, 36)}-rg`;

export default Alchemy.Stack(
  "alchemy-azure-negative-smoke",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const group = yield* Azure.ResourceGroup("Group", {
      name: resourceGroupName,
      location,
      tags: { purpose: "alchemy-azure-negative-smoke-test", run: azureSlug(prefix, 36) },
    });

    const registry = yield* Azure.ContainerRegistry("Registry", {
      name: "Bad-Name",
      resourceGroup: group,
      tags: { purpose: "alchemy-azure-negative-smoke-test", run: azureSlug(prefix, 36) },
    });

    return { resourceGroupName: group.name, registryName: registry.name };
  }),
);

function azureSlug(value: string, maxLength: number) {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const normalized = /^[a-z]/.test(slug) ? slug : `az-${slug}`;
  return (normalized || "az-negative-smoke").slice(0, maxLength).replace(/-+$/g, "") || "az-negative-smoke";
}
