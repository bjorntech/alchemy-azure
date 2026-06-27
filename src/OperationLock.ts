import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/**
 * Serializes Azure operations that share a control-plane scope.
 *
 * Some Azure mutations are serialized by the platform at a scope broader than
 * Alchemy's data-dependency graph can express. For example, an App Service plan
 * and every site on it share a "webspace" and cannot be modified concurrently
 * (`409 Cannot modify ... another operation is in progress`); a Container App
 * cannot be mutated while its managed environment is provisioning. Sibling
 * resources sharing such a scope have no data dependency on each other, so
 * ordering alone cannot prevent the conflict.
 *
 * This service models the real constraint directly: operations sharing a key
 * acquire an exclusive lock and run one at a time. It is process-local, which is
 * sufficient for a single Alchemy deploy; genuine cross-process / eventual
 * consistency races are a separate concern (handled by retry where needed).
 */
export interface AzureOperationLockShape {
  /**
   * Run `effect` while holding an exclusive lock for `key`. Effects sharing a
   * key never run concurrently. A nullish key runs without locking.
   */
  readonly withLock: <A, E, R>(
    key: string | undefined,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class AzureOperationLock extends Context.Service<AzureOperationLock, AzureOperationLockShape>()(
  "Azure.OperationLock",
) {}

/**
 * Live layer holding a registry of per-key single-permit semaphores. Semaphores
 * are created synchronously (`makeUnsafe`), so the get-or-create is a plain map
 * lookup with no race within a fiber step.
 */
export const AzureOperationLockLive = Layer.sync(AzureOperationLock, () => {
  const locks = new Map<string, Semaphore.Semaphore>();

  const getLock = (key: string) => {
    let lock = locks.get(key);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return lock;
  };

  const withLock = <A, E, R>(key: string | undefined, effect: Effect.Effect<A, E, R>) =>
    key === undefined ? effect : getLock(key).withPermits(1)(effect);

  return { withLock };
});

/** Stable lock key for the App Service "webspace" (plan + its sites in a group). */
export const appServiceScopeKey = (resourceGroupName: string) => `appservice:${resourceGroupName}`;

/** Stable lock key for a Container Apps managed environment (env + its apps). */
export const containerEnvironmentScopeKey = (resourceGroupName: string, environmentName: string) =>
  `containerenv:${resourceGroupName}:${environmentName}`;

/**
 * Parse the resource group and environment name out of a managed-environment
 * ARM id so a Container App can derive the same scope key as the environment.
 */
export const containerEnvironmentScopeKeyFromId = (environmentId: string): string | undefined => {
  const match =
    /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/managedEnvironments\/([^/]+)/i.exec(
      environmentId,
    );
  if (!match) return undefined;
  return containerEnvironmentScopeKey(match[1], match[2]);
};
