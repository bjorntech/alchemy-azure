import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AuthError, AuthProviderLayer, type ProviderDetails } from "alchemy/Auth/AuthProvider";
import { CredentialsStore, displayRedacted } from "alchemy/Auth/Credentials";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "alchemy/Auth/Env";
import * as Interaction from "alchemy/Interaction";

export const AZURE_AUTH_PROVIDER_NAME = "Azure";
export const AZURE_AUTH_STORAGE_KEY = "azure-stored";

export const AzureAuthConfigSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal("env") }),
  Schema.Struct({ method: Schema.Literal("stored") }),
]);
export type AzureAuthConfig = typeof AzureAuthConfigSchema.Type;

export const AzureStoredCredentialsSchema = Schema.Struct({
  subscriptionId: Schema.String,
  tenantId: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.NonEmptyString),
});
export type AzureStoredCredentials = typeof AzureStoredCredentialsSchema.Type;

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

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hint = (profile: string) =>
  `Run \`alchemy profile edit --profile ${profile} --reconfigure Azure\` to reconfigure.`;

export const resolveFromEnv = (): Effect.Effect<AzureResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    const subscriptionId = yield* getEnv("AZURE_SUBSCRIPTION_ID");
    if (!subscriptionId)
      return yield* new AuthError({
        message: "Azure env credentials not found. Set AZURE_SUBSCRIPTION_ID.",
      });
    const tenantId = yield* getEnv("AZURE_TENANT_ID");
    const clientId = yield* getEnv("AZURE_CLIENT_ID");
    const clientSecret = yield* getEnvRedacted("AZURE_CLIENT_SECRET");
    if (tenantId && clientId && clientSecret)
      return {
        method: "servicePrincipal",
        subscriptionId,
        tenantId,
        clientId,
        clientSecret,
        source: { type: "env" as const },
      };
    return {
      method: "default",
      subscriptionId,
      tenantId: tenantId ?? undefined,
      source: { type: "env" as const },
    };
  });

export const resolveFromStored = (
  creds: AzureStoredCredentials | undefined,
  profileName = "default",
): Effect.Effect<AzureResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    if (!creds)
      return yield* new AuthError({
        message: `Azure stored credentials not found. ${hint(profileName)}`,
      });
    if (creds.tenantId && creds.clientId && creds.clientSecret)
      return {
        method: "servicePrincipal",
        subscriptionId: creds.subscriptionId,
        tenantId: creds.tenantId,
        clientId: creds.clientId,
        clientSecret: Redacted.make(creds.clientSecret),
        source: { type: "stored" as const },
      };
    return {
      method: "default",
      subscriptionId: creds.subscriptionId,
      tenantId: creds.tenantId,
      source: { type: "stored" as const },
    };
  });

export const azureDetails = (credentials: AzureResolvedCredentials): ProviderDetails => ({
  lines: [
    { key: "subscriptionId", value: credentials.subscriptionId },
    ...(credentials.tenantId ? [{ key: "tenantId", value: credentials.tenantId }] : []),
    ...(credentials.method === "servicePrincipal"
      ? [
          { key: "clientId", value: credentials.clientId },
          { key: "clientSecret", value: displayRedacted(credentials.clientSecret) },
        ]
      : []),
  ],
});

export const AzureAuth = AuthProviderLayer<AzureAuthConfig, AzureResolvedCredentials>()(
  AZURE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;
    const interaction = Interaction.accessors;
    const promptStored = (profileName: string) =>
      Effect.gen(function* () {
        const subscriptionId = yield* interaction.prompt
          .text({
            message: "Azure Subscription ID",
            placeholder: (yield* getEnv("AZURE_SUBSCRIPTION_ID")) ?? "",
            validate: (v) =>
              v.length === 0 ? "Required" : uuid(v) ? undefined : "Expected a UUID",
          })
          .pipe(mapPromptCancellation);
        const useServicePrincipal = yield* interaction.prompt
          .confirm({
            message: "Use a Service Principal? (No = use DefaultAzureCredential / az login)",
            initialValue: false,
          })
          .pipe(mapPromptCancellation);
        let tenantId: string | undefined;
        let clientId: string | undefined;
        let clientSecret: string | undefined;
        if (useServicePrincipal) {
          tenantId = yield* interaction.prompt
            .text({
              message: "Azure Tenant ID",
              placeholder: (yield* getEnv("AZURE_TENANT_ID")) ?? "",
              validate: (v) =>
                v.length === 0 ? "Required" : uuid(v) ? undefined : "Expected a UUID",
            })
            .pipe(mapPromptCancellation);
          clientId = yield* interaction.prompt
            .text({
              message: "Azure Client ID",
              placeholder: (yield* getEnv("AZURE_CLIENT_ID")) ?? "",
              validate: (v) =>
                v.length === 0 ? "Required" : uuid(v) ? undefined : "Expected a UUID",
            })
            .pipe(mapPromptCancellation);
          clientSecret = yield* interaction.prompt
            .password({
              message: "Azure Client Secret",
              validate: (v) => (v.length === 0 ? "Required" : undefined),
            })
            .pipe(mapPromptCancellation);
        }
        yield* store.write(profileName, AZURE_AUTH_STORAGE_KEY, AzureStoredCredentialsSchema, {
          subscriptionId,
          tenantId,
          clientId,
          clientSecret,
        });
        yield* interaction.output.success("Azure: credentials saved.");
        return { method: "stored" as const };
      });
    const configure = (
      profileName: string,
    ): Effect.Effect<AzureAuthConfig, AuthError, Interaction.Interaction> =>
      interaction.prompt
        .select({
          message: "Azure authentication method",
          options: [
            {
              value: "env" as const,
              label: "Environment Variables",
              description: "AZURE_SUBSCRIPTION_ID and optional service principal variables",
            },
            {
              value: "stored" as const,
              label: "Service Principal or Subscription",
              description: "Enter credentials interactively",
            },
          ],
        })
        .pipe(
          mapPromptCancellation,
          Effect.flatMap(
            (method): Effect.Effect<AzureAuthConfig, AuthError, Interaction.Interaction> =>
              method === "stored"
                ? promptStored(profileName)
                : Effect.succeed({ method: "env" as const }),
          ),
          Effect.mapError((cause) =>
            cause instanceof AuthError
              ? cause
              : new AuthError({ message: "Failed to configure Azure credentials", cause }),
          ),
        );
    const read = (profileName: string, config: AzureAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => resolveFromEnv()),
        Match.when({ method: "stored" }, () =>
          store.read(profileName, AZURE_AUTH_STORAGE_KEY, AzureStoredCredentialsSchema).pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({ message: "Failed to read Azure stored credentials", cause }),
            ),
            Effect.flatMap((value) => resolveFromStored(value, profileName)),
          ),
        ),
        Match.exhaustive,
      );
    const login = (profileName: string, config: AzureAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => resolveFromEnv().pipe(Effect.asVoid)),
        Match.when({ method: "stored" }, () =>
          store.read(profileName, AZURE_AUTH_STORAGE_KEY, AzureStoredCredentialsSchema).pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({ message: "Failed to read Azure stored credentials", cause }),
            ),
            Effect.flatMap((value) =>
              value ? Effect.void : promptStored(profileName).pipe(Effect.asVoid),
            ),
          ),
        ),
        Match.exhaustive,
      );
    const logout = (profileName: string, config: AzureAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, AZURE_AUTH_STORAGE_KEY)
            .pipe(Effect.andThen(interaction.output.success("Azure: stored credentials removed"))),
        ),
        Match.exhaustive,
      );
    return {
      configSchema: AzureAuthConfigSchema,
      configure,
      login,
      logout,
      details: (profile: string, config: AzureAuthConfig) =>
        read(profile, config).pipe(Effect.map(azureDetails)),
      read,
      readEnvironment: resolveFromEnv(),
      environment: [
        { name: "AZURE_SUBSCRIPTION_ID", required: true, secret: false },
        { name: "AZURE_TENANT_ID", required: false, secret: false },
        { name: "AZURE_CLIENT_ID", required: false, secret: false },
        { name: "AZURE_CLIENT_SECRET", required: false, secret: true },
      ],
    };
  }),
);
