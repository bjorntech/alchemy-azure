import type { ContainerApp as AzureContainerApp } from "@azure/arm-appcontainers";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import type { BaseRuntimeContext } from "alchemy/RuntimeContext";
import type { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { makeAzureClients } from "./Clients.ts";
import { azureError, isNotFound } from "./Errors.ts";
import {
  collectAzurePages,
  makePhysicalNames,
  requireLocation,
  resourceGroupName,
  resolveResourceValue,
  withHeartbeat,
} from "./Internal.ts";
import type { ContainerAppEnvironment } from "./ContainerAppEnvironment.ts";
import type { ContainerImage } from "./ContainerImage.ts";
import type { ContainerRegistry } from "./ContainerRegistry.ts";
import type { Providers } from "./Providers.ts";
import type { ResourceProviderRegistration } from "./ResourceProviderRegistration.ts";
import type { ResourceGroup } from "./ResourceGroup.ts";
import { hasAlchemyTags, withAlchemyTags } from "./ResourceGroup.ts";

export interface ContainerAppProps extends PlatformProps {
  /**
   * Container App name. Defaults to a deterministic Azure-safe physical name.
   */
  name?: string;
  /**
   * Resource group object or name containing the Container App.
   */
  resourceGroup: string | ResourceGroup;
  /**
   * Azure region. Defaults to the resource group's location when a ResourceGroup object is supplied.
   */
  location?: string;
  /**
   * Managed environment object or resource ID.
   */
  environment: string | ContainerAppEnvironment;
  /**
   * Container image to run, for example `ghcr.io/acme/api:latest`, or a ContainerImage resource.
   */
  image: string | ContainerImage;
  /**
   * Optional Azure Container Registry for private image pulls.
   */
  registry?: ContainerRegistry;
  /** Registry username. Defaults to registry.username when registry is supplied. */
  registryUsername?: string;
  /** Registry password. Defaults to registry.password when registry is supplied. */
  registryPassword?: string | Redacted.Redacted<string>;
  /**
   * Optional hash from an external build step. Changing this creates a new revision.
   */
  buildHash?: string;
  /**
   * Container port exposed by HTTP ingress.
   * @default 3000
   */
  targetPort?: number;
  /**
   * Whether ingress is externally reachable.
   * @default true
   */
  external?: boolean;
  /**
   * Container environment variables.
   */
  env?: Record<string, unknown>;
  /**
   * Container CPU cores.
   * @default 0.5
   */
  cpu?: number;
  /**
   * Container memory, for example `1Gi`.
   * @default "1Gi"
   */
  memory?: string;
  /**
   * Minimum replica count.
   * @default 0
   */
  minReplicas?: number;
  /**
   * Maximum replica count.
   * @default 1
   */
  maxReplicas?: number;
  /**
   * Container name inside the app template.
   * @default "app"
   */
  containerName?: string;
  /**
   * Tags to apply to the Container App.
   */
  tags?: Record<string, string>;
  /** Optional provider registration dependency, usually `Microsoft.App`. */
  providerRegistration?: ResourceProviderRegistration;
  /**
   * Whether to delete the Container App when removed from Alchemy.
   * @default true
   */
  delete?: boolean;
}

export interface ContainerAppRuntimeContext extends BaseRuntimeContext {
  readonly Type: "Azure.ContainerApp";
}

export type ContainerApp = Resource<
  "Azure.ContainerApp",
  ContainerAppProps,
  {
    name: string;
    resourceGroupName: string;
    location: string;
    containerAppId: string;
    environmentId: string;
    image: string;
    buildHash?: string;
    targetPort: number;
    fqdn?: string;
    url?: string;
    latestRevisionName?: string;
    latestReadyRevisionName?: string;
    provisioningState?: string;
    runningStatus?: string;
    tags?: Record<string, string>;
  },
  never,
  Providers
>;

export type ContainerAppServices = never;
export type ContainerAppShape = Main<ContainerAppServices>;
export type ContainerAppPlatform = Platform<
  ContainerApp,
  ContainerAppServices,
  ContainerAppShape,
  ContainerAppRuntimeContext
> & {
  (
    id: string,
    props: ContainerAppProps,
  ): Effect.Effect<ContainerApp, never, ContainerApp["Providers"]>;
};

/**
 * Azure Container App — an experimental Alchemy v2 runtime host backed by Azure Container Apps.
 *
 * @example Explicit image
 * ```ts
 * const app = yield* Azure.ContainerApp("Api", {
 *   resourceGroup: group,
 *   environmentId: managedEnvironmentId,
 *   image: "ghcr.io/acme/api:latest",
 *   targetPort: 3000,
 * });
 * ```
 */
export const ContainerApp: ContainerAppPlatform = Platform("Azure.ContainerApp", {
  createRuntimeContext: (id): ContainerAppRuntimeContext => {
    const env: Record<string, Output.Output> = {};

    return {
      Type: "Azure.ContainerApp",
      id,
      env,
      set: (bindingId: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
          env[key] = output.pipe(Output.map((value) => JSON.stringify(value)));
          return key;
        }),
      get: <T>(key: string) =>
        Config.string(key)
          .pipe(
            Effect.flatMap((value) =>
              Effect.try({
                try: () => JSON.parse(value) as T,
                catch: (error) => error as Error,
              }),
            ),
            Effect.catch((cause) =>
              Effect.die(new Error(`Failed to get environment variable: ${key}`, { cause })),
            ),
          ),
    };
  },
});

export const ContainerAppProvider = () =>
  Provider.effect(
    ContainerApp,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;

      const containerAppName = (id: string, instanceId: string, name?: string) =>
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

      return ContainerApp.Provider.of({
        stables: ["name", "containerAppId", "resourceGroupName"],
        list: () =>
          Effect.gen(function* () {
            const groups = yield* Effect.tryPromise({
              try: () => collectAzurePages(clients.resources.resourceGroups.list()),
              catch: (cause) => azureError({ operation: "list resource groups", cause }),
            });
            const apps = yield* Effect.forEach(
              groups,
              (group) => {
                if (!group.name) return Effect.succeed([]);
                return Effect.tryPromise({
                  try: () => collectAzurePages(clients.appContainers.containerApps.listByResourceGroup(group.name!)),
                  catch: (cause) => azureError({ operation: "list Container Apps", resource: group.name, cause }),
                }).pipe(Effect.map((items) => items.map((item) => [group.name!, item] as const)));
              },
              { concurrency: 4 },
            );
            return apps
              .flat()
              .filter(([, app]) => app.tags?.["alchemy:logical-id"])
              .map(([resourceGroupName, app]) =>
                toAttributes(app, resourceGroupName, app.tags?.["alchemy:build-hash"]),
              );
          }),
        diff: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const name = containerAppName(id, instanceId, news.name);
          const groupName = yield* resourceGroupName(news.resourceGroup);
          const location = yield* requireLocation(id, news.location, news.resourceGroup);
          const resolvedImage = yield* imageName(news.image);
          const oldRegistry = yield* registryDiffState(olds);
          const newRegistry = yield* registryDiffState(news);
          if (
            name !== output.name ||
            groupName !== output.resourceGroupName ||
            location !== output.location ||
            (yield* environmentId(news.environment)) !== output.environmentId
          ) {
            return name !== output.name ||
              groupName !== output.resourceGroupName ||
              location !== output.location ||
              (yield* environmentId(news.environment)) !== output.environmentId
              ? ({ action: "replace" } as const)
              : ({ action: "update" } as const);
          }
          if (!sameDiffValue({
            image: yield* imageName(olds.image),
            registry: oldRegistry,
            buildHash: olds.buildHash,
            targetPort: olds.targetPort ?? 3000,
            external: olds.external ?? true,
            env: olds.env ?? {},
            cpu: olds.cpu ?? 0.5,
            memory: olds.memory ?? "1Gi",
            minReplicas: olds.minReplicas ?? 0,
            maxReplicas: olds.maxReplicas ?? 1,
            containerName: olds.containerName ?? "app",
            tags: olds.tags ?? {},
          }, {
            image: resolvedImage,
            registry: newRegistry,
            buildHash: news.buildHash,
            targetPort: news.targetPort ?? 3000,
            external: news.external ?? true,
            env: news.env ?? {},
            cpu: news.cpu ?? 0.5,
            memory: news.memory ?? "1Gi",
            minReplicas: news.minReplicas ?? 0,
            maxReplicas: news.maxReplicas ?? 1,
            containerName: news.containerName ?? "app",
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
          const name = output?.name ?? containerAppName(id, instanceId, olds?.name);
          const app = yield* Effect.tryPromise({
            try: () => clients.appContainers.containerApps.get(groupName, name),
            catch: (cause) => azureError({ operation: "read Container App", resource: name, cause }),
          }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!app) return undefined;
          const attrs = toAttributes(app, groupName, output?.buildHash ?? olds?.buildHash);
          return hasAlchemyTags(id, app.tags) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const name = containerAppName(id, instanceId, news.name);
          validateContainerAppName(name);
          if (news.providerRegistration) {
            yield* resolveResourceValue(news.providerRegistration.namespace);
          }
          const groupName = yield* resourceGroupName(news.resourceGroup);
          const location = yield* requireLocation(id, news.location, news.resourceGroup);
          const targetPort = news.targetPort ?? 3000;
          const resolvedEnvironmentId = yield* environmentId(news.environment);
          const resolvedImage = yield* imageName(news.image);
          const registry = yield* registryPullCredentials(news);
          const env = materializeContainerEnv(news.env ?? {});
          const secrets = [
            ...(registry.password
              ? [{ name: "registry-password", value: String(Redacted.value(registry.password)) }]
              : []),
            ...env.secrets,
          ];
          if (output && olds) {
            const existing = yield* Effect.tryPromise({
              try: () => clients.appContainers.containerApps.get(groupName, name),
              catch: (cause) =>
                azureError({ operation: "read Container App before update", resource: name, cause }),
            }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            if (existing && hasAlchemyTags(id, output.tags) && !hasAlchemyTags(id, existing.tags)) {
              throw new Error(`Cannot adopt resource "${name}" without --adopt.`);
            }
          }
          const app = yield* Effect.tryPromise({
            try: () =>
              clients.appContainers.containerApps.beginCreateOrUpdateAndWait(groupName, name, {
                location,
                environmentId: resolvedEnvironmentId,
                tags: withAlchemyTags(id, {
                  ...news.tags,
                  ...(news.buildHash ? { "alchemy:build-hash": news.buildHash } : {}),
                }),
                configuration: {
                  activeRevisionsMode: "Single",
                  secrets: secrets.length > 0 ? secrets : undefined,
                  registries:
                    registry.server && registry.username && registry.password
                      ? [
                          {
                            server: registry.server,
                            username: registry.username,
                            passwordSecretRef: "registry-password",
                          },
                        ]
                      : undefined,
                  ingress: {
                    external: news.external ?? true,
                    targetPort,
                    transport: "auto",
                    traffic: [{ latestRevision: true, weight: 100 }],
                  },
                },
                template: {
                  revisionSuffix: news.buildHash
                    ? `r${news.buildHash.slice(0, 10).toLowerCase()}`
                    : undefined,
                  containers: [
                    {
                      name: news.containerName ?? "app",
                      image: resolvedImage,
                      env: env.entries,
                      resources: {
                        cpu: news.cpu ?? 0.5,
                        memory: news.memory ?? "1Gi",
                      },
                    },
                  ],
                  scale: {
                    minReplicas: news.minReplicas ?? 0,
                    maxReplicas: news.maxReplicas ?? 1,
                  },
                },
              }),
            catch: (cause) =>
              azureError({
                operation: "reconcile Container App",
                resource: name,
                cause,
              }),
          }).pipe(withHeartbeat(`Container App "${name}"`));
          return toAttributes(app, groupName, news.buildHash);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          if (olds.delete === false) return;
          yield* session.note(`Deleting Azure Container App: ${output.name}`);
          yield* Effect.tryPromise({
            try: () =>
              clients.appContainers.containerApps.beginDeleteAndWait(
                output.resourceGroupName,
                output.name,
              ),
            catch: (cause) =>
              azureError({ operation: "delete Container App", resource: output.name, cause }),
          }).pipe(
            withHeartbeat(`deleting Container App "${output.name}"`),
            Effect.catchIf(isNotFound, () => Effect.void),
          );
        }),
      });
    }),
  );

function toAttributes(
  app: AzureContainerApp,
  resourceGroupName: string,
  buildHash?: string,
): ContainerApp["Attributes"] {
  if (!app.name || !app.id || !app.location || !app.environmentId) {
    throw new Error("Azure returned an incomplete Container App response");
  }
  const image = app.template?.containers?.[0]?.image;
  if (!image) {
    throw new Error("Azure returned a Container App response without a container image");
  }
  const targetPort = app.configuration?.ingress?.targetPort ?? 3000;
  const fqdn = app.configuration?.ingress?.fqdn ?? app.latestRevisionFqdn;
  return {
    name: app.name,
    resourceGroupName,
    location: app.location,
    containerAppId: app.id,
    environmentId: app.environmentId,
    image,
    buildHash: buildHash ?? app.tags?.["alchemy:build-hash"],
    targetPort,
    fqdn,
    url: fqdn ? `https://${fqdn}` : undefined,
    latestRevisionName: app.latestRevisionName,
    latestReadyRevisionName: app.latestReadyRevisionName,
    provisioningState: app.provisioningState,
    runningStatus: app.runningStatus,
    tags: app.tags,
  };
}

function stringifyEnvValue(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function materializeContainerEnv(env: Record<string, unknown>) {
  const secrets: Array<{ name: string; value: string }> = [];
  const entries = Object.entries(env).map(([name, value]) => {
    if (!Redacted.isRedacted(value)) return { name, value: stringifyEnvValue(value) };
    const slug = name.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-").replaceAll(/^-+|-+$/g, "") || "value";
    const suffix = stableShortHash(name);
    const secretName = `env-${slug.slice(0, 64 - suffix.length - 5)}-${suffix}`;
    secrets.push({ name: secretName, value: String(Redacted.value(value)) });
    return { name, secretRef: secretName };
  });
  return { entries, secrets };
}

function stableShortHash(value: string) {
  let hash = 5381;
  for (const char of value) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return hash.toString(36).slice(0, 6);
}

function sameDiffValue(left: unknown, right: unknown) {
  return JSON.stringify(stableDiffValue(left)) === JSON.stringify(stableDiffValue(right));
}

function stableDiffValue(value: unknown): unknown {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(stableDiffValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, stableDiffValue(record[key])]),
    );
  }
  return value;
}

function environmentId(environment: string | ContainerAppEnvironment) {
  return Effect.gen(function* () {
    if (typeof environment === "string") return environment;
    return yield* resolveResourceValue(environment.environmentId);
  });
}

function imageName(image: string | ContainerImage) {
  return Effect.gen(function* () {
    if (typeof image === "string") return image;
    return yield* resolveResourceValue(image.image);
  });
}

function registryPullCredentials(props: ContainerAppProps) {
  return Effect.gen(function* () {
    if (props.registryUsername && props.registryPassword) {
      return {
        server: props.registry ? yield* registryLoginServer(props.registry) : undefined,
        username: props.registryUsername,
        password:
          typeof props.registryPassword === "string"
            ? Redacted.make(props.registryPassword)
            : props.registryPassword,
      };
    }
    if (!props.registry) return {};
    const server = yield* registryLoginServer(props.registry);
    const username = yield* resolveResourceValue(props.registry.username);
    const password = yield* resolveResourceValue(props.registry.password);
    return { server, username, password };
  });
}

function registryDiffState(props: ContainerAppProps) {
  return Effect.gen(function* () {
    const credentials = yield* registryPullCredentials(props);
    return {
      server: credentials.server,
      username: credentials.username,
      password: credentials.password ? Redacted.value(credentials.password) : undefined,
    };
  });
}

function registryLoginServer(registry: ContainerRegistry) {
  return Effect.gen(function* () {
    return yield* resolveResourceValue(registry.loginServer);
  });
}

function validateContainerAppName(name: string) {
  if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(name)) {
    throw new Error(
      `Azure Container App name "${name}" is invalid. It must be 2-32 characters, start with a lowercase letter, end with a lowercase letter or number, and contain only lowercase letters, numbers, and hyphens.`,
    );
  }
}
