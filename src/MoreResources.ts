import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Resource, type ResourceClass } from "alchemy";
import * as Provider from "alchemy/Provider";
import type { AzureClientsShape } from "./Clients.ts";
import { makeAzureClients } from "./Clients.ts";
import { azureError, isNotFound } from "./Errors.ts";
import {
  collectAzurePages,
  makePhysicalNames,
  persistedLocation,
  requireLocation,
  resourceGroupName,
  resolveResourceValue,
  withHeartbeat,
  type NamedResourceGroup,
} from "./Internal.ts";
import { AzureOperationLock, appServiceScopeKey } from "./OperationLock.ts";
import type { Providers } from "./Providers.ts";
import { hasAlchemyTags, withAlchemyTags } from "./ResourceGroup.ts";
import type { StorageAccount } from "./StorageAccount.ts";
import { readStorageConnectionString } from "./StorageAccount.ts";

type Tags = Record<string, string>;
type AzureResponse = {
  id?: string;
  location?: string;
  name?: string;
  provisioningState?: string;
  tags?: Tags;
};

interface BaseProps {
  name?: string;
  resourceGroup: NamedResourceGroup;
  location?: string;
  tags?: Tags;
  delete?: boolean;
}

type Attrs<Extra extends object = {}> = Extra & {
  name: string;
  resourceGroupName: string;
  location: string;
  resourceId: string;
  provisioningState?: string;
  tags?: Tags;
};

function diffOnChanges<P, A extends Attrs>(options: {
  identity: (input: { id: string; instanceId: string; props: P; output: A }) =>
    | Effect.Effect<Record<string, unknown>, unknown, unknown>
    | Record<string, unknown>;
  replace?: (props: P) => unknown | Effect.Effect<unknown, unknown, unknown>;
  replaceChanged?: (olds: P, news: P) => boolean;
  mutable?: (props: P) => unknown | Effect.Effect<unknown, unknown, unknown>;
}) {
  return Effect.fnUntraced(function* (input: {
    id: string;
    instanceId: string;
    olds: P;
    news: Input<P>;
    output?: A;
  }) {
    const { id, instanceId, olds, news, output } = input;
    if (!isResolved(news)) return undefined;
    if (!output) return undefined;
    // diff only runs against an existing resource, so identity derives location
    // from the persisted output, never from the referenced group.
    const desiredIdentity = yield* asEffect(options.identity({ id, instanceId, props: news, output }));
    for (const [key, value] of Object.entries(desiredIdentity)) {
      if (value !== (output as Record<string, unknown>)[key]) return { action: "replace" } as const;
    }
    if (options.replace) {
      const before = yield* asEffect(options.replace(olds));
      const after = yield* asEffect(options.replace(news));
      if (!sameValue(before, after)) return { action: "replace" } as const;
    }
    if (options.replaceChanged?.(olds, news)) return { action: "replace" } as const;
    if (options.mutable) {
      const before = yield* asEffect(options.mutable(olds));
      const after = yield* asEffect(options.mutable(news));
      if (!sameValue(before, after)) return { action: "update" } as const;
    }
    return undefined;
  });
}

function resourceGroupIdentity<P extends { name?: string; resourceGroup: NamedResourceGroup; location?: string }>(
  nameOf: (id: string, instanceId: string, props: P) => string,
) {
  return ({ id, instanceId, props, output }: { id: string; instanceId: string; props: P; output: { location: string } }) =>
    Effect.gen(function* () {
      return {
        name: nameOf(id, instanceId, props),
        resourceGroupName: yield* resourceGroupName(props.resourceGroup),
        location: persistedLocation(props.location, output.location),
      };
    });
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function stableValue(value: unknown): unknown {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value;
}

function azurePromise<A>(operation: string, resource: string | undefined, try_: () => Promise<A>) {
  return Effect.tryPromise({
    try: try_,
    catch: (cause) => azureError({ operation, resource, cause }),
  });
}

function deleteIfEnabled(
  operation: () => Promise<unknown>,
  name: string,
  kind: string,
  // Provide a label only for genuinely slow deletes; omitting it keeps fast
  // deletes quiet so the console is not spammed.
  heartbeatLabel?: string,
) {
  return Effect.fnUntraced(function* (input: {
    olds?: { delete?: boolean };
    session: { note: (message: string) => Effect.Effect<unknown, unknown, never> };
  }) {
    const { olds, session } = input;
    if (olds?.delete === false) return;
    yield* session.note(`Deleting Azure ${kind}: ${name}`);
    const deletion = azurePromise(`delete ${kind}`, name, operation);
    yield* (heartbeatLabel ? deletion.pipe(withHeartbeat(heartbeatLabel)) : deletion).pipe(
      Effect.catchIf(isNotFound, () => Effect.void),
    );
  });
}

function waitForAzureDeleted(
  get: () => Promise<unknown>,
  name: string,
  kind: string,
  session: { note: (message: string) => Effect.Effect<unknown, unknown, never> },
) {
  return azurePromise(`read ${kind}`, name, get).pipe(
    Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
    Effect.flatMap((resource) =>
      resource === undefined
        ? Effect.void
        : session
            .note(`Waiting for Azure ${kind} deletion: ${name}`)
            .pipe(Effect.flatMap(() => Effect.fail(new AzureResourceStillExists(kind, name)))),
    ),
    Effect.retry({
      while: (error) => error instanceof AzureResourceStillExists,
      schedule: Schedule.fixed("5 seconds").pipe(Schedule.upTo({ times: 60 })),
    }),
  );
}

function retryAzureDependencyConflicts(
  session: { note: (message: string) => Effect.Effect<unknown, unknown, never> },
) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.retry({
        while: isDependencyConflict,
        schedule: Schedule.fixed("5 seconds").pipe(
          Schedule.upTo({ times: 60 }),
          Schedule.tap(({ attempt }) =>
            session.note(`Waiting for Azure dependencies to clear... (attempt ${attempt + 1})`),
          ),
        ),
      }),
    );
}

class AzureResourceStillExists extends Error {
  constructor(kind: string, name: string) {
    super(`Azure ${kind} still exists: ${name}`);
  }
}

function isDependencyConflict(error: unknown) {
  const data = error as { statusCode?: number; status?: number; code?: string; message?: string };
  const message = String(data.message ?? "").toLowerCase();
  const code = String(data.code ?? "").toLowerCase();
  return (
    data.statusCode === 409 ||
    data.status === 409 ||
    code.includes("inuse") ||
    code.includes("conflict") ||
    message.includes("in use") ||
    message.includes("being used") ||
    message.includes("cannot be deleted") ||
    message.includes("another operation is in progress")
  );
}

function ownershipAware<T extends object>(
  id: string,
  resource: { tags?: Tags },
  attrs: T,
  trusted = false,
): T {
  return (hasAlchemyTags(id, resource.tags) ? attrs : Unowned(attrs)) as T;
}

function ensureTaggedOwnership(
  id: string,
  kind: string,
  name: string,
  output: Attrs | undefined,
  olds: object | undefined,
  get: () => Promise<AzureResponse>,
) {
  return Effect.gen(function* () {
    if (!output || !olds) return;
    const existing = yield* azurePromise(`read ${kind} before update`, name, get).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
    );
    if (existing && hasAlchemyTags(id, output.tags) && !hasAlchemyTags(id, existing.tags)) {
      throw new Error(`Cannot adopt resource "${name}" without --adopt.`);
    }
  });
}

function redacted(value: string | undefined) {
  return value ? Redacted.make(value) : undefined;
}

function records(value: unknown): AzureResponse[] {
  return Array.isArray(value) ? (value as AzureResponse[]) : [];
}

function listResourceGroups(clients: { resources: { resourceGroups: { list: () => unknown } } }) {
  return azurePromise(
    "list resource groups",
    undefined,
    () => collectAzurePages(clients.resources.resourceGroups.list() as never) as Promise<AzureResponse[]>,
  );
}

function listOwnedByResourceGroup<T extends AzureResponse, A>(
  clients: { resources: { resourceGroups: { list: () => unknown } } },
  list: (resourceGroupName: string) => unknown,
  toAttributes: (resource: T, resourceGroupName: string) => A | Effect.Effect<A, unknown, never>,
) {
  return Effect.gen(function* () {
    const groups = yield* listResourceGroups(clients);
    const resources = yield* Effect.forEach(
      groups,
      (group) => {
        if (!group.name) return Effect.succeed([] as readonly (readonly [string, T])[]);
        return azurePromise(
          "list resources by resource group",
          group.name,
          () => collectAzurePages(list(group.name!) as never),
        ).pipe(
          Effect.map((items) => items.map((item) => [group.name!, item as T] as const)),
        );
      },
      { concurrency: 4 },
    );
    return yield* Effect.forEach(
      resources.flat().filter(([, resource]) => resource.tags?.["alchemy:logical-id"]),
      ([resourceGroupName, resource]) =>
        asEffect(toAttributes(resource, resourceGroupName)),
      { concurrency: 4 },
    );
  });
}

function listByResourceGroup<T extends AzureResponse>(
  clients: { resources: { resourceGroups: { list: () => unknown } } },
  list: (resourceGroupName: string) => unknown,
) {
  return Effect.gen(function* () {
    const groups = yield* listResourceGroups(clients);
    const resources = yield* Effect.forEach(
      groups,
      (group) => {
        if (!group.name) return Effect.succeed([] as readonly (readonly [string, T])[]);
        return azurePromise(
          "list resources by resource group",
          group.name,
          () => collectAzurePages(list(group.name!) as never),
        ).pipe(
          Effect.map((items) => items.map((item) => [group.name!, item as T] as const)),
        );
      },
      { concurrency: 4 },
    );
    return resources.flat();
  });
}

function asEffect<A>(value: A | Effect.Effect<A, unknown, unknown>) {
  return Effect.isEffect(value) ? value : Effect.succeed(value);
}

export interface UserAssignedIdentityProps extends BaseProps {}
export type UserAssignedIdentity = Resource<
  "Azure.UserAssignedIdentity",
  UserAssignedIdentityProps,
  Attrs<{ principalId?: string; clientId?: string; tenantId?: string }>,
  never,
  Providers
>;
export const UserAssignedIdentity = Resource<UserAssignedIdentity>("Azure.UserAssignedIdentity");
export const UserAssignedIdentityProvider = () =>
  Provider.effect(
    UserAssignedIdentity,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: UserAssignedIdentityProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 128 });
      return UserAssignedIdentity.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.msi.userAssignedIdentities.listByResourceGroup(rg),
            identityAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          mutable: (props) => ({ tags: props.tags }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const identity = yield* azurePromise("read user-assigned identity", name, () =>
            clients.msi.userAssignedIdentities.get(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return identity
            ? ownershipAware(id, identity, identityAttrs(identity, rg), !!output)
            : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          yield* ensureTaggedOwnership(id, "user-assigned identity", name, output, olds, () =>
            clients.msi.userAssignedIdentities.get(rg, name)
          );
          const identity = yield* azurePromise("reconcile user-assigned identity", name, () =>
            clients.msi.userAssignedIdentities.createOrUpdate(rg, name, {
              location,
              tags: withAlchemyTags(id, news.tags),
            }),
          );
          return identityAttrs(identity, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () => clients.msi.userAssignedIdentities.delete(output.resourceGroupName, output.name),
            output.name,
            "user-assigned identity",
          )({ olds, session });
        }),
      });
    }),
  );

function identityAttrs(identity: AzureResponse, resourceGroupName: string) {
  const data = identity as Record<string, unknown>;
  return {
    name: identity.name as string,
    resourceGroupName,
    location: identity.location as string,
    resourceId: identity.id as string,
    principalId: data.principalId as string | undefined,
    clientId: data.clientId as string | undefined,
    tenantId: data.tenantId as string | undefined,
    tags: identity.tags,
  } satisfies UserAssignedIdentity["Attributes"];
}

export interface VirtualNetworkProps extends BaseProps {
  addressSpace?: string[];
  subnets?: Array<{
    name: string;
    addressPrefix: string;
    delegations?: Array<{ name: string; serviceName: string }>;
  }>;
  dnsServers?: string[];
}
export type VirtualNetwork = Resource<
  "Azure.VirtualNetwork",
  VirtualNetworkProps,
  Attrs<{
    addressSpace: string[];
    subnets: Array<NonNullable<VirtualNetworkProps["subnets"]>[number] & { id: string }>;
    dnsServers?: string[];
  }>,
  never,
  Providers
>;
export const VirtualNetwork = Resource<VirtualNetwork>("Azure.VirtualNetwork");
export const VirtualNetworkProvider = () =>
  Provider.effect(
    VirtualNetwork,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: VirtualNetworkProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 64 });
      return VirtualNetwork.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.network.virtualNetworks.list(rg),
            virtualNetworkAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          mutable: (props) => ({
            addressSpace: props.addressSpace ?? ["10.0.0.0/16"],
            subnets: props.subnets ?? [{ name: "default", addressPrefix: "10.0.0.0/24" }],
            dnsServers: props.dnsServers,
            tags: props.tags,
          }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const vnet = yield* azurePromise("read virtual network", name, () =>
            clients.network.virtualNetworks.get(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return vnet
            ? ownershipAware(id, vnet, virtualNetworkAttrs(vnet, rg), !!output)
            : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          const addressPrefixes = news.addressSpace ?? ["10.0.0.0/16"];
          const subnets = news.subnets ?? [{ name: "default", addressPrefix: "10.0.0.0/24" }];
          yield* ensureTaggedOwnership(id, "virtual network", name, output, olds, () =>
            clients.network.virtualNetworks.get(rg, name)
          );
          const vnet = yield* azurePromise("reconcile virtual network", name, () =>
            clients.network.virtualNetworks.beginCreateOrUpdateAndWait(rg, name, {
              location,
              addressSpace: { addressPrefixes },
              dhcpOptions: news.dnsServers ? { dnsServers: news.dnsServers } : undefined,
              subnets: subnets.map((s) => ({
                name: s.name,
                addressPrefix: s.addressPrefix,
                delegations: s.delegations?.map((d) => ({
                  name: d.name,
                  serviceName: d.serviceName,
                })),
              })),
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<typeof clients.network.virtualNetworks.beginCreateOrUpdateAndWait>[2]),
          );
          return virtualNetworkAttrs(vnet, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () =>
              clients.network.virtualNetworks.beginDeleteAndWait(
                output.resourceGroupName,
                output.name,
              ),
            output.name,
            "virtual network",
          )({ olds, session });
        }),
      });
    }),
  );

function virtualNetworkAttrs(vnet: AzureResponse, resourceGroupName: string) {
  const data = vnet as Record<string, unknown>;
  const addressSpace = data.addressSpace as { addressPrefixes?: string[] } | undefined;
  const dhcpOptions = data.dhcpOptions as { dnsServers?: string[] } | undefined;
  return {
    name: vnet.name as string,
    resourceGroupName,
    location: vnet.location as string,
    resourceId: vnet.id as string,
    addressSpace: addressSpace?.addressPrefixes ?? [],
    subnets: records(data.subnets).map((s) => ({
      name: s.name as string,
      id: s.id as string,
      addressPrefix: (s as Record<string, unknown>).addressPrefix as string,
    })),
    dnsServers: dhcpOptions?.dnsServers,
    provisioningState: vnet.provisioningState,
    tags: vnet.tags,
  } satisfies VirtualNetwork["Attributes"];
}

/** Resolve a named subnet ARM id from a VirtualNetwork output. */
export function subnetId(network: VirtualNetwork, name: string) {
  return Output.map(network.subnets, (subnets) => {
    const subnet = subnets.find((item) => item.name === name);
    if (!subnet) {
      throw new Error(`Virtual network has no subnet named "${name}".`);
    }
    return subnet.id;
  });
}

export interface SecurityRule {
  name: string;
  priority: number;
  direction: "Inbound" | "Outbound";
  access: "Allow" | "Deny";
  protocol: "Tcp" | "Udp" | "Icmp" | "Esp" | "Ah" | "*";
  sourceAddressPrefix?: string;
  sourcePortRange?: string;
  destinationAddressPrefix?: string;
  destinationPortRange?: string;
  description?: string;
}
export interface NetworkSecurityGroupProps extends BaseProps {
  securityRules?: SecurityRule[];
}
export type NetworkSecurityGroup = Resource<
  "Azure.NetworkSecurityGroup",
  NetworkSecurityGroupProps,
  Attrs<{ securityRules: SecurityRule[] }>,
  never,
  Providers
>;
export const NetworkSecurityGroup = Resource<NetworkSecurityGroup>("Azure.NetworkSecurityGroup");
export const NetworkSecurityGroupProvider = () =>
  Provider.effect(
    NetworkSecurityGroup,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: NetworkSecurityGroupProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 80 });
      return NetworkSecurityGroup.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.network.networkSecurityGroups.list(rg),
            nsgAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          mutable: (props) => ({ securityRules: props.securityRules ?? [], tags: props.tags }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const nsg = yield* azurePromise("read network security group", name, () =>
            clients.network.networkSecurityGroups.get(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return nsg ? ownershipAware(id, nsg, nsgAttrs(nsg, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          yield* ensureTaggedOwnership(id, "network security group", name, output, olds, () =>
            clients.network.networkSecurityGroups.get(rg, name)
          );
          const nsg = yield* azurePromise("reconcile network security group", name, () =>
            clients.network.networkSecurityGroups.beginCreateOrUpdateAndWait(rg, name, {
              location,
              securityRules: (news.securityRules ?? []).map(toSecurityRule),
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<
              typeof clients.network.networkSecurityGroups.beginCreateOrUpdateAndWait
            >[2]),
          );
          return nsgAttrs(nsg, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () =>
              clients.network.networkSecurityGroups.beginDeleteAndWait(
                output.resourceGroupName,
                output.name,
              ),
            output.name,
            "network security group",
          )({ olds, session });
        }),
      });
    }),
  );

const toSecurityRule = (r: SecurityRule) => ({
  name: r.name,
  priority: r.priority,
  direction: r.direction,
  access: r.access,
  protocol: r.protocol,
  sourceAddressPrefix: r.sourceAddressPrefix ?? "*",
  sourcePortRange: r.sourcePortRange ?? "*",
  destinationAddressPrefix: r.destinationAddressPrefix ?? "*",
  destinationPortRange: r.destinationPortRange ?? "*",
  description: r.description,
});
function nsgAttrs(nsg: AzureResponse, resourceGroupName: string) {
  const data = nsg as Record<string, unknown>;
  return {
    name: nsg.name as string,
    resourceGroupName,
    location: nsg.location as string,
    resourceId: nsg.id as string,
    securityRules: records(data.securityRules).map((r) => {
      const rule = r as Record<string, unknown>;
      return {
        name: r.name as string,
        priority: rule.priority as number,
        direction: rule.direction as SecurityRule["direction"],
        access: rule.access as SecurityRule["access"],
        protocol: rule.protocol as SecurityRule["protocol"],
        sourceAddressPrefix: rule.sourceAddressPrefix as string | undefined,
        sourcePortRange: rule.sourcePortRange as string | undefined,
        destinationAddressPrefix: rule.destinationAddressPrefix as string | undefined,
        destinationPortRange: rule.destinationPortRange as string | undefined,
        description: rule.description as string | undefined,
      };
    }),
    provisioningState: nsg.provisioningState,
    tags: nsg.tags,
  } satisfies NetworkSecurityGroup["Attributes"];
}

export interface PublicIPAddressProps extends BaseProps {
  sku?: "Basic" | "Standard";
  allocationMethod?: "Static" | "Dynamic";
  ipVersion?: "IPv4" | "IPv6";
  domainNameLabel?: string;
  idleTimeoutInMinutes?: number;
  zones?: string[];
}
export type PublicIPAddress = Resource<
  "Azure.PublicIPAddress",
  PublicIPAddressProps,
  Attrs<{ ipAddress?: string; fqdn?: string }>,
  never,
  Providers
>;
export const PublicIPAddress = Resource<PublicIPAddress>("Azure.PublicIPAddress");
export const PublicIPAddressProvider = () =>
  Provider.effect(
    PublicIPAddress,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: PublicIPAddressProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 80 });
      return PublicIPAddress.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.network.publicIPAddresses.list(rg),
            publicIpAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          mutable: (props) => {
            const sku = props.sku ?? "Basic";
            return {
              domainNameLabel: props.domainNameLabel,
              idleTimeoutInMinutes: props.idleTimeoutInMinutes ?? 4,
              tags: props.tags,
            };
          },
          replace: (props) => {
            const sku = props.sku ?? "Basic";
            return {
              sku,
              allocationMethod: props.allocationMethod ?? (sku === "Standard" ? "Static" : "Dynamic"),
              ipVersion: props.ipVersion ?? "IPv4",
              zones: props.zones,
            };
          },
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const ip = yield* azurePromise("read public IP address", name, () =>
            clients.network.publicIPAddresses.get(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return ip ? ownershipAware(id, ip, publicIpAttrs(ip, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          const skuName = news.sku ?? "Basic";
          yield* ensureTaggedOwnership(id, "public IP address", name, output, olds, () =>
            clients.network.publicIPAddresses.get(rg, name)
          );
          const ip = yield* azurePromise("reconcile public IP address", name, () =>
            clients.network.publicIPAddresses.beginCreateOrUpdateAndWait(rg, name, {
              location,
              sku: { name: skuName },
              publicIPAllocationMethod:
                news.allocationMethod ?? (skuName === "Standard" ? "Static" : "Dynamic"),
              publicIPAddressVersion: news.ipVersion ?? "IPv4",
              dnsSettings: news.domainNameLabel
                ? { domainNameLabel: news.domainNameLabel }
                : undefined,
              idleTimeoutInMinutes: news.idleTimeoutInMinutes ?? 4,
              zones: news.zones,
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<
              typeof clients.network.publicIPAddresses.beginCreateOrUpdateAndWait
            >[2]),
          );
          return publicIpAttrs(ip, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () =>
              clients.network.publicIPAddresses.beginDeleteAndWait(
                output.resourceGroupName,
                output.name,
              ),
            output.name,
            "public IP address",
          )({ olds, session });
        }),
      });
    }),
  );
function publicIpAttrs(ip: AzureResponse, resourceGroupName: string) {
  const data = ip as Record<string, unknown>;
  const dnsSettings = data.dnsSettings as { fqdn?: string } | undefined;
  return {
    name: ip.name as string,
    resourceGroupName,
    location: ip.location as string,
    resourceId: ip.id as string,
    ipAddress: data.ipAddress as string | undefined,
    fqdn: dnsSettings?.fqdn,
    provisioningState: ip.provisioningState,
    tags: ip.tags,
  } satisfies PublicIPAddress["Attributes"];
}

export interface CognitiveServicesProps extends BaseProps {
  kind?: string;
  sku?: string;
  publicNetworkAccess?: boolean;
  customSubDomain?: string;
  networkAcls?: {
    defaultAction?: "Allow" | "Deny";
    ipRules?: string[];
    virtualNetworkRules?: string[];
  };
}
export type CognitiveServices = Resource<
  "Azure.CognitiveServices",
  CognitiveServicesProps,
  Attrs<{
    kind: string;
    sku: string;
    endpoint?: string;
    primaryKey?: Redacted.Redacted<string>;
    secondaryKey?: Redacted.Redacted<string>;
  }>,
  never,
  Providers
>;
export const CognitiveServices = Resource<CognitiveServices>("Azure.CognitiveServices");
export const CognitiveServicesProvider = () =>
  Provider.effect(
    CognitiveServices,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: CognitiveServicesProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 64 });
      return CognitiveServices.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.cognitiveServices.accounts.listByResourceGroup(rg),
            cognitiveAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          replace: (props) => ({
            kind: props.kind ?? "CognitiveServices",
            customSubDomain: props.customSubDomain,
          }),
          mutable: (props) => ({
            sku: props.sku ?? "S0",
            publicNetworkAccess: props.publicNetworkAccess !== false,
            networkAcls: props.networkAcls,
            tags: props.tags,
          }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const a = yield* azurePromise("read Cognitive Services account", name, () =>
            clients.cognitiveServices.accounts.get(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return a ? ownershipAware(id, a, yield* cognitiveAttrs(a, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          yield* ensureTaggedOwnership(id, "Cognitive Services account", name, output, olds, () =>
            clients.cognitiveServices.accounts.get(rg, name)
          );
          const account = yield* azurePromise("reconcile Cognitive Services account", name, () =>
            clients.cognitiveServices.accounts.beginCreateAndWait(rg, name, {
              location,
              kind: news.kind ?? "CognitiveServices",
              sku: { name: news.sku ?? "S0" },
              properties: {
                customSubDomainName: news.customSubDomain,
                publicNetworkAccess: news.publicNetworkAccess === false ? "Disabled" : "Enabled",
                networkAcls: news.networkAcls
                  ? {
                      defaultAction: news.networkAcls.defaultAction ?? "Allow",
                      ipRules: news.networkAcls.ipRules?.map((value) => ({ value })),
                      virtualNetworkRules: news.networkAcls.virtualNetworkRules?.map((id) => ({
                        id,
                      })),
                    }
                  : undefined,
              },
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<typeof clients.cognitiveServices.accounts.beginCreateAndWait>[2]),
          );
          return yield* cognitiveAttrs(account, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () =>
              clients.cognitiveServices.accounts.beginDeleteAndWait(
                output.resourceGroupName,
                output.name,
              ),
            output.name,
            "Cognitive Services account",
          )({ olds, session });
        }),
      });
      function cognitiveAttrs(account: AzureResponse, resourceGroupName: string) {
        return Effect.gen(function* () {
          const data = account as Record<string, unknown>;
          const properties = data.properties as
            | { endpoint?: string; provisioningState?: string }
            | undefined;
          const sku = data.sku as { name?: string } | undefined;
          const keys = yield* azurePromise("list Cognitive Services keys", account.name, () =>
            clients.cognitiveServices.accounts.listKeys(resourceGroupName, account.name as string),
          ).pipe(Effect.catch(() => Effect.succeed(undefined)));
          return {
            name: account.name as string,
            resourceGroupName,
            location: account.location as string,
            resourceId: account.id as string,
            kind: data.kind as string,
            sku: sku?.name as string,
            endpoint: properties?.endpoint,
            primaryKey: redacted(keys?.key1),
            secondaryKey: redacted(keys?.key2),
            provisioningState: properties?.provisioningState,
            tags: account.tags,
          } satisfies CognitiveServices["Attributes"];
        });
      }
    }),
  );

export interface ServiceBusProps extends BaseProps {
  sku?: "Basic" | "Standard" | "Premium";
  capacity?: number;
  zoneRedundant?: boolean;
  disableLocalAuth?: boolean;
}
export type ServiceBus = Resource<
  "Azure.ServiceBus",
  ServiceBusProps,
  Attrs<{
    sku: string;
    endpoint: string;
    primaryConnectionString?: Redacted.Redacted<string>;
    secondaryConnectionString?: Redacted.Redacted<string>;
    primaryKey?: Redacted.Redacted<string>;
    secondaryKey?: Redacted.Redacted<string>;
  }>,
  never,
  Providers
>;
export const ServiceBus = Resource<ServiceBus>("Azure.ServiceBus");
export const ServiceBusProvider = () =>
  Provider.effect(
    ServiceBus,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: ServiceBusProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 50, lowercase: true });
      return ServiceBus.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.serviceBus.namespaces.listByResourceGroup(rg),
            serviceBusAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          replace: (props) => ({
            sku: props.sku ?? "Standard",
            zoneRedundant: props.zoneRedundant ?? false,
          }),
          mutable: (props) => {
            const sku = props.sku ?? "Standard";
            return {
              capacity: sku === "Premium" ? (props.capacity ?? 1) : undefined,
              disableLocalAuth: props.disableLocalAuth,
              tags: props.tags,
            };
          },
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const ns = yield* azurePromise("read Service Bus namespace", name, () =>
            clients.serviceBus.namespaces.get(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return ns ? ownershipAware(id, ns, yield* serviceBusAttrs(ns, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          const sku = news.sku ?? "Standard";
          yield* ensureTaggedOwnership(id, "Service Bus namespace", name, output, olds, () =>
            clients.serviceBus.namespaces.get(rg, name)
          );
          const ns = yield* azurePromise("reconcile Service Bus namespace", name, () =>
            clients.serviceBus.namespaces.beginCreateOrUpdateAndWait(rg, name, {
              location,
              sku: {
                name: sku,
                tier: sku,
                capacity: sku === "Premium" ? (news.capacity ?? 1) : undefined,
              },
              zoneRedundant: news.zoneRedundant,
              disableLocalAuth: news.disableLocalAuth,
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<typeof clients.serviceBus.namespaces.beginCreateOrUpdateAndWait>[2]),
          );
          return yield* serviceBusAttrs(ns, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () =>
              clients.serviceBus.namespaces.beginDeleteAndWait(
                output.resourceGroupName,
                output.name,
              ),
            output.name,
            "Service Bus namespace",
          )({ olds, session });
        }),
      });
      function serviceBusAttrs(ns: AzureResponse, resourceGroupName: string) {
        return Effect.gen(function* () {
          const data = ns as Record<string, unknown>;
          const sku = data.sku as { name?: string } | undefined;
          const keys = yield* azurePromise("list Service Bus keys", ns.name, () =>
            clients.serviceBus.namespaces.listKeys(
              resourceGroupName,
              ns.name as string,
              "RootManageSharedAccessKey",
            ),
          ).pipe(Effect.catch(() => Effect.succeed(undefined)));
          return {
            name: ns.name as string,
            resourceGroupName,
            location: ns.location as string,
            resourceId: ns.id as string,
            sku: sku?.name as string,
            endpoint: `https://${ns.name}.servicebus.windows.net`,
            primaryConnectionString: redacted(keys?.primaryConnectionString),
            secondaryConnectionString: redacted(keys?.secondaryConnectionString),
            primaryKey: redacted(keys?.primaryKey),
            secondaryKey: redacted(keys?.secondaryKey),
            provisioningState: ns.provisioningState,
            tags: ns.tags,
          } satisfies ServiceBus["Attributes"];
        });
      }
    }),
  );

export interface CosmosDBAccountProps extends BaseProps {
  kind?: string;
  defaultConsistencyLevel?: string;
  enableFreeTier?: boolean;
  locations?: Array<{ locationName: string; failoverPriority?: number; isZoneRedundant?: boolean }>;
}
export type CosmosDBAccount = Resource<
  "Azure.CosmosDBAccount",
  CosmosDBAccountProps,
  Attrs<{
    endpoint?: string;
    primaryKey?: Redacted.Redacted<string>;
    connectionString?: Redacted.Redacted<string>;
    kind?: string;
  }>,
  never,
  Providers
>;
export const CosmosDBAccount = Resource<CosmosDBAccount>("Azure.CosmosDBAccount");
export const CosmosDBAccountProvider = () =>
  Provider.effect(
    CosmosDBAccount,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: CosmosDBAccountProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 44, lowercase: true });
      return CosmosDBAccount.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.cosmosDB.databaseAccounts.listByResourceGroup(rg),
            cosmosAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          replace: (props) => ({
            kind: props.kind ?? "GlobalDocumentDB",
            enableFreeTier: props.enableFreeTier ?? false,
          }),
          mutable: (props) => ({
            defaultConsistencyLevel: props.defaultConsistencyLevel ?? "Session",
            locations: props.locations,
            tags: props.tags,
          }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const account = yield* azurePromise("read Cosmos DB account", name, () =>
            clients.cosmosDB.databaseAccounts.get(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return account
            ? ownershipAware(id, account, yield* cosmosAttrs(account, rg), !!output)
            : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          yield* ensureTaggedOwnership(id, "Cosmos DB account", name, output, olds, () =>
            clients.cosmosDB.databaseAccounts.get(rg, name)
          );
          const account = yield* azurePromise("reconcile Cosmos DB account", name, async () => {
            const poller = await clients.cosmosDB.databaseAccounts.beginCreateOrUpdate(rg, name, {
              location,
              kind: news.kind ?? "GlobalDocumentDB",
              databaseAccountOfferType: "Standard",
              consistencyPolicy: {
                defaultConsistencyLevel: news.defaultConsistencyLevel ?? "Session",
              },
              enableFreeTier: news.enableFreeTier,
              locations: news.locations ?? [{ locationName: location, failoverPriority: 0 }],
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<typeof clients.cosmosDB.databaseAccounts.beginCreateOrUpdate>[2]);
            await poller.pollUntilFinished();
            return clients.cosmosDB.databaseAccounts.get(rg, name);
          }).pipe(withHeartbeat(`Cosmos DB account "${name}"`));
          return yield* cosmosAttrs(account, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            async () => {
              const poller = await clients.cosmosDB.databaseAccounts.beginDeleteMethod(
                output.resourceGroupName,
                output.name,
              );
              return poller.pollUntilFinished();
            },
            output.name,
            "Cosmos DB account",
            `deleting Cosmos DB account "${output.name}"`,
          )({ olds, session });
        }),
      });
      function cosmosAttrs(account: AzureResponse, resourceGroupName: string) {
        return Effect.gen(function* () {
          const data = account as Record<string, unknown>;
          const keys = yield* azurePromise("list Cosmos DB keys", account.name, () =>
            clients.cosmosDB.databaseAccounts.listKeys(resourceGroupName, account.name as string),
          ).pipe(Effect.catch(() => Effect.succeed(undefined)));
          const primaryKey = keys?.primaryMasterKey;
          const endpoint = data.documentEndpoint as string | undefined;
          return {
            name: account.name as string,
            resourceGroupName,
            location: account.location as string,
            resourceId: account.id as string,
            endpoint,
            primaryKey: redacted(primaryKey),
            connectionString: primaryKey
              ? redacted(`AccountEndpoint=${endpoint};AccountKey=${primaryKey};`)
              : undefined,
            kind: data.kind as string | undefined,
            provisioningState: account.provisioningState,
            tags: account.tags,
          } satisfies CosmosDBAccount["Attributes"];
        });
      }
    }),
  );

export interface SqlServerProps extends BaseProps {
  administratorLogin: string;
  administratorLoginPassword: string | Redacted.Redacted<string>;
  version?: string;
  publicNetworkAccess?: boolean;
}
export type SqlServer = Resource<
  "Azure.SqlServer",
  SqlServerProps,
  Attrs<{ fullyQualifiedDomainName?: string; administratorLogin: string }>,
  never,
  Providers
>;
export const SqlServer = Resource<SqlServer>("Azure.SqlServer");
export const SqlServerProvider = () =>
  Provider.effect(
    SqlServer,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: SqlServerProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 63, lowercase: true });
      return SqlServer.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.sql.servers.listByResourceGroup(rg),
            (server, rg) => sqlServerAttrs(server, rg, (server as Record<string, unknown>).administratorLogin as string),
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          replace: (props) => ({
            administratorLogin: props.administratorLogin,
            version: props.version ?? "12.0",
          }),
          mutable: (props) => ({
            administratorLoginPassword: props.administratorLoginPassword,
            publicNetworkAccess: props.publicNetworkAccess !== false,
            tags: props.tags,
          }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const server = yield* azurePromise("read SQL server", name, () => clients.sql.servers.get(rg, name)).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          const administratorLogin = olds?.administratorLogin ?? server?.administratorLogin;
          return server
            ? ownershipAware(id, server, sqlServerAttrs(server, rg, administratorLogin), !!output)
            : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          yield* ensureTaggedOwnership(id, "SQL server", name, output, olds, () =>
            clients.sql.servers.get(rg, name)
          );
          const server = yield* azurePromise("reconcile SQL server", name, () =>
            clients.sql.servers.beginCreateOrUpdateAndWait(rg, name, {
              location,
              administratorLogin: news.administratorLogin,
              administratorLoginPassword:
                typeof news.administratorLoginPassword === "string"
                  ? news.administratorLoginPassword
                  : Redacted.value(news.administratorLoginPassword),
              version: news.version ?? "12.0",
              publicNetworkAccess: news.publicNetworkAccess === false ? "Disabled" : "Enabled",
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<typeof clients.sql.servers.beginCreateOrUpdateAndWait>[2]),
          ).pipe(withHeartbeat(`SQL server "${name}"`));
          return sqlServerAttrs(server, rg, news.administratorLogin);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () => clients.sql.servers.beginDeleteAndWait(output.resourceGroupName, output.name),
            output.name,
            "SQL server",
          )({ olds, session });
        }),
      });
    }),
  );
function sqlServerAttrs(
  server: AzureResponse,
  resourceGroupName: string,
  administratorLogin: string,
) {
  const data = server as Record<string, unknown>;
  return {
    name: server.name as string,
    resourceGroupName,
    location: server.location as string,
    resourceId: server.id as string,
    fullyQualifiedDomainName: data.fullyQualifiedDomainName as string | undefined,
    administratorLogin,
    provisioningState: data.state as string | undefined,
    tags: server.tags,
  } satisfies SqlServer["Attributes"];
}

export interface SqlDatabaseProps extends BaseProps {
  server: string | SqlServer;
  sku?: string;
  tier?: string;
  maxSizeBytes?: number;
  collation?: string;
}
export type SqlDatabase = Resource<
  "Azure.SqlDatabase",
  SqlDatabaseProps,
  Attrs<{ serverName: string; sku?: string; maxSizeBytes?: number }>,
  never,
  Providers
>;
export const SqlDatabase = Resource<SqlDatabase>("Azure.SqlDatabase");
export const SqlDatabaseProvider = () =>
  Provider.effect(
    SqlDatabase,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: SqlDatabaseProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 128 });
      const serverName = (server: string | SqlServer) =>
        typeof server === "string"
          ? Effect.succeed(server)
          : resolveResourceValue(server.name);
      return SqlDatabase.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId", "serverName"],
        list: () =>
          Effect.gen(function* () {
            const servers = yield* listByResourceGroup<AzureResponse>(
              clients,
              (rg) => clients.sql.servers.listByResourceGroup(rg),
            );
            const databases = yield* Effect.forEach(
              servers,
              ([resourceGroupName, server]) =>
                azurePromise("list SQL databases", server.name, () =>
                  collectAzurePages(
                    clients.sql.databases.listByServer(resourceGroupName, server.name as string) as never,
                  ),
                ).pipe(
                  Effect.map((items) =>
                    items.map(
                      (database) =>
                        [resourceGroupName, server.name as string, database as AzureResponse] as const,
                    ),
                  ),
                ),
              { concurrency: 4 },
            );
            return databases
              .flat()
              .filter(([, , database]) => database.tags?.["alchemy:logical-id"])
              .map(([rg, serverName, database]) => sqlDbAttrs(database as AzureResponse, rg, serverName));
          }),
        diff: diffOnChanges({
          identity: ({ id, instanceId, props, output }) =>
            Effect.gen(function* () {
              return {
                name: nameOf(id, instanceId, props),
                resourceGroupName: yield* resourceGroupName(props.resourceGroup),
                location: persistedLocation(props.location, output.location),
                serverName: yield* serverName(props.server),
              };
            }),
          replace: (props) => ({ collation: props.collation }),
          mutable: (props) => ({
            sku: props.sku,
            tier: props.tier,
            maxSizeBytes: props.maxSizeBytes,
            tags: props.tags,
          }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          const sn = output?.serverName ?? (yield* serverName(olds!.server));
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const db = yield* azurePromise("read SQL database", name, () => clients.sql.databases.get(rg, sn, name)).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          return db ? ownershipAware(id, db, sqlDbAttrs(db, rg, sn), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const sn = yield* serverName(news.server);
          const name = nameOf(id, instanceId, news);
          yield* ensureTaggedOwnership(id, "SQL database", name, output, olds, () =>
            clients.sql.databases.get(rg, sn, name)
          );
          const db = yield* azurePromise("reconcile SQL database", name, () =>
            clients.sql.databases.beginCreateOrUpdateAndWait(rg, sn, name, {
              location,
              sku: news.sku ? { name: news.sku, tier: news.tier } : undefined,
              maxSizeBytes: news.maxSizeBytes,
              collation: news.collation,
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<typeof clients.sql.databases.beginCreateOrUpdateAndWait>[3]),
          );
          return sqlDbAttrs(db, rg, sn);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () =>
              clients.sql.databases.beginDeleteAndWait(
                output.resourceGroupName,
                output.serverName,
                output.name,
              ),
            output.name,
            "SQL database",
          )({ olds, session });
        }),
      });
    }),
  );
function sqlDbAttrs(db: AzureResponse, resourceGroupName: string, serverName: string) {
  const data = db as Record<string, unknown>;
  const sku = data.sku as { name?: string } | undefined;
  return {
    name: db.name as string,
    resourceGroupName,
    location: db.location as string,
    resourceId: db.id as string,
    serverName,
    sku: sku?.name,
    maxSizeBytes: data.maxSizeBytes as number | undefined,
    provisioningState: data.status as string | undefined,
    tags: db.tags,
  } satisfies SqlDatabase["Attributes"];
}

export interface KeyVaultProps extends BaseProps {
  tenantId?: string;
  sku?: "standard" | "premium";
  accessPolicies?: unknown[];
  enableRbacAuthorization?: boolean;
  enableSoftDelete?: boolean;
  softDeleteRetentionInDays?: number;
  publicNetworkAccess?: boolean;
}
export type KeyVault = Resource<
  "Azure.KeyVault",
  KeyVaultProps,
  Attrs<{ vaultUri?: string; sku?: string }>,
  never,
  Providers
>;
export const KeyVault = Resource<KeyVault>("Azure.KeyVault");
export const KeyVaultProvider = () =>
  Provider.effect(
    KeyVault,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: KeyVaultProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 24, lowercase: true });
      return KeyVault.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.keyVault.vaults.listByResourceGroup(rg),
            keyVaultAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          replace: (props) => ({
            sku: props.sku ?? "standard",
            enableSoftDelete: props.enableSoftDelete ?? true,
            softDeleteRetentionInDays: props.softDeleteRetentionInDays ?? 90,
          }),
          replaceChanged: (olds, news) => olds.tenantId !== news.tenantId,
          mutable: (props) => ({
            accessPolicies: props.accessPolicies ?? [],
            enableRbacAuthorization: props.enableRbacAuthorization,
            publicNetworkAccess: props.publicNetworkAccess !== false,
            tags: props.tags,
          }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const vault = yield* azurePromise("read Key Vault", name, () => clients.keyVault.vaults.get(rg, name)).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          return vault ? ownershipAware(id, vault, keyVaultAttrs(vault, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          const tenantId = news.tenantId ?? clients.tenantId;
          if (!tenantId) throw new Error(`KeyVault ${id} requires tenantId.`);
          yield* ensureTaggedOwnership(id, "Key Vault", name, output, olds, () =>
            clients.keyVault.vaults.get(rg, name)
          );
          const vault = yield* azurePromise("reconcile Key Vault", name, () =>
            clients.keyVault.vaults.beginCreateOrUpdateAndWait(rg, name, {
              location,
              properties: {
                tenantId,
                sku: { family: "A", name: news.sku ?? "standard" },
                accessPolicies: news.accessPolicies ?? [],
                enableRbacAuthorization: news.enableRbacAuthorization,
                enableSoftDelete: news.enableSoftDelete ?? true,
                softDeleteRetentionInDays: news.softDeleteRetentionInDays,
                publicNetworkAccess: news.publicNetworkAccess === false ? "Disabled" : "Enabled",
              },
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<typeof clients.keyVault.vaults.beginCreateOrUpdateAndWait>[2]),
          );
          return keyVaultAttrs(vault, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () => clients.keyVault.vaults.delete(output.resourceGroupName, output.name),
            output.name,
            "Key Vault",
          )({ olds, session });
        }),
      });
    }),
  );
function keyVaultAttrs(vault: AzureResponse, resourceGroupName: string) {
  const data = vault as Record<string, unknown>;
  const properties = data.properties as
    | { provisioningState?: string; sku?: { name?: string }; vaultUri?: string }
    | undefined;
  return {
    name: vault.name as string,
    resourceGroupName,
    location: vault.location as string,
    resourceId: vault.id as string,
    vaultUri: properties?.vaultUri,
    sku: properties?.sku?.name,
    provisioningState: properties?.provisioningState,
    tags: vault.tags,
  } satisfies KeyVault["Attributes"];
}

export interface AppServicePlanProps extends BaseProps {
  sku?: string;
  tier?: string;
  capacity?: number;
  reserved?: boolean;
  kind?: string;
}
export type AppServicePlan = Resource<
  "Azure.AppServicePlan",
  AppServicePlanProps,
  Attrs<{ serverFarmId: string; sku?: string; tier?: string; capacity?: number; reserved?: boolean }>,
  never,
  Providers
>;
export const AppServicePlan = Resource<AppServicePlan>("Azure.AppServicePlan");
export const AppServicePlanProvider = () =>
  Provider.effect(
    AppServicePlan,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const lock = yield* AzureOperationLock;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: AppServicePlanProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 40, lowercase: true });
      return AppServicePlan.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId", "serverFarmId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.appService.appServicePlans.listByResourceGroup(rg),
            appServicePlanAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          replace: (props) => ({
            reserved: props.reserved ?? false,
            kind: props.kind,
          }),
          mutable: (props) => {
            const sku = props.sku ?? "B1";
            return {
              sku,
              tier: props.tier ?? skuTier(sku),
              capacity: props.capacity ?? 1,
              tags: props.tags,
            };
          },
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const plan = yield* azurePromise("read App Service plan", name, () => clients.appService.appServicePlans.get(rg, name)).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          return plan ? ownershipAware(id, plan, appServicePlanAttrs(plan, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          const sku = news.sku ?? "B1";
          yield* ensureTaggedOwnership(id, "App Service plan", name, output, olds, () =>
            clients.appService.appServicePlans.get(rg, name)
          );
          // Serialize against sites in the same App Service webspace.
          const plan = yield* lock.withLock(
            appServiceScopeKey(rg),
            azurePromise("reconcile App Service plan", name, () =>
              clients.appService.appServicePlans.beginCreateOrUpdateAndWait(rg, name, {
                location,
                kind: news.kind,
                reserved: news.reserved ?? false,
                sku: {
                  name: sku,
                  tier: news.tier ?? skuTier(sku),
                  capacity: news.capacity ?? 1,
                },
                tags: withAlchemyTags(id, news.tags),
              } as Parameters<typeof clients.appService.appServicePlans.beginCreateOrUpdateAndWait>[2]),
            ),
          );
          return appServicePlanAttrs(plan, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () => clients.appService.appServicePlans.delete(output.resourceGroupName, output.name),
            output.name,
            "App Service plan",
          )({ olds, session });
        }),
      });
    }),
  );

function skuTier(sku: string) {
  if (sku.startsWith("F")) return "Free";
  if (sku.startsWith("B")) return "Basic";
  if (sku.startsWith("S")) return "Standard";
  if (sku.startsWith("P")) return "PremiumV3";
  if (sku.startsWith("Y")) return "Dynamic";
  return undefined;
}

function appServicePlanAttrs(plan: AzureResponse, resourceGroupName: string) {
  const data = plan as Record<string, unknown>;
  const sku = data.sku as { name?: string; tier?: string; capacity?: number } | undefined;
  return {
    name: plan.name as string,
    resourceGroupName,
    location: plan.location as string,
    resourceId: plan.id as string,
    serverFarmId: plan.id as string,
    sku: sku?.name,
    tier: sku?.tier,
    capacity: sku?.capacity,
    reserved: data.reserved as boolean | undefined,
    provisioningState: data.provisioningState as string | undefined,
    tags: plan.tags,
  } satisfies AppServicePlan["Attributes"];
}

export interface AppServiceProps extends BaseProps {
  serverFarmId: string | AppServicePlan;
  httpsOnly?: boolean;
  appSettings?: Record<string, string>;
  kind?: string;
}
export type AppService = Resource<
  "Azure.AppService",
  AppServiceProps,
  Attrs<{ defaultHostName?: string; url?: string }>,
  never,
  Providers
>;
export const AppService = Resource<AppService>("Azure.AppService");
export const AppServiceProvider = () => webAppProvider(AppService, "Azure.AppService", false);

export interface FunctionAppProps extends AppServiceProps {
  storageAccount: string | StorageAccount;
  functionsVersion?: string;
}
export type FunctionApp = Resource<
  "Azure.FunctionApp",
  FunctionAppProps,
  Attrs<{ defaultHostName?: string; url?: string }>,
  never,
  Providers
>;
export const FunctionApp = Resource<FunctionApp>("Azure.FunctionApp");
export const FunctionAppProvider = () => webAppProvider(FunctionApp, "Azure.FunctionApp", true);

function webAppProvider(
  resource: typeof AppService | typeof FunctionApp,
  type: string,
  isFunction: boolean,
) {
  const webAppResource = resource as ResourceClass<AppService | FunctionApp>;
  return Provider.effect(
    webAppResource,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const lock = yield* AzureOperationLock;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: AppServiceProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 60, lowercase: true });
      return webAppResource.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listByResourceGroup<AzureResponse>(
            clients,
            (rg) => clients.appService.webApps.listByResourceGroup(rg),
          ).pipe(
            Effect.map((apps) =>
              apps
                .filter(([, app]) => app.tags?.["alchemy:logical-id"])
                .filter(([, app]) => {
                  const kind = (app as Record<string, unknown>).kind as string | undefined;
                  return isFunction ? kind?.includes("functionapp") : !kind?.includes("functionapp");
                })
                .map(([rg, app]) => webAppAttrs(app, rg)),
            ),
          ),
        diff: diffOnChanges({
          identity: ({ id, instanceId, props, output }) =>
            Effect.gen(function* () {
              return {
                name: nameOf(id, instanceId, props),
                resourceGroupName: yield* resourceGroupName(props.resourceGroup),
                location: persistedLocation(props.location, output.location),
              };
            }),
          // Resolve cross-resource references to their stable scalar identity
          // before comparison. Comparing the whole-resource reference objects
          // serializes inconsistently under alchemy beta.58 (stripped on update)
          // and produced spurious replaces/updates.
          replace: (props) =>
            Effect.gen(function* () {
              return {
                serverFarmId: yield* resolveServerFarmId(props.serverFarmId),
                kind: props.kind ?? (isFunction ? "functionapp" : "app"),
              };
            }),
          mutable: (props) =>
            Effect.gen(function* () {
              return {
                httpsOnly: props.httpsOnly ?? true,
                appSettings: props.appSettings ?? {},
                storageAccount: isFunction
                  ? yield* resolveStorageAccountIdentity((props as FunctionAppProps).storageAccount)
                  : undefined,
                functionsVersion: isFunction ? ((props as FunctionAppProps).functionsVersion ?? "~4") : undefined,
                tags: props.tags,
              };
            }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const app = yield* azurePromise("read web app", name, () => clients.appService.webApps.get(rg, name)).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          return app ? ownershipAware(id, app, webAppAttrs(app, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          const serverFarmId = yield* resolveServerFarmId(news.serverFarmId);
          yield* ensureTaggedOwnership(id, type, name, output, olds, () =>
            clients.appService.webApps.get(rg, name)
          );
          const appSettings = { ...news.appSettings };
          if (isFunction) {
            const fn = news as FunctionAppProps;
            const storageConnectionString = yield* resolveStorageConnectionString(clients, fn.storageAccount);
            appSettings.AzureWebJobsStorage = storageConnectionString;
            appSettings.WEBSITE_CONTENTAZUREFILECONNECTIONSTRING = storageConnectionString;
            appSettings.FUNCTIONS_EXTENSION_VERSION = fn.functionsVersion ?? "~4";
            appSettings.FUNCTIONS_WORKER_RUNTIME = appSettings.FUNCTIONS_WORKER_RUNTIME ?? "node";
          }
          // Serialize all operations in the App Service webspace (plan + its
          // sites); Azure rejects concurrent site/plan mutations in one webspace.
          const app = yield* lock.withLock(
            appServiceScopeKey(rg),
            azurePromise("reconcile web app", name, () =>
              clients.appService.webApps.beginCreateOrUpdateAndWait(rg, name, {
                location,
                serverFarmId,
                httpsOnly: news.httpsOnly ?? true,
                kind: news.kind ?? (isFunction ? "functionapp" : "app"),
                siteConfig: {
                  appSettings: Object.entries(appSettings).map(([name, value]) => ({
                    name,
                    value,
                  })),
                },
                tags: withAlchemyTags(id, news.tags),
              } as Parameters<typeof clients.appService.webApps.beginCreateOrUpdateAndWait>[2]),
            ),
          );
          return webAppAttrs(app, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () => clients.appService.webApps.delete(output.resourceGroupName, output.name),
            output.name,
            type,
          )({ olds, session });
        }),
      });
    }),
  );
}

function resolveServerFarmId(serverFarmId: string | AppServicePlan) {
  return typeof serverFarmId === "string"
    ? Effect.succeed(serverFarmId)
    : resolveResourceValue(serverFarmId.serverFarmId);
}

/**
 * Resolve a storage account reference to its stable name for diff comparison.
 * Used only as an identity fingerprint, so it relies on the stable `name`
 * attribute rather than re-reading secrets.
 */
function resolveStorageAccountIdentity(
  storageAccount: string | StorageAccount | undefined,
): Effect.Effect<string | undefined, unknown, unknown> {
  if (!storageAccount) return Effect.succeed(undefined);
  if (typeof storageAccount === "string") return Effect.succeed(storageAccount);
  return resolveResourceValue(storageAccount.name);
}

function resolveStorageConnectionString(
  clients: AzureClientsShape,
  storageAccount: string | StorageAccount,
): Effect.Effect<string, unknown, unknown> {
  if (typeof storageAccount === "string") return Effect.succeed(storageAccount);
  // Re-read the connection string live from the storage account's stable
  // identity rather than dereferencing the non-stable secret attribute off the
  // reference, which is stripped on update under alchemy beta.58.
  return readStorageConnectionString(clients, storageAccount);
}
function webAppAttrs(app: AzureResponse, resourceGroupName: string) {
  const data = app as Record<string, unknown>;
  return {
    name: app.name as string,
    resourceGroupName,
    location: app.location as string,
    resourceId: app.id as string,
    defaultHostName: data.defaultHostName as string | undefined,
    url: data.defaultHostName ? `https://${data.defaultHostName}` : undefined,
    provisioningState: data.state as string | undefined,
    tags: app.tags,
  };
}

export interface StaticWebAppProps extends BaseProps {
  sku?: string;
  repositoryUrl?: string;
  branch?: string;
  appLocation?: string;
  apiLocation?: string;
  outputLocation?: string;
  appSettings?: Record<string, string>;
}
export type StaticWebApp = Resource<
  "Azure.StaticWebApp",
  StaticWebAppProps,
  Attrs<{ defaultHostname?: string; url?: string }>,
  never,
  Providers
>;
export const StaticWebApp = Resource<StaticWebApp>("Azure.StaticWebApp");
export const StaticWebAppProvider = () =>
  Provider.effect(
    StaticWebApp,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: StaticWebAppProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 60, lowercase: true });
      return StaticWebApp.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.appService.staticSites.listStaticSitesByResourceGroup(rg),
            staticSiteAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          replace: (props) => ({
            repositoryUrl: props.repositoryUrl,
            branch: props.branch,
            appLocation: props.appLocation,
            apiLocation: props.apiLocation,
            outputLocation: props.outputLocation,
          }),
          mutable: (props) => ({
            sku: props.sku ?? "Free",
            appSettings: props.appSettings ?? {},
            tags: props.tags,
          }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const site = yield* azurePromise("read Static Web App", name, () =>
            clients.appService.staticSites.getStaticSite(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return site ? ownershipAware(id, site, staticSiteAttrs(site, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          yield* ensureTaggedOwnership(id, "Static Web App", name, output, olds, () =>
            clients.appService.staticSites.getStaticSite(rg, name)
          );
          const site = yield* azurePromise("reconcile Static Web App", name, () =>
            clients.appService.staticSites.beginCreateOrUpdateStaticSiteAndWait(rg, name, {
              location,
              sku: { name: news.sku ?? "Free" },
              repositoryUrl: news.repositoryUrl,
              branch: news.branch,
              buildProperties: {
                appLocation: news.appLocation,
                apiLocation: news.apiLocation,
                appArtifactLocation: news.outputLocation,
              },
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<
              typeof clients.appService.staticSites.beginCreateOrUpdateStaticSiteAndWait
            >[2]),
          );
          if (news.appSettings) {
            yield* azurePromise("update Static Web App settings", name, () =>
              clients.appService.staticSites.createOrUpdateStaticSiteAppSettings(rg, name, {
                properties: news.appSettings,
              } as Parameters<
                typeof clients.appService.staticSites.createOrUpdateStaticSiteAppSettings
              >[2]),
            );
          }
          return staticSiteAttrs(site, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () =>
              clients.appService.staticSites.beginDeleteStaticSiteAndWait(
                output.resourceGroupName,
                output.name,
              ),
            output.name,
            "Static Web App",
          )({ olds, session });
        }),
      });
    }),
  );
function staticSiteAttrs(site: AzureResponse, resourceGroupName: string) {
  const data = site as Record<string, unknown>;
  return {
    name: site.name as string,
    resourceGroupName,
    location: site.location as string,
    resourceId: site.id as string,
    defaultHostname: data.defaultHostname as string | undefined,
    url: data.defaultHostname ? `https://${data.defaultHostname}` : undefined,
    provisioningState: site.provisioningState,
    tags: site.tags,
  } satisfies StaticWebApp["Attributes"];
}

export interface ContainerInstanceProps extends BaseProps {
  image: string;
  cpu?: number;
  memoryInGB?: number;
  ports?: Array<{ port: number; protocol?: "TCP" | "UDP" }>;
  environmentVariables?: Record<string, string>;
  restartPolicy?: "Always" | "Never" | "OnFailure";
  osType?: "Linux" | "Windows";
}
export type ContainerInstance = Resource<
  "Azure.ContainerInstance",
  ContainerInstanceProps,
  Attrs<{ fqdn?: string; ipAddress?: string }>,
  never,
  Providers
>;
export const ContainerInstance = Resource<ContainerInstance>("Azure.ContainerInstance");
export const ContainerInstanceProvider = () =>
  Provider.effect(
    ContainerInstance,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: ContainerInstanceProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 63, lowercase: true });
      return ContainerInstance.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.containerInstance.containerGroups.listByResourceGroup(rg),
            containerAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          replace: (props) => ({
            image: props.image,
            cpu: props.cpu ?? 1,
            memoryInGB: props.memoryInGB ?? 1.5,
            ports: props.ports ?? [{ port: 80, protocol: "TCP" }],
            environmentVariables: props.environmentVariables ?? {},
            restartPolicy: props.restartPolicy ?? "Always",
            osType: props.osType ?? "Linux",
          }),
          mutable: (props) => ({
            tags: props.tags,
          }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const group = yield* azurePromise("read container instance", name, () =>
            clients.containerInstance.containerGroups.get(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return group ? ownershipAware(id, group, containerAttrs(group, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          const ports = news.ports ?? [{ port: 80, protocol: "TCP" }];
          yield* ensureTaggedOwnership(id, "container instance", name, output, olds, () =>
            clients.containerInstance.containerGroups.get(rg, name)
          );
          const group = yield* azurePromise("reconcile container instance", name, () =>
            clients.containerInstance.containerGroups.beginCreateOrUpdateAndWait(rg, name, {
              location,
              osType: news.osType ?? "Linux",
              restartPolicy: news.restartPolicy ?? "Always",
              containers: [
                {
                  name,
                  image: news.image,
                  resources: {
                    requests: { cpu: news.cpu ?? 1, memoryInGB: news.memoryInGB ?? 1.5 },
                  },
                  ports,
                  environmentVariables: Object.entries(news.environmentVariables ?? {}).map(
                    ([name, value]) => ({ name, value }),
                  ),
                },
              ],
              ipAddress: { type: "Public", ports },
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<
              typeof clients.containerInstance.containerGroups.beginCreateOrUpdateAndWait
            >[2]),
          );
          return containerAttrs(group, rg);
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          yield* deleteIfEnabled(
            () =>
              clients.containerInstance.containerGroups.beginDeleteAndWait(
                output.resourceGroupName,
                output.name,
              ),
            output.name,
            "container instance",
          )({ olds, session });
        }),
      });
    }),
  );
function containerAttrs(group: AzureResponse, resourceGroupName: string) {
  const data = group as Record<string, unknown>;
  const ipAddress = data.ipAddress as { fqdn?: string; ip?: string } | undefined;
  return {
    name: group.name as string,
    resourceGroupName,
    location: group.location as string,
    resourceId: group.id as string,
    fqdn: ipAddress?.fqdn,
    ipAddress: ipAddress?.ip,
    provisioningState: group.provisioningState,
    tags: group.tags,
  } satisfies ContainerInstance["Attributes"];
}

export interface VirtualMachineProps extends BaseProps {
  adminUsername: string;
  adminPassword?: string | Redacted.Redacted<string>;
  sshPublicKey?: string;
  vmSize?: string;
  image?: { publisher: string; offer: string; sku: string; version?: string };
  subnetId?: string;
  /** Public IP object or ARM id to attach to the VM's managed NIC. */
  publicIPAddress?: string | PublicIPAddress;
  /** Network Security Group object or ARM id to attach to the VM's managed NIC. */
  networkSecurityGroup?: string | NetworkSecurityGroup;
  /** Enable IP forwarding on the VM's managed NIC. Useful for SIP/RTP gateways. */
  enableIPForwarding?: boolean;
  /** Cloud-init/custom data. Plain text is accepted and base64-encoded for Azure. */
  customData?: string;
}
export type VirtualMachine = Resource<
  "Azure.VirtualMachine",
  VirtualMachineProps,
  Attrs<{
    vmId?: string;
    networkInterfaceId?: string;
    privateIpAddress?: string;
    publicIpAddress?: string;
    publicFqdn?: string;
  }>,
  never,
  Providers
>;
export const VirtualMachine = Resource<VirtualMachine>("Azure.VirtualMachine");
export const VirtualMachineProvider = () =>
  Provider.effect(
    VirtualMachine,
    Effect.gen(function* () {
      const clients = yield* makeAzureClients;
      const names = yield* makePhysicalNames;
      const nameOf = (id: string, instanceId: string, props: VirtualMachineProps) =>
        names.physicalName(id, instanceId, props.name, { maxLength: 64 });
      return VirtualMachine.Provider.of({
        stables: ["name", "resourceGroupName", "resourceId"],
        list: () =>
          listOwnedByResourceGroup(
            clients,
            (rg) => clients.compute.virtualMachines.list(rg),
            vmAttrs,
          ),
        diff: diffOnChanges({
          identity: resourceGroupIdentity(nameOf),
          replace: (props) =>
            Effect.gen(function* () {
              return {
                adminUsername: props.adminUsername,
                adminPassword: props.adminPassword,
                sshPublicKey: props.sshPublicKey,
                customData: props.customData,
                image: props.image ?? {
                  publisher: "Canonical",
                  offer: "0001-com-ubuntu-server-jammy",
                  sku: "22_04-lts",
                  version: "latest",
                },
                subnetId: props.subnetId,
                publicIPAddressId: yield* resolvePublicIPAddressId(props.publicIPAddress),
                networkSecurityGroupId: yield* resolveNetworkSecurityGroupId(props.networkSecurityGroup),
              };
            }),
          mutable: (props) => ({
            vmSize: props.vmSize ?? "Standard_B1s",
            enableIPForwarding: props.enableIPForwarding ?? false,
            tags: props.tags,
          }),
        }),
        read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
          if (!output && !olds) return undefined;
          const rg = output?.resourceGroupName ?? (yield* resourceGroupName(olds!.resourceGroup));
          if (!rg) return undefined;
          const name = output?.name ?? nameOf(id, instanceId, olds!);
          const vm = yield* azurePromise("read virtual machine", name, () =>
            clients.compute.virtualMachines.get(rg, name),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          return vm ? ownershipAware(id, vm, vmAttrs(vm, rg), !!output) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, instanceId, olds, news, output }) {
          if (!news.subnetId)
            throw new Error(`VirtualMachine ${id} requires subnetId in the external v2 provider.`);
          const rg = yield* resourceGroupName(news.resourceGroup);
          const location = output
            ? persistedLocation(news.location, output.location)
            : yield* requireLocation(id, news.location, news.resourceGroup);
          const name = nameOf(id, instanceId, news);
          const nicName = `${name}-nic`;
          const networkInterfaceId = `/subscriptions/${clients.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/networkInterfaces/${nicName}`;
          const publicIPAddressId = yield* resolvePublicIPAddressId(news.publicIPAddress);
          const networkSecurityGroupId = yield* resolveNetworkSecurityGroupId(news.networkSecurityGroup);
          yield* ensureTaggedOwnership(id, "virtual machine", name, output, olds, () =>
            clients.compute.virtualMachines.get(rg, name)
          );
          const nic = yield* azurePromise("reconcile virtual machine network interface", nicName, () =>
            clients.network.networkInterfaces.beginCreateOrUpdateAndWait(rg, nicName, {
              location,
              enableIPForwarding: news.enableIPForwarding ?? false,
              networkSecurityGroup: networkSecurityGroupId ? { id: networkSecurityGroupId } : undefined,
              ipConfigurations: [
                {
                  name: "ipconfig1",
                  subnet: { id: news.subnetId },
                  publicIPAddress: publicIPAddressId ? { id: publicIPAddressId } : undefined,
                  privateIPAllocationMethod: "Dynamic",
                },
              ],
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<
              typeof clients.network.networkInterfaces.beginCreateOrUpdateAndWait
            >[2]),
          );
          const image = news.image ?? {
            publisher: "Canonical",
            offer: "0001-com-ubuntu-server-jammy",
            sku: "22_04-lts",
            version: "latest",
          };
          const vm = yield* azurePromise("reconcile virtual machine", name, () =>
            clients.compute.virtualMachines.beginCreateOrUpdateAndWait(rg, name, {
              location,
              hardwareProfile: { vmSize: news.vmSize ?? "Standard_B1s" },
              storageProfile: { imageReference: image, osDisk: { createOption: "FromImage" } },
              osProfile: {
                computerName: name,
                adminUsername: news.adminUsername,
                adminPassword:
                  typeof news.adminPassword === "string"
                    ? news.adminPassword
                    : news.adminPassword
                  ? Redacted.value(news.adminPassword)
                      : undefined,
                customData: news.customData
                  ? Buffer.from(news.customData, "utf8").toString("base64")
                  : undefined,
                linuxConfiguration: news.sshPublicKey
                  ? {
                      disablePasswordAuthentication: true,
                      ssh: {
                        publicKeys: [
                          {
                            path: `/home/${news.adminUsername}/.ssh/authorized_keys`,
                            keyData: news.sshPublicKey,
                          },
                        ],
                      },
                    }
                  : undefined,
              },
              networkProfile: {
                networkInterfaces: [
                  {
                    id: networkInterfaceId,
                  },
                ],
              },
              tags: withAlchemyTags(id, news.tags),
            } as Parameters<typeof clients.compute.virtualMachines.beginCreateOrUpdateAndWait>[2]),
          ).pipe(withHeartbeat(`virtual machine "${name}"`));
          return vmAttrs(vm, rg, {
            networkInterfaceId,
            privateIpAddress: nicPrivateIpAddress(nic as AzureResponse),
            publicIpAddress: yield* resolvePublicIPAddress(news.publicIPAddress),
            publicFqdn: yield* resolvePublicFqdn(news.publicIPAddress),
          });
        }),
        delete: Effect.fnUntraced(function* ({ olds, output, session }) {
          if (olds?.delete === false) return;

          yield* session.note(`Deleting Azure virtual machine: ${output.name}`);
          yield* azurePromise("delete virtual machine", output.name, () =>
            clients.compute.virtualMachines.beginDeleteAndWait(output.resourceGroupName, output.name),
          ).pipe(
            withHeartbeat(`deleting virtual machine "${output.name}"`),
            Effect.catchIf(isNotFound, () => Effect.void),
          );
          yield* waitForAzureDeleted(
            () => clients.compute.virtualMachines.get(output.resourceGroupName, output.name),
            output.name,
            "virtual machine",
            session,
          );

          const nicName = `${output.name}-nic`;
          yield* session.note(`Deleting Azure network interface: ${nicName}`);
          yield* azurePromise("delete network interface", nicName, () =>
            clients.network.networkInterfaces.beginDeleteAndWait(output.resourceGroupName, nicName),
          ).pipe(
            retryAzureDependencyConflicts(session),
            Effect.catchIf(isNotFound, () => Effect.void),
          );
          yield* waitForAzureDeleted(
            () => clients.network.networkInterfaces.get(output.resourceGroupName, nicName),
            nicName,
            "network interface",
            session,
          );
        }),
      });
    }),
  );
function resolvePublicIPAddressId(publicIPAddress: string | PublicIPAddress | undefined) {
  if (!publicIPAddress) return Effect.succeed(undefined);
  if (typeof publicIPAddress === "string") return Effect.succeed(publicIPAddress);
  return resolveResourceValue(publicIPAddress.resourceId);
}

function resolvePublicIPAddress(publicIPAddress: string | PublicIPAddress | undefined) {
  if (!publicIPAddress || typeof publicIPAddress === "string") return Effect.succeed(undefined);
  return resolveResourceValue(publicIPAddress.ipAddress);
}

function resolvePublicFqdn(publicIPAddress: string | PublicIPAddress | undefined) {
  if (!publicIPAddress || typeof publicIPAddress === "string") return Effect.succeed(undefined);
  return resolveResourceValue(publicIPAddress.fqdn);
}

function resolveNetworkSecurityGroupId(networkSecurityGroup: string | NetworkSecurityGroup | undefined) {
  if (!networkSecurityGroup) return Effect.succeed(undefined);
  if (typeof networkSecurityGroup === "string") return Effect.succeed(networkSecurityGroup);
  return resolveResourceValue(networkSecurityGroup.resourceId);
}

function nicPrivateIpAddress(nic: AzureResponse) {
  const data = nic as Record<string, unknown>;
  const configs = records(data.ipConfigurations);
  return (configs[0] as Record<string, unknown> | undefined)?.privateIPAddress as string | undefined;
}

function vmAttrs(
  vm: AzureResponse,
  resourceGroupName: string,
  extras: Partial<Pick<VirtualMachine["Attributes"], "networkInterfaceId" | "privateIpAddress" | "publicIpAddress" | "publicFqdn">> = {},
) {
  const data = vm as Record<string, unknown>;
  const networkProfile = data.networkProfile as { networkInterfaces?: Array<{ id?: string }> } | undefined;
  return {
    name: vm.name as string,
    resourceGroupName,
    location: vm.location as string,
    resourceId: vm.id as string,
    vmId: data.vmId as string | undefined,
    networkInterfaceId: extras.networkInterfaceId ?? networkProfile?.networkInterfaces?.[0]?.id,
    privateIpAddress: extras.privateIpAddress,
    publicIpAddress: extras.publicIpAddress,
    publicFqdn: extras.publicFqdn,
    provisioningState: vm.provisioningState,
    tags: vm.tags,
  } satisfies VirtualMachine["Attributes"];
}
