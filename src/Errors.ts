import * as Schema from "effect/Schema";

/**
 * Tagged error raised by Azure provider lifecycle methods when an Azure
 * SDK call fails. Use `Effect.catchTag("AzureError", ...)` to handle
 * these with full type-safety.
 */
export class AzureError extends Schema.TaggedErrorClass<AzureError>()(
  "AzureError",
  {
    message: Schema.String,
    /** Logical operation that triggered the failure, e.g. `reconcile resource group`. */
    operation: Schema.optional(Schema.String),
    /** Physical name of the Azure resource the operation targeted. */
    resource: Schema.optional(Schema.String),
    /** HTTP status code, when the underlying error carries one. */
    statusCode: Schema.optional(Schema.Number),
    /** Azure error code, e.g. `ResourceAlreadyExists`. */
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect({ includeStack: true })),
  },
) {}

/**
 * Shape Azure SDK errors typically expose. Used to extract `statusCode`
 * and `code` for {@link AzureError} construction.
 */
interface AzureSdkError extends Error {
  statusCode?: number;
  code?: string;
}

const hasSdkShape = (error: unknown): error is AzureSdkError =>
  error instanceof Error &&
  (("statusCode" in error && typeof (error as AzureSdkError).statusCode === "number") ||
    ("code" in error && typeof (error as AzureSdkError).code === "string"));

/**
 * Walk an error's `cause` chain to find the underlying Azure SDK error.
 *
 * `Effect.tryPromise(thunk)` (the single-argument form used across the
 * providers) wraps a rejected promise in an `UnknownError`, stashing the real
 * SDK error — including its `statusCode` / `code` — under `cause`. Detection
 * helpers must therefore look past the top-level error, or idempotent `read` /
 * `delete` paths never recognise a 404 / 409.
 */
function findSdkError(error: unknown): AzureSdkError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (hasSdkShape(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isAzureError(error: unknown): error is AzureSdkError {
  return findSdkError(error) !== undefined;
}

export function isNotFound(error: unknown): boolean {
  if (error instanceof AzureError && error.statusCode === 404) return true;
  return findSdkError(error)?.statusCode === 404;
}

export function isAlreadyExists(error: unknown): boolean {
  const matches = (statusCode?: number, code?: string, message?: string) =>
    statusCode === 409 || code === "ResourceAlreadyExists" || !!message?.includes("already exists");
  if (error instanceof AzureError && matches(error.statusCode, error.code, error.message)) {
    return true;
  }
  const sdk = findSdkError(error);
  return matches(sdk?.statusCode, sdk?.code, sdk?.message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap an arbitrary thrown value as an {@link AzureError}, preserving
 * `statusCode` / `code` from Azure SDK errors. Suitable as the `catch:`
 * mapper for `Effect.tryPromise`.
 */
export function azureError(input: {
  operation: string;
  resource?: string;
  cause: unknown;
}): AzureError {
  const { operation, resource, cause } = input;
  const sdk = findSdkError(cause);
  return new AzureError({
    message: `Failed to ${operation}${resource ? ` "${resource}"` : ""}: ${errorMessage(cause)}`,
    operation,
    resource,
    statusCode: sdk?.statusCode,
    code: sdk?.code,
    cause,
  });
}
