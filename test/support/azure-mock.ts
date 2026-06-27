import { AzureClients, type AzureClientsShape } from "../../src/Clients.ts";

/**
 * Stateful, in-memory stand-in for the Azure SDK client bundle.
 *
 * Each management namespace reads and writes a shared `Map`, so a full
 * `deploy` -> `read` -> `delete` lifecycle can be exercised end-to-end without
 * any network access. Only the namespaces used by the test suite are
 * implemented; touching an unimplemented client throws, which keeps the fake
 * honest about what is actually covered.
 */

export interface AzureRecord {
  id: string;
  name: string;
  location?: string;
  provisioningState?: string;
  tags?: Record<string, string>;
  [key: string]: unknown;
}

export interface AzureMock {
  records: Map<string, AzureRecord>;
  calls: string[];
  /** Seed a record so `read`/adoption paths can find pre-existing infrastructure. */
  seed: (key: string, record: Partial<AzureRecord> & { name: string }) => void;
  /** Seed a record by the same kind/resource-group/name tuple used by the fake clients. */
  seedKind: (kind: string, rg: string, record: Partial<AzureRecord> & { name: string }) => void;
  clients: AzureClientsShape;
}

const SUB = "00000000-0000-0000-0000-000000000000";

const notFound = (resource: string) =>
  Object.assign(new Error(`${resource} not found`), {
    statusCode: 404,
    code: "ResourceNotFound",
  });

const resourceId = (rg: string, kind: string, name: string) =>
  `/subscriptions/${SUB}/resourceGroups/${rg}/providers/${kind}/${name}`;

export const recordKey = (kind: string, rg: string, name: string) => `${kind}::${rg}::${name}`;

export function installAzureMock(): AzureMock {
  const records = new Map<string, AzureRecord>();
  const calls: string[] = [];

  const track = (label: string) => calls.push(label);

  const get = (kind: string, rg: string, name: string) => {
    track(`${kind}.get:${name}`);
    const found = records.get(recordKey(kind, rg, name));
    if (!found) throw notFound(`${kind} ${name}`);
    return found;
  };

  const put = (
    kind: string,
    rg: string,
    name: string,
    params: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    track(`${kind}.put:${name}`);
    const record: AzureRecord = {
      id: resourceId(rg, kind, name),
      name,
      provisioningState: "Succeeded",
      ...params,
      ...extra,
    };
    records.set(recordKey(kind, rg, name), record);
    return record;
  };

  const del = (kind: string, rg: string, name: string) => {
    track(`${kind}.delete:${name}`);
    if (!records.has(recordKey(kind, rg, name))) throw notFound(`${kind} ${name}`);
    records.delete(recordKey(kind, rg, name));
  };

  const listKind = (kind: string, rg?: string) => {
    track(`${kind}.list:${rg ?? "*"}`);
    return [...records.entries()]
      .filter(([key]) =>
        rg === undefined ? key.startsWith(`${kind}::`) : key.startsWith(`${kind}::${rg}::`),
      )
      .map(([, record]) => record);
  };

  const poller = <T>(value: T) => ({ pollUntilDone: async () => value });
  const finishingPoller = <T>(value: T) => ({ pollUntilFinished: async () => value });

  type Extra = (name: string, params: Record<string, unknown>, rg: string) => Record<string, unknown>;

  // Builder for the common (resourceGroup, name) lifecycle, parameterised by the
  // SDK method names each Azure client happens to use.
  const ns2 = (
    kind: string,
    opts: { get: string; create: string; del: string; extra?: Extra },
  ): Record<string, unknown> => ({
    [opts.get]: async (rg: string, name: string) => get(kind, rg, name),
    [opts.create]: async (rg: string, name: string, params: Record<string, unknown>) =>
      put(kind, rg, name, params, opts.extra?.(name, params, rg)),
    [opts.del]: async (rg: string, name: string) => del(kind, rg, name),
    listByResourceGroup: async (rg: string) => listKind(kind, rg),
    list: async (rg?: string) => listKind(kind, rg),
  });

  // Builder for (resourceGroup, parent, name) lifecycles (CDN endpoints, SQL DBs).
  const ns3 = (
    kind: string,
    opts: { get: string; create: string; del: string; extra?: Extra },
  ): Record<string, unknown> => ({
    [opts.get]: async (rg: string, parent: string, name: string) =>
      get(kind, `${rg}/${parent}`, name),
    [opts.create]: async (
      rg: string,
      parent: string,
      name: string,
      params: Record<string, unknown>,
    ) => put(kind, `${rg}/${parent}`, name, params, opts.extra?.(name, params, `${rg}/${parent}`)),
    [opts.del]: async (rg: string, parent: string, name: string) =>
      del(kind, `${rg}/${parent}`, name),
    listByProfile: async (rg: string, parent: string) => listKind(kind, `${rg}/${parent}`),
    listByServer: async (rg: string, parent: string) => listKind(kind, `${rg}/${parent}`),
    list: async (rg: string, parent: string) => listKind(kind, `${rg}/${parent}`),
  });

  const networkNamespace = (kind: string) =>
    ns2(kind, {
      get: "get",
      create: "beginCreateOrUpdateAndWait",
      del: "beginDeleteAndWait",
      extra: (name, params, rg) => {
        if (kind === "virtualNetworks") {
          return {
            subnets: ((params.subnets as Array<Record<string, unknown>> | undefined) ?? []).map((subnet) => ({
              ...subnet,
              id: `${resourceId(rg, "virtualNetworks", name)}/subnets/${subnet.name}`,
            })),
          };
        }
        if (kind === "networkInterfaces") {
          return {
            ipConfigurations: ((params.ipConfigurations as Array<Record<string, unknown>> | undefined) ?? []).map(
              (config) => ({ ...config, privateIPAddress: "10.0.0.4" }),
            ),
          };
        }
        return {};
      },
    });

  const implemented = {
    resources: {
      resourceGroups: {
        list: async () => listKind("resourceGroups"),
        get: async (name: string) => get("resourceGroups", "", name),
        createOrUpdate: async (name: string, params: Record<string, unknown>) =>
          put("resourceGroups", "", name, params, {
            properties: { provisioningState: "Succeeded" },
          }),
        beginDelete: async (name: string) => {
          track(`resourceGroups.delete:${name}`);
          records.delete(recordKey("resourceGroups", "", name));
          return poller(undefined as void);
        },
      },
      providers: {
        list: async () => listKind("resourceProviders"),
        get: async (namespace: string) => {
          track(`resourceProviders.get:${namespace}`);
          return records.get(recordKey("resourceProviders", "", namespace)) ?? {
            id: `/subscriptions/${SUB}/providers/${namespace}`,
            namespace,
            registrationState: "NotRegistered",
          };
        },
        register: async (namespace: string) => {
          track(`resourceProviders.register:${namespace}`);
          const record: AzureRecord = {
            id: `/subscriptions/${SUB}/providers/${namespace}`,
            name: namespace,
            namespace,
            registrationState: "Registered",
          };
          records.set(recordKey("resourceProviders", "", namespace), record);
          return record;
        },
        unregister: async (namespace: string) => {
          track(`resourceProviders.unregister:${namespace}`);
          const record: AzureRecord = {
            id: `/subscriptions/${SUB}/providers/${namespace}`,
            name: namespace,
            namespace,
            registrationState: "NotRegistered",
          };
          records.set(recordKey("resourceProviders", "", namespace), record);
          return record;
        },
      },
    },
    storage: {
      storageAccounts: {
        listByResourceGroup: async (rg: string) => listKind("storageAccounts", rg),
        getProperties: async (rg: string, name: string) => get("storageAccounts", rg, name),
        beginCreate: async (rg: string, name: string, params: Record<string, unknown>) =>
          poller(
            put("storageAccounts", rg, name, params, {
              primaryEndpoints: { blob: `https://${name}.blob.core.windows.net/` },
            }),
          ),
        listKeys: async (rg: string, name: string) => {
          track(`storageAccounts.listKeys:${name}`);
          return { keys: [{ keyName: "key1", value: "fake-account-key" }] };
        },
        delete: async (rg: string, name: string) => del("storageAccounts", rg, name),
      },
      // These methods intentionally dereference `this` (via `this._kind`) to mirror
      // the real Azure SDK, whose operations read `this.client`. Detaching a method
      // (e.g. `const write = blobContainers.create; write(...)`) loses the binding and
      // throws, so the BlobContainer reconcile path must call them as methods. This
      // guards against the regression where `blobContainers.update` was aliased and
      // invoked unbound, breaking live `this.client` access.
      blobContainers: {
        _kind: "blobContainers" as const,
        get(rg: string, account: string, name: string) {
          return Promise.resolve(get(this._kind, `${rg}/${account}`, name));
        },
        create(
          rg: string,
          account: string,
          name: string,
          params: Record<string, unknown>,
        ) {
          return Promise.resolve(put(this._kind, `${rg}/${account}`, name, params));
        },
        delete(rg: string, account: string, name: string) {
          return Promise.resolve(del(this._kind, `${rg}/${account}`, name));
        },
        list(rg: string, account: string) {
          return Promise.resolve(listKind(this._kind, `${rg}/${account}`));
        },
      },
    },
    msi: {
      userAssignedIdentities: {
        listByResourceGroup: async (rg: string) => listKind("userAssignedIdentities", rg),
        get: async (rg: string, name: string) => get("userAssignedIdentities", rg, name),
        createOrUpdate: async (rg: string, name: string, params: Record<string, unknown>) =>
          put("userAssignedIdentities", rg, name, params, {
            principalId: "principal-id",
            clientId: "client-id",
            tenantId: "tenant-id",
          }),
        delete: async (rg: string, name: string) => del("userAssignedIdentities", rg, name),
      },
    },
    network: {
      virtualNetworks: networkNamespace("virtualNetworks"),
      networkSecurityGroups: networkNamespace("networkSecurityGroups"),
      networkInterfaces: networkNamespace("networkInterfaces"),
      publicIPAddresses: ns2("publicIPAddresses", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "beginDeleteAndWait",
        extra: (_name, params) => {
          const dnsSettings = params.dnsSettings as { domainNameLabel?: string } | undefined;
          return {
            ipAddress: "20.0.0.1",
            dnsSettings: dnsSettings
              ? { ...dnsSettings, fqdn: `${dnsSettings.domainNameLabel}.westeurope.cloudapp.azure.com` }
              : undefined,
          };
        },
      }),
    },
    cognitiveServices: {
      accounts: {
        ...ns2("cognitiveAccounts", {
          get: "get",
          create: "beginCreateAndWait",
          del: "beginDeleteAndWait",
          extra: (name, params) => ({
            properties: {
              ...(params.properties as Record<string, unknown>),
              endpoint: `https://${name}.cognitiveservices.azure.com/`,
              provisioningState: "Succeeded",
            },
          }),
        }),
        listKeys: async (rg: string, name: string) => {
          track(`cognitiveAccounts.listKeys:${name}`);
          return { key1: "cog-key-1", key2: "cog-key-2" };
        },
      },
    },
    serviceBus: {
      namespaces: {
        ...ns2("serviceBusNamespaces", {
          get: "get",
          create: "beginCreateOrUpdateAndWait",
          del: "beginDeleteAndWait",
        }),
        listKeys: async (rg: string, name: string) => {
          track(`serviceBusNamespaces.listKeys:${name}`);
          return {
            primaryConnectionString: "Endpoint=sb://primary",
            secondaryConnectionString: "Endpoint=sb://secondary",
            primaryKey: "sb-primary-key",
            secondaryKey: "sb-secondary-key",
          };
        },
      },
    },
    cosmosDB: {
      databaseAccounts: {
        listByResourceGroup: async (rg: string) => listKind("cosmosAccounts", rg),
        get: async (rg: string, name: string) => get("cosmosAccounts", rg, name),
        beginCreateOrUpdate: async (rg: string, name: string, params: Record<string, unknown>) => {
          put("cosmosAccounts", rg, name, params, {
            documentEndpoint: `https://${name}.documents.azure.com:443/`,
          });
          return finishingPoller(undefined as void);
        },
        beginDeleteMethod: async (rg: string, name: string) => {
          del("cosmosAccounts", rg, name);
          return finishingPoller(undefined as void);
        },
        listKeys: async (rg: string, name: string) => {
          track(`cosmosAccounts.listKeys:${name}`);
          return { primaryMasterKey: "cosmos-primary-key" };
        },
      },
    },
    sql: {
      servers: ns2("sqlServers", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "beginDeleteAndWait",
        extra: (name) => ({
          fullyQualifiedDomainName: `${name}.database.windows.net`,
          state: "Ready",
        }),
      }),
      databases: ns3("sqlDatabases", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "beginDeleteAndWait",
        extra: () => ({ status: "Online" }),
      }),
    },
    keyVault: {
      vaults: ns2("keyVaults", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "delete",
        extra: (name, params) => ({
          properties: {
            ...(params.properties as Record<string, unknown>),
            vaultUri: `https://${name}.vault.azure.net/`,
            provisioningState: "Succeeded",
          },
        }),
      }),
    },
    appService: {
      appServicePlans: ns2("appServicePlans", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "delete",
      }),
      webApps: ns2("webApps", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "delete",
        extra: (name) => ({ defaultHostName: `${name}.azurewebsites.net`, state: "Running" }),
      }),
      staticSites: {
        getStaticSite: async (rg: string, name: string) => get("staticSites", rg, name),
        listStaticSitesByResourceGroup: async (rg: string) => listKind("staticSites", rg),
        beginCreateOrUpdateStaticSiteAndWait: async (
          rg: string,
          name: string,
          params: Record<string, unknown>,
        ) => put("staticSites", rg, name, params, { defaultHostname: `${name}.azurestaticapps.net` }),
        createOrUpdateStaticSiteAppSettings: async (
          rg: string,
          name: string,
          params: Record<string, unknown>,
        ) => {
          track(`staticSites.appSettings:${name}`);
          return params;
        },
        beginDeleteStaticSiteAndWait: async (rg: string, name: string) =>
          del("staticSites", rg, name),
      },
    },
    containerInstance: {
      containerGroups: ns2("containerGroups", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "beginDeleteAndWait",
        extra: (name) => ({
          ipAddress: { type: "Public", ip: "20.1.2.3", fqdn: `${name}.westeurope.azurecontainer.io` },
        }),
      }),
    },
    compute: {
      virtualMachines: ns2("virtualMachines", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "beginDeleteAndWait",
        extra: () => ({ vmId: "11111111-2222-3333-4444-555555555555" }),
      }),
    },
    containerRegistry: {
      registries: {
        ...ns2("registries", {
          get: "get",
          create: "beginCreateAndWait",
          del: "beginDeleteAndWait",
          extra: (name) => ({ loginServer: `${name}.azurecr.io` }),
        }),
        listCredentials: async (rg: string, name: string) => {
          track(`registries.listCredentials:${name}`);
          return {
            username: "registryadmin",
            passwords: [
              { name: "password", value: "registry-password" },
              { name: "password2", value: "registry-password2" },
            ],
          };
        },
      },
    },
    appContainers: {
      managedEnvironments: ns2("managedEnvironments", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "beginDeleteAndWait",
        extra: (name) => ({
          defaultDomain: `${name}.westeurope.azurecontainerapps.io`,
          staticIp: "20.4.5.6",
        }),
      }),
      containerApps: ns2("containerApps", {
        get: "get",
        create: "beginCreateOrUpdateAndWait",
        del: "beginDeleteAndWait",
        extra: (name, params) => ({
          latestRevisionName: `${name}--rev1`,
          configuration: params.configuration,
          template: params.template,
        }),
      }),
    },
    subscriptionId: SUB,
    tenantId: "tenant-id",
  };

  const clients = new Proxy(implemented as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      throw new Error(`Azure client namespace "${prop}" is not implemented in the test mock.`);
    },
  }) as unknown as AzureClientsShape;

  return {
    records,
    calls,
    seed: (key, record) =>
      records.set(key, { id: `seeded/${record.name}`, provisioningState: "Succeeded", ...record }),
    seedKind: (kind, rg, record) =>
      records.set(recordKey(kind, rg, record.name), {
        id: resourceId(rg, kind, record.name),
        provisioningState: "Succeeded",
        ...record,
      }),
    clients,
  };
}

export { AzureClients };
