import type { Registry } from "@azure/arm-containerregistry";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import type { AzureClientsShape } from "./Clients.ts";
import { makeAzureClients } from "./Clients.ts";
import { azureError, isNotFound } from "./Errors.ts";
import { collectAzurePages, diffValueEqual, makePhysicalNames, persistedLocation, requireLocation, resolveResourceValue, resourceGroupName } from "./Internal.ts";
import type { Providers } from "./Providers.ts";
import type { ResourceGroup } from "./ResourceGroup.ts";
import { hasAlchemyTags, withAlchemyTags } from "./ResourceGroup.ts";

export interface ContainerRegistryProps {
  /** Registry name. Must be globally unique, 5-50 alphanumeric characters. */
  name?: string;
  /** Resource group object or name containing the registry. */
  resourceGroup: string | ResourceGroup;
  /** Azure region. Defaults to the resource group's location when a ResourceGroup object is supplied. */
  location?: string;
  /** Container Registry SKU. @default "Basic" */
  sku?: "Basic" | "Standard" | "Premium";
  /** Enable admin credentials so Docker can push images. @default true */
  adminUserEnabled?: boolean;
  /** Tags to apply to the registry. */
  tags?: Record<string, string>;
  /** Whether to delete the registry when removed from Alchemy. @default true */
  delete?: boolean;
}

export type ContainerRegistry = Resource<
  "Azure.ContainerRegistry",
  ContainerRegistryProps,
  {
    name: string;
    resourceGroupName: string;
    location: string;
    registryId: string;
    loginServer: string;
    username?: string;
    password?: Redacted.Redacted<string>;
    sku: string;
    provisioningState?: string;
    tags?: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * Azure Container Registry for storing container images.
 *
 * @example
 * ```ts
 * const registry = yield* Azure.ContainerRegistry("Registry", {
 *   resourceGroup: group,
 * });
 * ```
 */
export const ContainerRegistry = Resource<ContainerRegistry>("Azure.ContainerRegistry");

export const ContainerRegistryProvider = () =>
  Provider.effect(
    ContainerRegistry,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;

      const registryName = (id: string, instanceId: string, name?: string) =>
        names.physicalName(id, instanceId, name, {
          maxLength: 50,
          suffixLength: 8,
          delimiter: "",
          lowercase: true,
          sanitize: (value) => value.replaceAll(/[^a-z0-9]/g, "").slice(0, 50),
        });

      return ContainerRegistry.Provider.of({
        stables: ["name", "registryId", "resourceGroupName", "loginServer"],
        list: () =>
          Effect.gen(function* () {
            const groups = yield* Effect.tryPromise({
              try: () => collectAzurePages(clients.resources.resourceGroups.list()),
              catch: (cause) => azureError({ operation: "list resource groups", cause }),
            });
            const registries = yield* Effect.forEach(
              groups,
              (group) => {
                if (!group.name) return Effect.succeed([]);
                return Effect.tryPromise({
                  try: () => collectAzurePages(clients.containerRegistry.registries.listByResourceGroup(group.name!)),
                  catch: (cause) =>
                    azureError({ operation: "list Container Registries", resource: group.name, cause }),
                }).pipe(Effect.map((items) => items.map((item) => [group.name!, item] as const)));
              },
              { concurrency: 4 },
            );
            return yield* Effect.forEach(
              registries.flat(),
              ([resourceGroupName, registry]) =>
                registry.tags?.["alchemy:logical-id"]
                  ? toAttributes(registry, resourceGroupName)
                  : Effect.succeed(undefined),
              { concurrency: 4 },
            ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)));
          }),
        diff: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const name = registryName(id, instanceId, news.name);
          const groupName = yield* resourceGroupName(news.resourceGroup);
          const location = persistedLocation(news.location, output.location);
          if (
            name !== output.name ||
            groupName !== output.resourceGroupName ||
            location !== output.location
          ) {
            return { action: "replace" } as const;
          }
          if (!diffValueEqual({
            sku: olds.sku ?? "Basic",
            adminUserEnabled: olds.adminUserEnabled ?? true,
            tags: olds.tags ?? {},
          }, {
            sku: news.sku ?? "Basic",
            adminUserEnabled: news.adminUserEnabled ?? true,
            tags: news.tags ?? {},
          })) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          const groupName =
            output?.resourceGroupName ??
            (olds ? yield* resourceGroupName(olds.resourceGroup) : undefined);
          if (!groupName) return undefined;
          const name = output?.name ?? registryName(id, instanceId, olds?.name);
          const registry = yield* Effect.tryPromise({
            try: () => clients.containerRegistry.registries.get(groupName, name),
            catch: (cause) => azureError({ operation: "read Container Registry", resource: name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!registry) return undefined;
          const attrs = yield* toAttributes(registry, groupName);
          return hasAlchemyTags(id, registry.tags) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const name = registryName(id, instanceId, news.name);
          validateRegistryName(name);
          const groupName = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          if (output && olds) {
            const existing = yield* Effect.tryPromise({
              try: () => clients.containerRegistry.registries.get(groupName, name),
              catch: (cause) =>
                azureError({ operation: "read Container Registry before update", resource: name, cause }),
            }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            if (existing && hasAlchemyTags(id, output.tags) && !hasAlchemyTags(id, existing.tags)) {
              throw new Error(`Cannot adopt resource "${name}" without --adopt.`);
            }
          }
          const registry = yield* Effect.tryPromise({
            try: () =>
              clients.containerRegistry.registries.beginCreateAndWait(groupName, name, {
                location,
                sku: { name: news.sku ?? "Basic" },
                adminUserEnabled: news.adminUserEnabled ?? true,
                tags: withAlchemyTags(id, news.tags),
              }),
            catch: (cause) =>
              azureError({
                operation: "reconcile Container Registry",
                resource: name,
                cause,
              }),
          });
          return yield* toAttributes(registry, groupName);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          if (olds.delete === false) return;
          yield* session.note(`Deleting Azure Container Registry: ${output.name}`);
          yield* Effect.tryPromise({
            try: () => clients.containerRegistry.registries.beginDeleteAndWait(
              output.resourceGroupName,
              output.name,
            ),
            catch: (cause) => azureError({ operation: "delete Container Registry", resource: output.name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      });

      function toAttributes(registry: Registry, resourceGroupName: string) {
        return Effect.gen(function* () {
          if (!registry.name || !registry.id || !registry.location || !registry.loginServer) {
            throw new Error("Azure returned an incomplete Container Registry response");
          }
          const credentials = registry.adminUserEnabled
            ? yield* Effect.tryPromise({
                try: () => clients.containerRegistry.registries.listCredentials(
                  resourceGroupName,
                  registry.name!,
                ),
                catch: (cause) =>
                  azureError({ operation: "list Container Registry credentials", resource: registry.name, cause }),
              }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined;
          const password = credentials?.passwords?.find((item) => item.name === "password")?.value;
          return {
            name: registry.name,
            resourceGroupName,
            location: registry.location,
            registryId: registry.id,
            loginServer: registry.loginServer,
            username: credentials?.username,
            password: password ? Redacted.make(password) : undefined,
            sku: registry.sku.name,
            provisioningState: registry.provisioningState,
            tags: registry.tags,
          } satisfies ContainerRegistry["Attributes"];
        });
      }
    }),
  );

/**
 * Re-read a registry's admin credentials live from its stable identity.
 *
 * `username`/`password` are secrets and not stable attributes, so a
 * whole-resource registry reference no longer carries them on update (alchemy
 * beta.58, #670). Consumers (ContainerImage, ContainerApp) must fetch them via
 * the registry's stable `resourceGroupName` + `name` instead of dereferencing
 * the reference, which would yield undefined credentials on every update.
 */
export function readRegistryAdminCredentials(clients: AzureClientsShape, registry: ContainerRegistry) {
  return Effect.gen(function* () {
    const resourceGroupName = yield* resolveResourceValue(registry.resourceGroupName);
    const name = yield* resolveResourceValue(registry.name);
    const credentials = yield* Effect.tryPromise({
      try: () => clients.containerRegistry.registries.listCredentials(resourceGroupName, name),
      catch: (cause) =>
        azureError({ operation: "list Container Registry credentials", resource: name, cause }),
    });
    const password = credentials?.passwords?.find((item) => item.name === "password")?.value;
    return {
      username: credentials?.username,
      password: password ? Redacted.make(password) : undefined,
    };
  });
}

function validateRegistryName(name: string) {
  if (!/^[a-z0-9]{5,50}$/.test(name)) {
    throw new Error(
      `Azure Container Registry name "${name}" is invalid. It must be 5-50 lowercase letters or numbers.`,
    );
  }
}
