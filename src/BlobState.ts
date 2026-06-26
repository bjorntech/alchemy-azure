import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { decodeFqn, encodeFqn } from "alchemy/FQN";
import {
  encodeState,
  reviveState,
  State,
  STATE_STORE_VERSION,
  StateStoreError,
  type ReplacedResourceState,
  type ResourceState,
  type StateService,
} from "alchemy/State";

export interface BlobStateProps {
  /**
   * Azure Storage account name.
   *
   * @default process.env.AZURE_STORAGE_ACCOUNT
   */
  accountName?: string;
  /**
   * Azure Storage account key.
   *
   * @default process.env.AZURE_STORAGE_KEY
   */
  accountKey?: string;
  /**
   * Blob container containing state objects.
   *
   * The container must already exist.
   *
   * @default "alchemy-state"
   */
  containerName?: string;
  /**
   * Blob key prefix. Use this to share one container across multiple stores.
   *
   * @default "alchemy/state"
   */
  prefix?: string;
}

export interface BlobStateContainer {
  getBlobClient(name: string): {
    delete(): Promise<unknown>;
    download(): Promise<{ readableStreamBody?: NodeJS.ReadableStream }>;
  };
  getBlockBlobClient(name: string): {
    upload(body: string, contentLength: number, options?: unknown): Promise<unknown>;
  };
  listBlobsFlat(options: { prefix: string }): AsyncIterable<{ name: string }>;
}

/**
 * Azure Blob Storage-backed Alchemy v2 state store.
 *
 * @example
 * ```ts
 * export default Alchemy.Stack(
 *   "MyApp",
 *   {
 *     providers: Azure.providers(),
 *     state: Azure.blobState({
 *       accountName: "mystorageaccount",
 *       accountKey: process.env.AZURE_STORAGE_KEY!,
 *       containerName: "alchemy-state",
 *     }),
 *   },
 *   Effect.gen(function* () {
 *     // resources...
 *   }),
 * );
 * ```
 */
export const blobState = (props: BlobStateProps = {}) =>
  Layer.effect(State, Effect.cached(makeBlobState(props)));

export const makeBlobState = (props: BlobStateProps = {}) =>
  Effect.gen(function* () {
    const accountName = props.accountName ?? process.env.AZURE_STORAGE_ACCOUNT;
    const accountKey = props.accountKey ?? process.env.AZURE_STORAGE_KEY;
    const containerName = props.containerName ?? "alchemy-state";
    const prefix = normalizePrefix(props.prefix ?? "alchemy/state");

    if (!accountName) {
      return missingBlobStateService("Azure Blob state requires accountName or AZURE_STORAGE_ACCOUNT.");
    }
    if (!accountKey) {
      return missingBlobStateService("Azure Blob state requires accountKey or AZURE_STORAGE_KEY.");
    }

    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const blob = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
    const container = blob.getContainerClient(containerName);

    return yield* makeBlobStateService(container, prefix);
  });

function missingBlobStateService(message: string): StateService {
  const fail = () => Effect.fail(new StateStoreError({ message }));
  return {
    id: "azure-blob",
    getVersion: fail,
    listStacks: fail,
    listStages: fail,
    list: fail,
    get: fail,
    getReplacedResources: fail,
    set: fail,
    delete: fail,
    deleteStack: fail,
    getOutput: fail,
    setOutput: fail,
  };
}

export const makeBlobStateService = (container: BlobStateContainer, prefix: string) =>
  Effect.gen(function* () {
    const normalizedPrefix = normalizePrefix(prefix);

    const run = <A>(thunk: () => Promise<A>) =>
      Effect.tryPromise({
        try: thunk,
        catch: (cause) =>
          new StateStoreError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause: cause instanceof Error ? cause : undefined,
          }),
      });

    const ignoreMissing = <A>(effect: Effect.Effect<A, StateStoreError>) =>
      effect.pipe(
        Effect.catchIf(
          (error) => isMissing(error.cause) || error.message.includes("404"),
          () => Effect.void,
        ),
      );

    const stackPrefix = (stack: string) => `${normalizedPrefix}${encodeSegment(stack)}/`;
    const stagePrefix = (stack: string, stage: string) =>
      `${stackPrefix(stack)}${encodeSegment(stage)}/`;
    const resourceBlob = (request: { stack: string; stage: string; fqn: string }) =>
      `${stagePrefix(request.stack, request.stage)}${encodeFqn(request.fqn)}.json`;
    const outputBlob = (request: { stack: string; stage: string }) =>
      `${stagePrefix(request.stack, request.stage)}__stack_output__.json`;

    const listBlobNames = (listPrefix: string) =>
      run(async () => {
        const names: string[] = [];
        for await (const item of container.listBlobsFlat({ prefix: listPrefix })) {
          names.push(item.name);
        }
        return names;
      });

    const listChildSegments = (listPrefix: string) =>
      listBlobNames(listPrefix).pipe(
        Effect.map((names) =>
          Array.from(
            new Set(
              names.flatMap((name) => {
                const rest = name.slice(listPrefix.length);
                const segment = rest.split("/")[0];
                return segment ? [decodeSegment(segment)] : [];
              }),
            ),
          ).sort(),
        ),
      );

    const service: StateService = {
      id: "azure-blob",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () => listChildSegments(normalizedPrefix),
      listStages: (stack) => listChildSegments(stackPrefix(stack)),
      list: (request) =>
        listBlobNames(stagePrefix(request.stack, request.stage)).pipe(
          Effect.map((names) =>
            names
              .filter((name) => name.endsWith(".json") && !name.endsWith("/__stack_output__.json"))
              .map((name) =>
                decodeFqn(
                  name
                    .slice(stagePrefix(request.stack, request.stage).length)
                    .replace(/\.json$/, ""),
                ),
              )
              .sort(),
          ),
        ),
      get: (request) =>
        run(async () => {
          const client = container.getBlobClient(resourceBlob(request));
          const response = await client.download();
          const text = await streamToString(response.readableStreamBody);
          return JSON.parse(text, reviveState) as ResourceState;
        }).pipe(
          Effect.catchIf(
            (error) => isMissing(error.cause) || error.message.includes("404"),
            () => Effect.succeed(undefined),
          ),
        ),
      getReplacedResources: Effect.fnUntraced(function* (request) {
        return (yield* Effect.all(
          (yield* service.list(request)).map((fqn) => service.get({ ...request, fqn })),
          { concurrency: "unbounded" },
        )).filter((state): state is ReplacedResourceState => state?.status === "replaced");
      }),
      set: (request) =>
        run(async () => {
          const body = JSON.stringify(encodeState(request.value), null, 2);
          await container
            .getBlockBlobClient(resourceBlob(request))
            .upload(body, Buffer.byteLength(body), {
              blobHTTPHeaders: { blobContentType: "application/json" },
            });
          return request.value;
        }),
      delete: (request) =>
        ignoreMissing(run(() => container.getBlobClient(resourceBlob(request)).delete())),
      getOutput: (request) =>
        run(async () => {
          const client = container.getBlobClient(outputBlob(request));
          const response = await client.download();
          const text = await streamToString(response.readableStreamBody);
          return JSON.parse(text, reviveState) as unknown;
        }).pipe(
          Effect.catchIf(
            (error) => isMissing(error.cause) || error.message.includes("404"),
            () => Effect.succeed(undefined),
          ),
        ),
      setOutput: (request) =>
        run(async () => {
          const body = JSON.stringify(encodeState(request.value as any), null, 2);
          await container
            .getBlockBlobClient(outputBlob(request))
            .upload(body, Buffer.byteLength(body), {
              blobHTTPHeaders: { blobContentType: "application/json" },
            });
          return request.value;
        }),
      deleteStack: ({ stack, stage }) =>
        listBlobNames(stage ? stagePrefix(stack, stage) : stackPrefix(stack)).pipe(
          Effect.flatMap((names) =>
            Effect.all(
              names.map((name) => ignoreMissing(run(() => container.getBlobClient(name).delete()))),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.asVoid,
        ),
    };

    return service;
  });

function normalizePrefix(prefix: string) {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? "" : `${trimmed}/`;
}

function encodeSegment(value: string) {
  return encodeURIComponent(value);
}

function decodeSegment(value: string) {
  return decodeURIComponent(value);
}

function isMissing(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    (("statusCode" in error && error.statusCode === 404) ||
      ("code" in error && error.code === "BlobNotFound"))
  );
}

async function streamToString(stream: NodeJS.ReadableStream | undefined) {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
