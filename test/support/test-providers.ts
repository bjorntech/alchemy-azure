// An Azure providers layer wired to the in-memory `AzureClients` fake, so
// provider lifecycle tests exercise the real reconcile/read/diff/delete logic
// without any network or credential resolution. The resource collection is
// inlined (rather than imported from src/Providers.ts) because
// `Provider.collection([...])` infers its requirements from the array literal.
import * as Layer from "effect/Layer";
import * as Provider from "alchemy/Provider";
import type { StackServices } from "alchemy/Stack";
import { BlobContainer, BlobContainerProvider } from "../../src/BlobContainer.ts";
import { ContainerApp, ContainerAppProvider } from "../../src/ContainerApp.ts";
import {
  ContainerAppEnvironment,
  ContainerAppEnvironmentProvider,
} from "../../src/ContainerAppEnvironment.ts";
import { ContainerImage, ContainerImageProvider } from "../../src/ContainerImage.ts";
import { ContainerRegistry, ContainerRegistryProvider } from "../../src/ContainerRegistry.ts";
import {
  AppService,
  AppServicePlan,
  AppServicePlanProvider,
  AppServiceProvider,
  CognitiveServices,
  CognitiveServicesProvider,
  ContainerInstance,
  ContainerInstanceProvider,
  CosmosDBAccount,
  CosmosDBAccountProvider,
  FunctionApp,
  FunctionAppProvider,
  KeyVault,
  KeyVaultProvider,
  NetworkSecurityGroup,
  NetworkSecurityGroupProvider,
  PublicIPAddress,
  PublicIPAddressProvider,
  ServiceBus,
  ServiceBusProvider,
  SqlDatabase,
  SqlDatabaseProvider,
  SqlServer,
  SqlServerProvider,
  StaticWebApp,
  StaticWebAppProvider,
  UserAssignedIdentity,
  UserAssignedIdentityProvider,
  VirtualMachine,
  VirtualMachineProvider,
  VirtualNetwork,
  VirtualNetworkProvider,
} from "../../src/MoreResources.ts";
import { Providers } from "../../src/Providers.ts";
import {
  ResourceProviderRegistration,
  ResourceProviderRegistrationProvider,
} from "../../src/ResourceProviderRegistration.ts";
import { ResourceGroup, ResourceGroupProvider } from "../../src/ResourceGroup.ts";
import { StorageAccount, StorageAccountProvider } from "../../src/StorageAccount.ts";
import { AzureOperationLockLive } from "../../src/OperationLock.ts";
import { AzureClients, installAzureMock, type AzureMock } from "./azure-mock.ts";

export const testProviders = () => {
  const mock = installAzureMock();
  const clientsLayer = Layer.succeed(AzureClients, AzureClients.of(mock.clients));

  const providers = Layer.effect(
    Providers,
    Provider.collection([
      ResourceGroup,
      ResourceProviderRegistration,
      StorageAccount,
      BlobContainer,
      UserAssignedIdentity,
      VirtualNetwork,
      NetworkSecurityGroup,
      PublicIPAddress,
      CognitiveServices,
      ServiceBus,
      CosmosDBAccount,
      SqlServer,
      SqlDatabase,
      KeyVault,
      AppServicePlan,
      AppService,
      FunctionApp,
      StaticWebApp,
      ContainerInstance,
      ContainerAppEnvironment,
      ContainerRegistry,
      ContainerImage,
      ContainerApp,
      VirtualMachine,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ResourceGroupProvider(),
        ResourceProviderRegistrationProvider(),
        StorageAccountProvider(),
        BlobContainerProvider(),
        UserAssignedIdentityProvider(),
        VirtualNetworkProvider(),
        NetworkSecurityGroupProvider(),
        PublicIPAddressProvider(),
        CognitiveServicesProvider(),
        ServiceBusProvider(),
        CosmosDBAccountProvider(),
        SqlServerProvider(),
        SqlDatabaseProvider(),
        KeyVaultProvider(),
        AppServicePlanProvider(),
        AppServiceProvider(),
        FunctionAppProvider(),
        StaticWebAppProvider(),
        ContainerInstanceProvider(),
        ContainerAppEnvironmentProvider(),
        ContainerRegistryProvider(),
        ContainerImageProvider(),
        ContainerAppProvider(),
        VirtualMachineProvider(),
      ),
    ),
    Layer.provide(clientsLayer),
    Layer.provide(AzureOperationLockLive),
    Layer.orDie,
  );

  // The collection's residual requirement infers as `unknown` because the
  // experimental `ContainerApp` Platform widens the `Provider.collection`
  // inference (the same reason `src/Providers.ts` is consumed via `as any` in
  // types.test.ts). At runtime every requirement is satisfied by the merged
  // provider + fake-clients layers, so we assert the fully-provided shape here.
  return {
    mock,
    providers: providers as unknown as Layer.Layer<Providers, never, StackServices>,
  };
};
