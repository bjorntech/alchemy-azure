import type { ResourceGroup as AzureResourceGroup } from "@azure/arm-resources";
import * as Effect from "effect/Effect";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { makeAzureClients } from "./Clients.ts";
import { azureError, isNotFound } from "./Errors.ts";
import { collectAzurePages, diffValueEqual, makePhysicalNames } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export interface ResourceGroupProps {
  /**
   * Resource group name. Defaults to a deterministic physical name.
   */
  name?: string;
  /**
   * Azure region, for example `eastus`, `westus2`, or `westeurope`.
   */
  location: string;
  /**
   * Tags to apply to the resource group.
   */
  tags?: Record<string, string>;
  /**
   * Whether to delete the resource group when removed from Alchemy.
   *
   * @default true
   */
  delete?: boolean;
}

export type ResourceGroup = Resource<
  "Azure.ResourceGroup",
  ResourceGroupProps,
  {
    name: string;
    location: string;
    resourceGroupId: string;
    provisioningState?: string;
    tags?: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * Azure Resource Group — a logical container for Azure resources.
 *
 * @example Basic resource group
 * ```ts
 * const group = yield* Azure.ResourceGroup("Group", {
 *   location: "westeurope",
 *   tags: { app: "demo" },
 * });
 * ```
 */
export const ResourceGroup = Resource<ResourceGroup>("Azure.ResourceGroup");

export const ResourceGroupProvider = () =>
  Provider.effect(
    ResourceGroup,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;

      const resourceGroupName = (id: string, instanceId: string, name?: string) =>
        names.physicalName(id, instanceId, name, { maxLength: 90 });

      const toAttributes = (group: AzureResourceGroup) => {
        if (!group.name || !group.id || !group.location) {
          throw new Error("Azure returned an incomplete resource group response");
        }
        return {
          name: group.name,
          location: group.location,
          resourceGroupId: group.id,
          provisioningState: group.properties?.provisioningState,
          tags: group.tags,
        } satisfies ResourceGroup["Attributes"];
      };

      return ResourceGroup.Provider.of({
        stables: ["name", "resourceGroupId"],
        list: () =>
          Effect.tryPromise({
            try: () => collectAzurePages(clients.resources.resourceGroups.list()),
            catch: (cause) => azureError({ operation: "list resource groups", cause }),
          }).pipe(
            Effect.map((groups) =>
              groups
                .filter((group) => group.tags?.["alchemy:logical-id"])
                .map((group) => toAttributes(group)),
            ),
          ),
        diff: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const name = resourceGroupName(id, instanceId, news.name);
          const oldName = output.name;
          if (name !== oldName || news.location !== output.location) {
            return { action: "replace" } as const;
          }
          if (!diffValueEqual(olds.tags ?? {}, news.tags ?? {})) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          const name = output?.name ?? resourceGroupName(id, instanceId, olds?.name);
          const group = yield* Effect.tryPromise({
            try: () => clients.resources.resourceGroups.get(name),
            catch: (cause) => azureError({ operation: "read resource group", resource: name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!group) return undefined;
          const attrs = toAttributes(group);
          return hasAlchemyTags(id, group.tags) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, news }) {
          const name = resourceGroupName(id, instanceId, news.name);
          validateResourceGroupName(name);
          const tags = withAlchemyTags(id, news.tags);
          const group = yield* Effect.tryPromise({
            try: () =>
              clients.resources.resourceGroups.createOrUpdate(name, {
                location: news.location,
                tags,
              }),
            catch: (cause) =>
              azureError({ operation: "reconcile resource group", resource: name, cause }),
          });
          return toAttributes(group);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          if (olds.delete === false) return;
          yield* session.note(`Deleting Azure resource group: ${output.name}`);
          const poller = yield* Effect.tryPromise({
            try: () => clients.resources.resourceGroups.beginDelete(output.name),
            catch: (cause) => azureError({ operation: "delete resource group", resource: output.name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (poller) {
            yield* Effect.tryPromise({
              try: () => poller.pollUntilDone(),
              catch: (cause) => azureError({ operation: "wait for resource group deletion", resource: output.name, cause }),
            }).pipe(
              Effect.catchIf(isNotFound, () => Effect.void),
            );
          }
        }),
      });
    }),
  );

function validateResourceGroupName(name: string) {
  if (!/^[\w\-.()]{1,90}$/.test(name)) {
    throw new Error(
      `Azure resource group name "${name}" is invalid. It must be 1-90 characters and contain only letters, numbers, underscores, hyphens, periods, and parentheses.`,
    );
  }
}

export function withAlchemyTags(id: string, tags?: Record<string, string>) {
  return {
    ...tags,
    "alchemy:logical-id": id,
  };
}

export function hasAlchemyTags(id: string, tags: Record<string, string> | undefined) {
  return tags?.["alchemy:logical-id"] === id;
}
