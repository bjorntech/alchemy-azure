import type { Provider as AzureResourceProvider } from "@azure/arm-resources";
import * as Effect from "effect/Effect";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { makeAzureClients } from "./Clients.ts";
import { azureError, isNotFound } from "./Errors.ts";
import { collectAzurePages } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export interface ResourceProviderRegistrationProps {
  /** Azure resource provider namespace, for example `Microsoft.App`. */
  namespace: string;
  /** Seconds to wait for Azure to report `Registered`. @default 600 */
  timeoutSeconds?: number;
  /** Seconds between registration-state polls. @default 5 */
  pollIntervalSeconds?: number;
  /**
   * Whether destroy should unregister the provider namespace.
   *
   * Defaults to false because provider registrations are subscription-scoped
   * prerequisites and unregistering can break unrelated workloads.
   */
  unregisterOnDelete?: boolean;
}

export type ResourceProviderRegistration = Resource<
  "Azure.ResourceProviderRegistration",
  ResourceProviderRegistrationProps,
  {
    namespace: string;
    registrationState?: string;
    providerId?: string;
    unregisterOnDelete: boolean;
  },
  never,
  Providers
>;

export const ResourceProviderRegistration = Resource<ResourceProviderRegistration>(
  "Azure.ResourceProviderRegistration",
);

export const ResourceProviderRegistrationProvider = () =>
  Provider.effect(
    ResourceProviderRegistration,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;

      return ResourceProviderRegistration.Provider.of({
        stables: ["namespace"],
        list: () =>
          Effect.tryPromise({
            try: () => collectAzurePages(clients.resources.providers.list()),
            catch: (cause) =>
              azureError({ operation: "list Azure resource provider registrations", cause }),
          }).pipe(
            Effect.map((providers) => providers.map((provider) => toAttributes(provider, false))),
          ),
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          if (normalizeNamespace(news.namespace) !== output.namespace) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          const namespace = output?.namespace ?? (olds ? normalizeNamespace(olds.namespace) : undefined);
          if (!namespace) return undefined;
          const provider = yield* getProvider(namespace);
          return toAttributes(provider, output?.unregisterOnDelete ?? olds?.unregisterOnDelete ?? false);
        }),
        reconcile: Effect.fnUntraced(function* ({ news }) {
          const namespace = normalizeNamespace(news.namespace);
          validateNamespace(namespace);

          const current = yield* getProvider(namespace);
          if (current.registrationState === "Registered") {
            return toAttributes(current, news.unregisterOnDelete ?? false);
          }

          yield* Effect.tryPromise({
            try: () => clients.resources.providers.register(namespace),
            catch: (cause) =>
              azureError({
                operation: "register Azure resource provider",
                resource: namespace,
                cause,
              }),
          });

          const registered = yield* Effect.tryPromise({
            try: () =>
              waitForRegistered(
                () => clients.resources.providers.get(namespace),
                news.timeoutSeconds ?? 600,
                news.pollIntervalSeconds ?? 5,
              ),
            catch: (cause) =>
              azureError({
                operation: "wait for Azure resource provider registration",
                resource: namespace,
                cause,
              }),
          });
          return toAttributes(registered, news.unregisterOnDelete ?? false);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          if (!olds.unregisterOnDelete && !output.unregisterOnDelete) return;
          yield* session.note(`Unregistering Azure resource provider: ${output.namespace}`);
          yield* Effect.tryPromise({
            try: () => clients.resources.providers.unregister(output.namespace),
            catch: (cause) =>
              azureError({
                operation: "unregister Azure resource provider",
                resource: output.namespace,
                cause,
              }),
          }).pipe(
            Effect.catchIf(isNotFound, () => Effect.void),
          );
        }),
      });

      function getProvider(namespace: string) {
        return Effect.tryPromise({
          try: () => clients.resources.providers.get(namespace),
          catch: (cause) =>
            azureError({
              operation: "read Azure resource provider registration",
              resource: namespace,
              cause,
            }),
        });
      }
    }),
  );

function toAttributes(provider: AzureResourceProvider, unregisterOnDelete: boolean) {
  const namespace = normalizeNamespace(provider.namespace ?? provider.id?.split("/").pop() ?? "");
  return {
    namespace,
    registrationState: provider.registrationState,
    providerId: provider.id,
    unregisterOnDelete,
  } satisfies ResourceProviderRegistration["Attributes"];
}

function normalizeNamespace(namespace: string) {
  return namespace.trim();
}

function validateNamespace(namespace: string) {
  if (!/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/.test(namespace)) {
    throw new Error(`Azure resource provider namespace "${namespace}" is invalid.`);
  }
}

async function waitForRegistered(
  getProvider: () => Promise<AzureResourceProvider>,
  timeoutSeconds: number,
  pollIntervalSeconds: number,
) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let latest = await getProvider();
  while (latest.registrationState !== "Registered") {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${latest.namespace ?? "provider"} to register; latest state: ${latest.registrationState ?? "unknown"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
    latest = await getProvider();
  }
  return latest;
}
