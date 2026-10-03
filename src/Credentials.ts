import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthError, AuthProviders } from "alchemy/Auth/AuthProvider";
import { ProfileStore } from "alchemy/Auth/Profile";
import {
  deferUntilFirstUse,
  orDieCredentialsUnavailable,
  resolveProviderConfig,
} from "alchemy/Auth/Resolve";
import {
  AZURE_AUTH_PROVIDER_NAME,
  type AzureAuthConfig,
  type AzureResolvedCredentials,
} from "./AuthProvider.ts";
import type { TokenCredential } from "@azure/identity";

export interface AzureCredentialsService {
  subscriptionId: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: Redacted.Redacted<string>;
  credential: TokenCredential;
}
export class AzureCredentials extends Context.Service<
  AzureCredentials,
  Effect.Effect<AzureCredentialsService>
>()("Azure.Credentials") {}
const resolve: Effect.Effect<AzureCredentialsService, AuthError, AuthProviders | ProfileStore> =
  resolveProviderConfig<AzureAuthConfig, AzureResolvedCredentials>(AZURE_AUTH_PROVIDER_NAME).pipe(
    Effect.flatMap(({ profileName, resolve }) =>
      resolve.pipe(
        Effect.map(createAzureCredentials),
        Effect.mapError(
          (error) =>
            new AuthError({
              message: `Failed to resolve Azure credentials from ${profileName === undefined ? "the CI environment" : `profile '${profileName}'`}: ${error.message}`,
              cause: error,
            }),
        ),
      ),
    ),
    Effect.mapError(
      (error) =>
        new AuthError({
          message: `Failed to resolve Azure credentials: ${error.message}`,
          cause: error,
        }),
    ),
  );
export const fromAuthProvider = () =>
  Layer.effect(
    AzureCredentials,
    Effect.gen(function* () {
      const deferred = yield* deferUntilFirstUse(resolve);
      return yield* deferred.pipe(
        orDieCredentialsUnavailable(AZURE_AUTH_PROVIDER_NAME),
        Effect.cached,
      );
    }),
  );
export function createAzureCredentials(
  credentials: AzureResolvedCredentials,
): AzureCredentialsService {
  if (credentials.method === "servicePrincipal")
    return {
      subscriptionId: credentials.subscriptionId,
      tenantId: credentials.tenantId,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      credential: new ClientSecretCredential(
        credentials.tenantId,
        credentials.clientId,
        Redacted.value(credentials.clientSecret),
      ),
    };
  return {
    subscriptionId: credentials.subscriptionId,
    tenantId: credentials.tenantId,
    credential: new DefaultAzureCredential(),
  };
}
