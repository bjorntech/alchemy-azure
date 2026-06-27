import type { ManagedEnvironment } from "@azure/arm-appcontainers";
import * as Effect from "effect/Effect";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { makeAzureClients } from "./Clients.ts";
import { azureError, isNotFound } from "./Errors.ts";
import { collectAzurePages, diffValueEqual, makePhysicalNames, persistedLocation, requireLocation, resourceGroupName, resolveResourceValue, withHeartbeat } from "./Internal.ts";
import { AzureOperationLock, containerEnvironmentScopeKey } from "./OperationLock.ts";
import type { Providers } from "./Providers.ts";
import type { ResourceProviderRegistration } from "./ResourceProviderRegistration.ts";
import type { ResourceGroup } from "./ResourceGroup.ts";
import { hasAlchemyTags, withAlchemyTags } from "./ResourceGroup.ts";

export interface ContainerAppEnvironmentProps {
  /** Managed environment name. Defaults to a deterministic Azure-safe physical name. */
  name?: string;
  /** Resource group object or name containing the managed environment. */
  resourceGroup: string | ResourceGroup;
  /** Azure region. Defaults to the resource group's location when a ResourceGroup object is supplied. */
  location?: string;
  /** Log Analytics workspace customer ID for Container Apps logs. */
  logAnalyticsCustomerId?: string;
  /** Log Analytics shared key for Container Apps logs. */
  logAnalyticsSharedKey?: string;
  /** Whether the environment is zone redundant. */
  zoneRedundant?: boolean;
  /** Tags to apply to the managed environment. */
  tags?: Record<string, string>;
  /** Optional provider registration dependency, usually `Microsoft.App`. */
  providerRegistration?: ResourceProviderRegistration;
  /** Whether to delete the managed environment when removed from Alchemy. @default true */
  delete?: boolean;
}

export type ContainerAppEnvironment = Resource<
  "Azure.ContainerAppEnvironment",
  ContainerAppEnvironmentProps,
  {
    name: string;
    resourceGroupName: string;
    location: string;
    environmentId: string;
    defaultDomain?: string;
    staticIp?: string;
    provisioningState?: string;
    tags?: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * Azure Container Apps managed environment.
 *
 * @example
 * ```ts
 * const environment = yield* Azure.ContainerAppEnvironment("Env", {
 *   resourceGroup: group,
 * });
 * ```
 */
export const ContainerAppEnvironment = Resource<ContainerAppEnvironment>(
  "Azure.ContainerAppEnvironment",
);

export const ContainerAppEnvironmentProvider = () =>
  Provider.effect(
    ContainerAppEnvironment,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const lock = yield* AzureOperationLock;
      const names = yield* makePhysicalNames;

      const environmentName = (id: string, instanceId: string, name?: string) =>
        names.physicalName(id, instanceId, name, {
          maxLength: 32,
          suffixLength: 6,
          delimiter: "-",
          lowercase: true,
          sanitize: (value) =>
            value
              .replaceAll(/[^a-z0-9-]/g, "-")
              .replaceAll(/^-+|-+$/g, "")
              .slice(0, 32),
        });

      return ContainerAppEnvironment.Provider.of({
        stables: ["name", "environmentId", "resourceGroupName"],
        list: () =>
          Effect.gen(function* () {
            const groups = yield* Effect.tryPromise({
              try: () => collectAzurePages(clients.resources.resourceGroups.list()),
              catch: (cause) => azureError({ operation: "list resource groups", cause }),
            });
            const environments = yield* Effect.forEach(
              groups,
              (group) => {
                if (!group.name) return Effect.succeed([]);
                return Effect.tryPromise({
                  try: () => collectAzurePages(
                    clients.appContainers.managedEnvironments.listByResourceGroup(group.name!),
                  ),
                  catch: (cause) =>
                    azureError({ operation: "list Container Apps managed environments", resource: group.name, cause }),
                }).pipe(Effect.map((items) => items.map((item) => [group.name!, item] as const)));
              },
              { concurrency: 4 },
            );
            return environments
              .flat()
              .filter(([, environment]) => environment.tags?.["alchemy:logical-id"])
              .map(([resourceGroupName, environment]) => toAttributes(environment, resourceGroupName));
          }),
        diff: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const name = environmentName(id, instanceId, news.name);
          const groupName = yield* resourceGroupName(news.resourceGroup);
          const location = persistedLocation(news.location, output.location);
          if (
            name !== output.name ||
            groupName !== output.resourceGroupName ||
            location !== output.location
          ) {
            return { action: "replace" } as const;
          }
          if ((olds.zoneRedundant ?? false) !== (news.zoneRedundant ?? false)) {
            return { action: "replace" } as const;
          }
          if (!diffValueEqual({
            logAnalyticsCustomerId: olds.logAnalyticsCustomerId,
            logAnalyticsSharedKey: olds.logAnalyticsSharedKey,
            tags: olds.tags ?? {},
          }, {
            logAnalyticsCustomerId: news.logAnalyticsCustomerId,
            logAnalyticsSharedKey: news.logAnalyticsSharedKey,
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
          const name = output?.name ?? environmentName(id, instanceId, olds?.name);
          const environment = yield* Effect.tryPromise({
            try: () => clients.appContainers.managedEnvironments.get(groupName, name),
            catch: (cause) => azureError({ operation: "read Container Apps managed environment", resource: name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!environment) return undefined;
          const attrs = toAttributes(environment, groupName);
          return hasAlchemyTags(id, environment.tags) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const name = environmentName(id, instanceId, news.name);
          validateEnvironmentName(name);
          if (news.providerRegistration) {
            yield* resolveResourceValue(news.providerRegistration.namespace);
          }
          const groupName = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          if (output && olds) {
            const existing = yield* Effect.tryPromise({
              try: () => clients.appContainers.managedEnvironments.get(groupName, name),
              catch: (cause) =>
                azureError({
                  operation: "read Container Apps managed environment before update",
                  resource: name,
                  cause,
                }),
            }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            if (existing && hasAlchemyTags(id, output.tags) && !hasAlchemyTags(id, existing.tags)) {
              throw new Error(`Cannot adopt resource "${name}" without --adopt.`);
            }
          }
          // Serialize against Container App operations sharing this environment;
          // an app cannot be mutated while its environment is provisioning.
          const environment = yield* lock.withLock(
            containerEnvironmentScopeKey(groupName, name),
            Effect.tryPromise({
              try: () =>
                clients.appContainers.managedEnvironments.beginCreateOrUpdateAndWait(
                  groupName,
                  name,
                  {
                    location,
                    zoneRedundant: news.zoneRedundant ?? false,
                    tags: withAlchemyTags(id, news.tags),
                    appLogsConfiguration:
                      news.logAnalyticsCustomerId && news.logAnalyticsSharedKey
                        ? {
                            destination: "log-analytics",
                            logAnalyticsConfiguration: {
                              customerId: news.logAnalyticsCustomerId,
                              sharedKey: news.logAnalyticsSharedKey,
                            },
                          }
                        : undefined,
                  },
                ),
              catch: (cause) =>
                azureError({
                  operation: "reconcile Container Apps managed environment",
                  resource: name,
                  cause,
                }),
            }).pipe(withHeartbeat(`Container Apps managed environment "${name}"`)),
          );
          return toAttributes(environment, groupName);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          if (olds.delete === false) return;
          yield* session.note(`Deleting Azure Container Apps managed environment: ${output.name}`);
          yield* Effect.tryPromise({
            try: () => clients.appContainers.managedEnvironments.beginDeleteAndWait(
              output.resourceGroupName,
              output.name,
            ),
            catch: (cause) =>
              azureError({ operation: "delete Container Apps managed environment", resource: output.name, cause }),
          }).pipe(
            withHeartbeat(`deleting Container Apps managed environment "${output.name}"`),
            Effect.catchIf(isNotFound, () => Effect.void),
          );
        }),
      });
    }),
  );

function toAttributes(
  environment: ManagedEnvironment,
  resourceGroupName: string,
): ContainerAppEnvironment["Attributes"] {
  if (!environment.name || !environment.id || !environment.location) {
    throw new Error("Azure returned an incomplete Container Apps managed environment response");
  }
  return {
    name: environment.name,
    resourceGroupName,
    location: environment.location,
    environmentId: environment.id,
    defaultDomain: environment.defaultDomain,
    staticIp: environment.staticIp,
    provisioningState: environment.provisioningState,
    tags: environment.tags,
  };
}

function validateEnvironmentName(name: string) {
  if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(name)) {
    throw new Error(
      `Azure Container Apps managed environment name "${name}" is invalid. It must be 2-32 characters, start with a lowercase letter, end with a lowercase letter or number, and contain only lowercase letters, numbers, and hyphens.`,
    );
  }
}
