import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "alchemy/Auth/AuthProvider";
import { CredentialsStore, displayRedacted } from "alchemy/Auth/Credentials";
import { getEnv, getEnvRedacted, retryOnce } from "alchemy/Auth/Env";
import * as Clank from "alchemy/Util/Clank";

export const AZURE_AUTH_PROVIDER_NAME = "Azure";

export const AZURE_AUTH_STORAGE_KEY = "azure-stored";

/**
 * Azure auth methods supported by `alchemy login`:
 *
 * - `env` — read AZURE_SUBSCRIPTION_ID + (optional) AZURE_TENANT_ID,
 *   AZURE_CLIENT_ID, AZURE_CLIENT_SECRET. Falls back to
 *   `DefaultAzureCredential` when only the subscription is set, so
 *   `az login` and managed identity also work.
 * - `stored` — Service Principal credentials saved under
 *   `~/.alchemy/credentials/{profile}/azure-stored.json`. Only the
 *   subscription id is required; the rest is optional and unlocks
 *   service-principal auth when supplied.
 */
export type AzureAuthConfig =
  | { method: "env" }
  | { method: "stored" };

/**
 * Persisted shape for `method: "stored"`. Only `subscriptionId` is
 * required; supply `tenantId` + `clientId` + `clientSecret` to
 * authenticate as a Service Principal, otherwise the SDK falls back
 * to `DefaultAzureCredential` resolved via the SDK's own credential
 * chain.
 */
export interface AzureStoredCredentials {
  subscriptionId: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
}

export type AzureResolvedCredentials =
  | {
      method: "servicePrincipal";
      subscriptionId: string;
      tenantId: string;
      clientId: string;
      clientSecret: Redacted.Redacted<string>;
      source: { type: AzureAuthConfig["method"] };
    }
  | {
      method: "default";
      subscriptionId: string;
      tenantId?: string;
      source: { type: AzureAuthConfig["method"] };
    };

/**
 * Resolve {@link AzureResolvedCredentials} from environment variables.
 *
 * Returns `servicePrincipal` when AZURE_TENANT_ID + AZURE_CLIENT_ID +
 * AZURE_CLIENT_SECRET are all set; otherwise returns `default` so the
 * Azure SDK's `DefaultAzureCredential` chain (managed identity,
 * `az login`, etc.) is used. Fails with {@link AuthError} when
 * AZURE_SUBSCRIPTION_ID is missing.
 *
 * Exported for testing and for callers that want to skip the
 * AuthProvider registry.
 */
export const resolveFromEnv = (): Effect.Effect<AzureResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    const subscriptionId = yield* getEnv("AZURE_SUBSCRIPTION_ID");
    if (!subscriptionId) {
      return yield* new AuthError({
        message: "Azure env credentials not found. Set AZURE_SUBSCRIPTION_ID.",
      });
    }
    const tenantId = yield* getEnv("AZURE_TENANT_ID");
    const clientId = yield* getEnv("AZURE_CLIENT_ID");
    const clientSecret = yield* getEnvRedacted("AZURE_CLIENT_SECRET");

    if (tenantId && clientId && clientSecret) {
      const resolved: AzureResolvedCredentials = {
        method: "servicePrincipal",
        subscriptionId,
        tenantId,
        clientId,
        clientSecret,
        source: { type: "env" },
      };
      return resolved;
    }

    const resolved: AzureResolvedCredentials = {
      method: "default",
      subscriptionId,
      tenantId: tenantId ?? undefined,
      source: { type: "env" },
    };
    return resolved;
  });

/**
 * Resolve {@link AzureResolvedCredentials} from a previously-stored
 * `AzureStoredCredentials` payload (typically loaded from
 * `~/.alchemy/credentials/{profile}/azure-stored.json`). Pass
 * `undefined` to surface the "credentials not found" error.
 *
 * Exported for testing.
 */
export const resolveFromStored = (
  creds: AzureStoredCredentials | undefined,
): Effect.Effect<AzureResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    if (creds == null) {
      return yield* new AuthError({
        message: "Azure stored credentials not found. Run: alchemy login --configure",
      });
    }
    if (creds.tenantId && creds.clientId && creds.clientSecret) {
      const resolved: AzureResolvedCredentials = {
        method: "servicePrincipal",
        subscriptionId: creds.subscriptionId,
        tenantId: creds.tenantId,
        clientId: creds.clientId,
        clientSecret: Redacted.make(creds.clientSecret),
        source: { type: "stored" },
      };
      return resolved;
    }
    const resolved: AzureResolvedCredentials = {
      method: "default",
      subscriptionId: creds.subscriptionId,
      tenantId: creds.tenantId,
      source: { type: "stored" },
    };
    return resolved;
  });

/**
 * Layer that registers the Azure {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Included in the Azure
 * `providers()` layer so `alchemy login` can discover it and walk
 * users through interactive credential setup.
 */
export const AzureAuth = AuthProviderLayer<
  AzureAuthConfig,
  AzureResolvedCredentials
>()(
  AZURE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const promptStored = Effect.fnUntraced(function* (profileName: string) {
      const subscriptionId = yield* Clank.text({
        message: "Azure Subscription ID",
        placeholder: (yield* getEnv("AZURE_SUBSCRIPTION_ID")) ?? "",
        validate: (v) =>
          v.length === 0
            ? "Required"
            : isUuid(v)
              ? undefined
              : "Expected a UUID",
      }).pipe(retryOnce);

      const useServicePrincipal = yield* Clank.confirm({
        message: "Use a Service Principal? (No = use DefaultAzureCredential / az login)",
        initialValue: false,
      }).pipe(retryOnce);

      let tenantId: string | undefined;
      let clientId: string | undefined;
      let clientSecret: string | undefined;

      if (useServicePrincipal) {
        tenantId = yield* Clank.text({
          message: "Azure Tenant ID",
          placeholder: (yield* getEnv("AZURE_TENANT_ID")) ?? "",
          validate: (v) => (v.length === 0 ? "Required" : isUuid(v) ? undefined : "Expected a UUID"),
        }).pipe(retryOnce);

        clientId = yield* Clank.text({
          message: "Azure Client ID",
          placeholder: (yield* getEnv("AZURE_CLIENT_ID")) ?? "",
          validate: (v) => (v.length === 0 ? "Required" : isUuid(v) ? undefined : "Expected a UUID"),
        }).pipe(retryOnce);

        clientSecret = yield* Clank.password({
          message: "Azure Client Secret",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(retryOnce);
      }

      yield* store.write<AzureStoredCredentials>(profileName, AZURE_AUTH_STORAGE_KEY, {
        subscriptionId,
        tenantId,
        clientId,
        clientSecret,
      });
      yield* Clank.success("Azure: credentials saved.");

      return { method: "stored" as const };
    });

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) {
          return { method: "env" as const };
        }

        const method = yield* Clank.select({
          message: "Azure authentication method",
          options: [
            {
              value: "env" as const,
              label: "Environment Variables",
              hint: "AZURE_SUBSCRIPTION_ID (+ optional AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET)",
            },
            {
              value: "stored" as const,
              label: "Service Principal or Subscription",
              hint: "enter interactively, stored in ~/.alchemy/credentials",
            },
          ],
        }).pipe(retryOnce);

        return yield* Match.value(method).pipe(
          Match.when("env", () => Effect.succeed({ method: "env" as const })),
          Match.when("stored", () => promptStored(profileName)),
          Match.exhaustive,
        );
      }).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: AzureAuthConfig,
    ): Effect.Effect<AzureResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => resolveFromEnv()),
        Match.when({ method: "stored" }, () =>
          store
            .read<AzureStoredCredentials>(profileName, AZURE_AUTH_STORAGE_KEY)
            .pipe(Effect.flatMap(resolveFromStored)),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: AzureAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "stored" }, () =>
            store
              .read<AzureStoredCredentials>(profileName, AZURE_AUTH_STORAGE_KEY)
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? promptStored(profileName).pipe(Effect.asVoid) : Effect.void,
                ),
              ),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const logout = (profileName: string, config: AzureAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, AZURE_AUTH_STORAGE_KEY)
            .pipe(Effect.andThen(Clank.success("Azure: stored credentials removed"))),
        ),
        Match.exhaustive,
      );

    const prettyPrint = (profileName: string, config: AzureAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((credentials) =>
          Match.value(credentials).pipe(
            Match.when({ method: "servicePrincipal" }, (c) =>
              Effect.all([
                Console.log(`  subscriptionId: ${c.subscriptionId}`),
                Console.log(`  tenantId: ${c.tenantId}`),
                Console.log(`  clientId: ${c.clientId}`),
                Console.log(`  clientSecret: ${displayRedacted(c.clientSecret, 4)}`),
                Console.log(`  source: ${c.source.type}`),
              ]),
            ),
            Match.when({ method: "default" }, (c) =>
              Effect.all([
                Console.log(`  subscriptionId: ${c.subscriptionId}`),
                Console.log(`  tenantId: ${c.tenantId ?? "<auto>"}`),
                Console.log("  credential: DefaultAzureCredential"),
                Console.log(`  source: ${c.source.type}`),
              ]),
            ),
            Match.exhaustive,
          ),
        ),
        Effect.catch((e) => Console.error(`  Failed to retrieve credentials: ${e}`)),
      );

    return {
      configure: configureCredentials,
      login,
      logout,
      prettyPrint,
      read: resolveCredentials,
    };
  }),
);

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
