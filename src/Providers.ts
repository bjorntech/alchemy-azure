import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import { AzureAuth } from "./AuthProvider.ts";
import { AzureClientsLive } from "./Clients.ts";
import { BlobContainer, BlobContainerProvider } from "./BlobContainer.ts";
import * as Credentials from "./Credentials.ts";
import { ContainerApp, ContainerAppProvider } from "./ContainerApp.ts";
import {
  ContainerAppEnvironment,
  ContainerAppEnvironmentProvider,
} from "./ContainerAppEnvironment.ts";
import { ContainerImage, ContainerImageProvider } from "./ContainerImage.ts";
import { ContainerRegistry, ContainerRegistryProvider } from "./ContainerRegistry.ts";
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
} from "./MoreResources.ts";
import { ResourceGroup, ResourceGroupProvider } from "./ResourceGroup.ts";
import {
  ResourceProviderRegistration,
  ResourceProviderRegistrationProvider,
} from "./ResourceProviderRegistration.ts";
import { StorageAccount, StorageAccountProvider } from "./StorageAccount.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Azure") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export const providers = () =>
  Layer.effect(
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
    Layer.provide(AzureClientsLive),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(AzureAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
