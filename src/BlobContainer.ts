import type { BlobContainer as AzureBlobContainer } from "@azure/arm-storage";
import * as Effect from "effect/Effect";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { Unowned } from "alchemy/AdoptPolicy";
import { makeAzureClients } from "./Clients.ts";
import { azureError, isNotFound } from "./Errors.ts";
import { collectAzurePages, diffValueEqual, makePhysicalNames, resolveResourceValue } from "./Internal.ts";
import type { Providers } from "./Providers.ts";
import type { StorageAccount } from "./StorageAccount.ts";
import { getResourceGroupName } from "./StorageAccount.ts";

const ALCHEMY_METADATA_ID = "alchemyLogicalId";

export interface BlobContainerProps {
  /**
   * Container name. Defaults to a deterministic physical name.
   */
  name?: string;
  /**
   * Storage account object or name.
   */
  storageAccount: string | StorageAccount;
  /**
   * Resource group name. Required when `storageAccount` is a string.
   */
  resourceGroup?: string;
  /** @default "None" */
  publicAccess?: "None" | "Blob" | "Container";
  metadata?: Record<string, string>;
  /** @default true */
  delete?: boolean;
}

export type BlobContainer = Resource<
  "Azure.BlobContainer",
  BlobContainerProps,
  {
    name: string;
    storageAccountName: string;
    resourceGroupName: string;
    url: string;
    publicAccess?: string;
    metadata?: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * Azure Blob Container — object storage inside an Azure Storage Account.
 *
 * @example Private blob container
 * ```ts
 * const uploads = yield* Azure.BlobContainer("Uploads", {
 *   storageAccount: storage,
 * });
 * ```
 */
export const BlobContainer = Resource<BlobContainer>("Azure.BlobContainer");

export const BlobContainerProvider = () =>
  Provider.effect(
    BlobContainer,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;

      const containerName = (id: string, instanceId: string, name?: string) =>
        names.physicalName(id, instanceId, name, {
          maxLength: 63,
          suffixLength: 8,
          lowercase: true,
        });

      return BlobContainer.Provider.of({
        stables: ["name", "storageAccountName", "resourceGroupName", "url"],
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
            const containers = yield* Effect.forEach(
              accounts.flat(),
              ([resourceGroupName, account]) => {
                if (!account.name) return Effect.succeed([]);
                return Effect.tryPromise({
                  try: () => collectAzurePages(
                    clients.storage.blobContainers.list(resourceGroupName, account.name!),
                  ),
                  catch: (cause) =>
                    azureError({ operation: "list blob containers", resource: account.name, cause }),
                }).pipe(
                  Effect.map((items) =>
                    items.map((container) => [resourceGroupName, account.name!, container] as const),
                  ),
                );
              },
              { concurrency: 4 },
            );
            return containers
              .flat()
              .filter(([, , container]) => container.metadata?.[ALCHEMY_METADATA_ID])
              .map(([resourceGroupName, storageAccountName, container]) =>
                toAttributes(container, resourceGroupName, storageAccountName, container.name!),
              );
          }),
        diff: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const name = containerName(id, instanceId, news.name);
          const oldName = output.name;
          const storageAccountName = yield* getStorageAccountName(news.storageAccount);
          const resourceGroupName = yield* getContainerResourceGroup(news);
          if (
            name !== oldName ||
            storageAccountName !== output.storageAccountName ||
            resourceGroupName !== output.resourceGroupName
          ) {
            return { action: "replace" } as const;
          }
          if (!diffValueEqual({
            publicAccess: olds.publicAccess ?? "None",
            metadata: olds.metadata ?? {},
          }, {
            publicAccess: news.publicAccess ?? "None",
            metadata: news.metadata ?? {},
          })) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          const name = output?.name ?? containerName(id, instanceId, olds?.name);
          const storageAccountName =
            output?.storageAccountName ??
            (olds ? yield* getStorageAccountName(olds.storageAccount) : undefined);
          const resourceGroupName =
            output?.resourceGroupName ??
            (olds ? yield* getContainerResourceGroup(olds) : undefined);
          if (!storageAccountName || !resourceGroupName) return undefined;
          const container = yield* Effect.tryPromise({
            try: () => clients.storage.blobContainers.get(resourceGroupName, storageAccountName, name),
            catch: (cause) => azureError({ operation: "read blob container", resource: name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!container) return undefined;
          const attrs = toAttributes(container, resourceGroupName, storageAccountName, name);
          return container.metadata?.[ALCHEMY_METADATA_ID] === id
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const name = containerName(id, instanceId, news.name);
          validateContainerName(name);
          const storageAccountName = yield* getStorageAccountName(news.storageAccount);
          const resourceGroupName = yield* getContainerResourceGroup(news);
          if (!resourceGroupName) {
            throw new Error(
              `BlobContainer "${id}" requires resourceGroup when storageAccount is a string.`,
            );
          }
          if (output && olds) {
            const existing = yield* Effect.tryPromise({
              try: () => clients.storage.blobContainers.get(resourceGroupName, storageAccountName, name),
              catch: (cause) =>
                azureError({ operation: "read blob container before update", resource: name, cause }),
            }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            if (
              existing &&
              output.metadata?.[ALCHEMY_METADATA_ID] === id &&
              existing.metadata?.[ALCHEMY_METADATA_ID] !== id
            ) {
              throw new Error(`Cannot adopt resource "${name}" without --adopt.`);
            }
          }
          const blobContainers = clients.storage.blobContainers as typeof clients.storage.blobContainers & {
            update?: typeof clients.storage.blobContainers.create;
          };
          const params = {
            publicAccess: news.publicAccess ?? "None",
            metadata: {
              ...news.metadata,
              [ALCHEMY_METADATA_ID]: id,
            },
          } as Parameters<typeof clients.storage.blobContainers.create>[3];
          const container = yield* Effect.tryPromise({
            try: async () => {
              const write = blobContainers.update ?? blobContainers.create;
              return await write(
                resourceGroupName,
                storageAccountName,
                name,
                params,
              );
            },
            catch: (cause) =>
              azureError({ operation: "reconcile blob container", resource: name, cause }),
          });
          return toAttributes(container, resourceGroupName, storageAccountName, name);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          if (olds.delete === false) return;
          yield* session.note(`Deleting Azure blob container: ${output.name}`);
          yield* Effect.tryPromise({
            try: () => clients.storage.blobContainers.delete(
              output.resourceGroupName,
              output.storageAccountName,
              output.name,
            ),
            catch: (cause) => azureError({ operation: "delete blob container", resource: output.name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      });
    }),
  );

function getStorageAccountName(storageAccount: string | StorageAccount) {
  return Effect.gen(function* () {
    if (typeof storageAccount === "string") return storageAccount;
    return yield* resolveResourceValue(storageAccount.name);
  });
}

function getContainerResourceGroup(props: BlobContainerProps) {
  return Effect.gen(function* () {
    if (props.resourceGroup) return props.resourceGroup;
    if (typeof props.storageAccount === "string") return undefined;
    return yield* resolveResourceValue(props.storageAccount.resourceGroupName);
  });
}

function toAttributes(
  container: AzureBlobContainer,
  resourceGroupName: string,
  storageAccountName: string,
  name: string,
) {
  return {
    name,
    storageAccountName,
    resourceGroupName,
    url: `https://${storageAccountName}.blob.core.windows.net/${name}`,
    publicAccess: container.publicAccess,
    metadata: container.metadata,
  } satisfies BlobContainer["Attributes"];
}

function validateContainerName(name: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(name) || name.includes("--")) {
    throw new Error(
      `Azure blob container name "${name}" is invalid. It must be 3-63 characters, lowercase letters, numbers, and hyphens, without leading, trailing, or consecutive hyphens.`,
    );
  }
}
