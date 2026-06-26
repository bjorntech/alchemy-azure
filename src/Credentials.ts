import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/identity";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "alchemy/Auth/AuthProvider";
import { ALCHEMY_PROFILE, AlchemyProfile } from "alchemy/Auth/Profile";
import {
  AZURE_AUTH_PROVIDER_NAME,
  type AzureAuthConfig,
  type AzureResolvedCredentials,
} from "./AuthProvider.ts";

export interface AzureCredentialsService {
  subscriptionId: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: Redacted.Redacted<string>;
  credential: TokenCredential;
}

export class AzureCredentials extends Context.Service<AzureCredentials, AzureCredentialsService>()(
  "Azure.Credentials",
) {}

export const fromAuthProvider = () =>
  Layer.effect(
    AzureCredentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<AzureAuthConfig, AzureResolvedCredentials>(
        AZURE_AUTH_PROVIDER_NAME,
      );
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      const resolved = yield* profile
        .loadOrConfigure<AzureAuthConfig>(auth, profileName, { ci })
        .pipe(Effect.flatMap((config) => auth.read(profileName, config)));

      return createAzureCredentials(resolved);
    }),
  );

export function createAzureCredentials(
  credentials: AzureResolvedCredentials,
): AzureCredentialsService {
  if (credentials.method === "servicePrincipal") {
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
  }

  return {
    subscriptionId: credentials.subscriptionId,
    tenantId: credentials.tenantId,
    credential: new DefaultAzureCredential(),
  };
}
