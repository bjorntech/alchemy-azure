import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { ReplacedResourceState, ResourceState } from "alchemy/State";
import { makeBlobState, makeBlobStateService, type BlobStateContainer } from "../src/BlobState.ts";

describe("Azure Blob state", () => {
  test("fails clearly when account name is missing", async () => {
    const state = await Effect.runPromise(makeBlobState({ accountKey: "key" }));
    await expect(Effect.runPromise(state.listStacks())).rejects.toThrow(
      "Azure Blob state requires accountName or AZURE_STORAGE_ACCOUNT.",
    );
  });

  test("fails clearly when account key is missing", async () => {
    const state = await Effect.runPromise(makeBlobState({ accountName: "account" }));
    await expect(Effect.runPromise(state.listStacks())).rejects.toThrow(
      "Azure Blob state requires accountKey or AZURE_STORAGE_KEY.",
    );
  });

  test("round-trips resources and lists stacks, stages, and fqns", async () => {
    const container = new MemoryBlobContainer();
    const state = await Effect.runPromise(makeBlobStateService(container, "/custom/prefix/"));
    const created = resourceState("Bucket", "created");

    const saved = await Effect.runPromise(
      state.set({ stack: "Stack A", stage: "dev/test", fqn: "Namespace/Bucket", value: created }),
    );
    const got = await Effect.runPromise(
      state.get({ stack: "Stack A", stage: "dev/test", fqn: "Namespace/Bucket" }),
    );
    const stacks = await Effect.runPromise(state.listStacks());
    const stages = await Effect.runPromise(state.listStages("Stack A"));
    const fqns = await Effect.runPromise(state.list({ stack: "Stack A", stage: "dev/test" }));

    expect(saved).toEqual(created);
    expect(got).toEqual(created);
    expect(stacks).toEqual(["Stack A"]);
    expect(stages).toEqual(["dev/test"]);
    expect(fqns).toEqual(["Namespace/Bucket"]);
  });

  test("returns undefined for missing resources and ignores missing deletes", async () => {
    const state = await Effect.runPromise(makeBlobStateService(new MemoryBlobContainer(), "state"));

    const missing = await Effect.runPromise(
      state.get({ stack: "Stack", stage: "dev", fqn: "Missing" }),
    );
    await Effect.runPromise(state.delete({ stack: "Stack", stage: "dev", fqn: "Missing" }));

    expect(missing).toBeUndefined();
  });

  test("filters replaced resources and deletes stages or stacks", async () => {
    const state = await Effect.runPromise(makeBlobStateService(new MemoryBlobContainer(), "state"));
    const active = resourceState("Active", "created");
    const replaced = replacedResourceState("Old");

    await Effect.runPromise(
      state.set({ stack: "Stack", stage: "dev", fqn: "Active", value: active }),
    );
    await Effect.runPromise(
      state.set({ stack: "Stack", stage: "dev", fqn: "Old", value: replaced }),
    );
    await Effect.runPromise(
      state.set({
        stack: "Stack",
        stage: "prod",
        fqn: "Keep",
        value: resourceState("Keep", "created"),
      }),
    );

    const replacedResources = await Effect.runPromise(
      state.getReplacedResources({ stack: "Stack", stage: "dev" }),
    );
    await Effect.runPromise(state.deleteStack({ stack: "Stack", stage: "dev" }));
    const devAfterDelete = await Effect.runPromise(state.list({ stack: "Stack", stage: "dev" }));
    const prodAfterDelete = await Effect.runPromise(state.list({ stack: "Stack", stage: "prod" }));
    await Effect.runPromise(state.deleteStack({ stack: "Stack" }));
    const stacksAfterDelete = await Effect.runPromise(state.listStacks());

    expect(replacedResources).toEqual([replaced]);
    expect(devAfterDelete).toEqual([]);
    expect(prodAfterDelete).toEqual(["Keep"]);
    expect(stacksAfterDelete).toEqual([]);
  });
});

class MemoryBlobContainer implements BlobStateContainer {
  private blobs = new Map<string, string>();

  getBlobClient(name: string) {
    return {
      delete: async () => {
        if (!this.blobs.delete(name)) throw notFound();
      },
      download: async () => {
        const body = this.blobs.get(name);
        if (body === undefined) throw notFound();
        return { readableStreamBody: Readable.from([body]) };
      },
    };
  }

  getBlockBlobClient(name: string) {
    return {
      upload: async (body: string) => {
        this.blobs.set(name, body);
      },
    };
  }

  async *listBlobsFlat(options: { prefix: string }) {
    for (const name of this.blobs.keys()) {
      if (name.startsWith(options.prefix)) yield { name };
    }
  }
}

function notFound() {
  return Object.assign(new Error("BlobNotFound"), { statusCode: 404, code: "BlobNotFound" });
}

function resourceState(id: string, status: "created" | "replaced") {
  return {
    id,
    fqn: id,
    kind: "Test.Resource",
    props: { name: id },
    output: { name: id },
    status,
  } as unknown as ResourceState;
}

function replacedResourceState(id: string) {
  return {
    id,
    fqn: id,
    kind: "Test.Resource",
    props: { name: id },
    attr: { name: id },
    old: resourceState(`${id}-old`, "created"),
    deleteFirst: false,
    status: "replaced",
  } as unknown as ReplacedResourceState;
}
