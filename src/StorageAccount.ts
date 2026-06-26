import type { StorageAccount as AzureStorageAccount } from "@azure/arm-storage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { makeAzureClients } from "./Clients.ts";
import { azureError, isNotFound } from "./Errors.ts";
import { collectAzurePages, diffValueEqual, makePhysicalNames, resolveResourceValue } from "./Internal.ts";
import type { Providers } from "./Providers.ts";
import type { ResourceGroup } from "./ResourceGroup.ts";
import { hasAlchemyTags, withAlchemyTags } from "./ResourceGroup.ts";

export interface StorageAccountProps {
  /**
   * Storage account name. Must be globally unique, 3-24 chars, lowercase letters and numbers.
   */
  name?: string;
  /**
   * Resource group object or name containing the storage account.
   */
  resourceGroup: string | ResourceGroup;
  /**
   * Azure region. Defaults to the resource group's location when a ResourceGroup object is supplied.
   */
  location?: string;
  /** @default "Standard_LRS" */
  sku?:
    | "Standard_LRS"
    | "Standard_GRS"
    | "Standard_RAGRS"
    | "Standard_ZRS"
    | "Premium_LRS"
    | "Premium_ZRS";
  /** @default "StorageV2" */
  kind?: "StorageV2" | "BlobStorage" | "BlockBlobStorage" | "FileStorage";
  /** @default "Hot" */
  accessTier?: "Hot" | "Cool";
  /** @default false */
  allowBlobPublicAccess?: boolean;
  /** @default "TLS1_2" */
  minimumTlsVersion?: "TLS1_0" | "TLS1_1" | "TLS1_2";
  tags?: Record<string, string>;
  /** @default true */
  delete?: boolean;
}

export type StorageAccount = Resource<
  "Azure.StorageAccount",
  StorageAccountProps,
  {
    name: string;
    resourceGroupName: string;
    location: string;
    storageAccountId: string;
    primaryBlobEndpoint?: string;
    primaryQueueEndpoint?: string;
    primaryFileEndpoint?: string;
    primaryTableEndpoint?: string;
    primaryAccessKey?: Redacted.Redacted<string>;
    primaryConnectionString?: Redacted.Redacted<string>;
    provisioningState?: string;
    tags?: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * Azure Storage Account — a namespace for Blob, Queue, File, and Table storage.
 *
 * @example Storage account in a resource group
 * ```ts
 * const storage = yield* Azure.StorageAccount("Storage", {
 *   resourceGroup: group,
 *   sku: "Standard_LRS",
 * });
 * ```
 */
export const StorageAccount = Resource<StorageAccount>("Azure.StorageAccount");

export const StorageAccountProvider = () =>
  Provider.effect(
    StorageAccount,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;

      const storageAccountName = (id: string, instanceId: string, name?: string) =>
        names.physicalName(id, instanceId, name, {
          maxLength: 24,
          suffixLength: 8,
          delimiter: "",
          lowercase: true,
        });

      return StorageAccount.Provider.of({
        stables: ["name", "storageAccountId", "resourceGroupName"],
        list: () =>
          Effect.gen(function* () {
            const groups = yield* Effect.tryPromise({
              try: () => collectAzurePages(clients.resources.resourceGroups.list()),
              catch: (cause) => azureError({ operation: "list resource groups", cause }),
            });
            const accounts = yield* Effect.forEach(
              groups,
              (group) => {
                if (!group.name) return Effect.succeed([]);
                return Effect.tryPromise({
                  try: () => collectAzurePages(
                    clients.storage.storageAccounts.listByResourceGroup(group.name!),
                  ),
                  catch: (cause) =>
                    azureError({ operation: "list storage accounts", resource: group.name, cause }),
                }).pipe(Effect.map((items) => items.map((account) => [group.name!, account] as const)));
              },
              { concurrency: 4 },
            );
            return yield* Effect.forEach(
              accounts.flat(),
              ([resourceGroupName, account]) =>
                account.tags?.["alchemy:logical-id"]
                  ? toAttributes(account, resourceGroupName)
                  : Effect.succeed(undefined),
              { concurrency: 4 },
            ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)));
          }),
        diff: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const name = storageAccountName(id, instanceId, news.name);
          const oldName = output.name;
          const resourceGroupName = yield* getResourceGroupName(news.resourceGroup);
          const location = news.location ?? (yield* getResourceGroupLocation(news.resourceGroup));
          if (
            name !== oldName ||
            resourceGroupName !== output.resourceGroupName ||
            (location !== undefined && location !== output.location)
          ) {
            return { action: "replace" } as const;
          }
          if (
            (olds.kind ?? "StorageV2") !== (news.kind ?? "StorageV2") ||
            storageSkuRequiresReplacement(olds.sku ?? "Standard_LRS", news.sku ?? "Standard_LRS")
          ) {
            return { action: "replace" } as const;
          }
          if (!diffValueEqual({
            accessTier: olds.accessTier ?? "Hot",
            allowBlobPublicAccess: olds.allowBlobPublicAccess ?? false,
            minimumTlsVersion: olds.minimumTlsVersion ?? "TLS1_2",
            tags: olds.tags ?? {},
          }, {
            accessTier: news.accessTier ?? "Hot",
            allowBlobPublicAccess: news.allowBlobPublicAccess ?? false,
            minimumTlsVersion: news.minimumTlsVersion ?? "TLS1_2",
            tags: news.tags ?? {},
          })) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          const resourceGroupName =
            output?.resourceGroupName ??
            (olds ? yield* getResourceGroupName(olds.resourceGroup) : undefined);
          if (!resourceGroupName) return undefined;
          const name = output?.name ?? storageAccountName(id, instanceId, olds?.name);
          const account = yield* Effect.tryPromise({
            try: () => clients.storage.storageAccounts.getProperties(resourceGroupName, name),
            catch: (cause) => azureError({ operation: "read storage account", resource: name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!account) return undefined;
          const attrs = yield* toAttributes(account, resourceGroupName);
          return hasAlchemyTags(id, account.tags) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const name = storageAccountName(id, instanceId, news.name);
          validateStorageAccountName(name);
          const resourceGroupName = yield* getResourceGroupName(news.resourceGroup);
          const location = news.location ?? (yield* getResourceGroupLocation(news.resourceGroup));
          if (!location) {
            throw new Error(
              `StorageAccount "${id}" requires location when resourceGroup is a string.`,
            );
          }
          if (output && olds) {
            const existing = yield* Effect.tryPromise({
              try: () => clients.storage.storageAccounts.getProperties(resourceGroupName, name),
              catch: (cause) =>
                azureError({ operation: "read storage account before update", resource: name, cause }),
            }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            if (existing && hasAlchemyTags(id, output.tags) && !hasAlchemyTags(id, existing.tags)) {
              throw new Error(`Cannot adopt resource "${name}" without --adopt.`);
            }
          }
          const account = yield* Effect.tryPromise({
            try: async () => {
              const poller = await clients.storage.storageAccounts.beginCreate(
                resourceGroupName,
                name,
                {
                  location,
                  sku: { name: news.sku ?? "Standard_LRS" },
                  kind: news.kind ?? "StorageV2",
                  accessTier: news.accessTier ?? "Hot",
                  allowBlobPublicAccess: news.allowBlobPublicAccess ?? false,
                  minimumTlsVersion: news.minimumTlsVersion ?? "TLS1_2",
                  tags: withAlchemyTags(id, news.tags),
                },
              );
              return await poller.pollUntilDone();
            },
            catch: (cause) =>
              azureError({ operation: "reconcile storage account", resource: name, cause }),
          });
          return yield* toAttributes(account, resourceGroupName);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          if (olds.delete === false) return;
          yield* session.note(`Deleting Azure storage account: ${output.name}`);
          yield* Effect.tryPromise({
            try: () => clients.storage.storageAccounts.delete(output.resourceGroupName, output.name),
            catch: (cause) => azureError({ operation: "delete storage account", resource: output.name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      });

      function toAttributes(account: AzureStorageAccount, resourceGroupName: string) {
        return Effect.gen(function* () {
          if (!account.name || !account.id || !account.location) {
            throw new Error("Azure returned an incomplete storage account response");
          }
          const keys = yield* Effect.tryPromise({
            try: () => clients.storage.storageAccounts.listKeys(resourceGroupName, account.name!),
            catch: (cause) => azureError({ operation: "list storage account keys", resource: account.name, cause }),
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          const primaryAccessKey = keys?.keys?.[0]?.value;
          return {
            name: account.name,
            resourceGroupName,
            location: account.location,
            storageAccountId: account.id,
            primaryBlobEndpoint: account.primaryEndpoints?.blob,
            primaryQueueEndpoint: account.primaryEndpoints?.queue,
            primaryFileEndpoint: account.primaryEndpoints?.file,
            primaryTableEndpoint: account.primaryEndpoints?.table,
            primaryAccessKey: primaryAccessKey ? Redacted.make(primaryAccessKey) : undefined,
            primaryConnectionString: primaryAccessKey
              ? Redacted.make(
                  `DefaultEndpointsProtocol=https;AccountName=${account.name};AccountKey=${primaryAccessKey};EndpointSuffix=core.windows.net`,
                )
              : undefined,
            provisioningState: account.provisioningState,
            tags: account.tags,
          } satisfies StorageAccount["Attributes"];
        });
      }
    }),
  );

export function getResourceGroupName(resourceGroup: string | ResourceGroup) {
  return Effect.gen(function* () {
    if (typeof resourceGroup === "string") return resourceGroup;
    return yield* resolveResourceValue(resourceGroup.name);
  });
}

function storageSkuRequiresReplacement(oldSku: string, newSku: string) {
  if (oldSku === newSku) return false;
  const tier = (sku: string) => sku.split("_")[0];
  const replication = (sku: string) => sku.split("_").at(-1) ?? sku;
  const replicationFamily = (sku: string) =>
    ["ZRS", "GZRS", "RAGZRS"].includes(replication(sku)) ? "zonal" : "regional";
  return tier(oldSku) !== tier(newSku) || replicationFamily(oldSku) !== replicationFamily(newSku);
}

function getResourceGroupLocation(resourceGroup: string | ResourceGroup) {
  return Effect.gen(function* () {
    if (typeof resourceGroup === "string") return undefined;
    return yield* resolveResourceValue(resourceGroup.location);
  });
}

function validateStorageAccountName(name: string) {
  if (!/^[a-z0-9]{3,24}$/.test(name)) {
    throw new Error(
      `Azure storage account name "${name}" is invalid. It must be 3-24 characters and contain only lowercase letters and numbers.`,
    );
  }
}
