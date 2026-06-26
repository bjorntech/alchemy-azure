import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  azureError,
  AzureError,
  isAlreadyExists,
  isAzureError,
  isNotFound,
} from "../src/Errors.ts";

describe("AzureError", () => {
  test("wraps Azure SDK errors with statusCode and code", () => {
    const sdkError = Object.assign(new Error("Storage account not found"), {
      statusCode: 404,
      code: "ResourceNotFound",
    });

    const wrapped = azureError({
      operation: "reconcile storage account",
      resource: "mystorage",
      cause: sdkError,
    });

    expect(wrapped).toBeInstanceOf(AzureError);
    expect(wrapped._tag).toBe("AzureError");
    expect(wrapped.statusCode).toBe(404);
    expect(wrapped.code).toBe("ResourceNotFound");
    expect(wrapped.operation).toBe("reconcile storage account");
    expect(wrapped.resource).toBe("mystorage");
    expect(wrapped.message).toBe(
      'Failed to reconcile storage account "mystorage": Storage account not found',
    );
    expect(wrapped.cause).toBe(sdkError);
  });

  test("wraps plain errors without statusCode/code", () => {
    const wrapped = azureError({ operation: "fetch keys", cause: new Error("network down") });

    expect(wrapped.statusCode).toBeUndefined();
    expect(wrapped.code).toBeUndefined();
    expect(wrapped.message).toBe("Failed to fetch keys: network down");
  });

  test("isNotFound recognizes both AzureError and raw SDK errors", () => {
    expect(isNotFound(azureError({ operation: "x", cause: makeSdkError(404) }))).toBe(true);
    expect(isNotFound(makeSdkError(404))).toBe(true);
    expect(isNotFound(makeSdkError(500))).toBe(false);
    expect(isNotFound(new Error("plain"))).toBe(false);
  });

  test("isAlreadyExists recognizes 409 and ResourceAlreadyExists code", () => {
    expect(isAlreadyExists(azureError({ operation: "x", cause: makeSdkError(409) }))).toBe(true);
    expect(
      isAlreadyExists(
        azureError({
          operation: "x",
          cause: Object.assign(new Error("conflict"), { code: "ResourceAlreadyExists" }),
        }),
      ),
    ).toBe(true);
    expect(isAlreadyExists(makeSdkError(404))).toBe(false);
  });

  test("isAlreadyExists recognizes 'already exists' message on both wrapped and raw errors", () => {
    const raw = Object.assign(new Error("Storage account already exists"), { statusCode: 500 });
    expect(isAlreadyExists(raw)).toBe(true);
    expect(isAlreadyExists(azureError({ operation: "create", resource: "x", cause: raw }))).toBe(
      true,
    );
  });

  test("isAzureError narrows raw SDK errors", () => {
    expect(isAzureError(makeSdkError(404))).toBe(true);
    expect(isAzureError(new Error("plain"))).toBe(false);
    expect(isAzureError("string")).toBe(false);
  });

  test("can be matched with Effect.catchTag", async () => {
    const program = Effect.fail(
      azureError({ operation: "test", cause: new Error("boom") }),
    ).pipe(Effect.catchTag("AzureError", (e) => Effect.succeed(`caught: ${e.operation}`)));

    const result = await Effect.runPromise(program);
    expect(result).toBe("caught: test");
  });
});

function makeSdkError(statusCode: number) {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}
