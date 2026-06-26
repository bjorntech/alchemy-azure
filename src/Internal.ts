import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Stack, Stage } from "alchemy";
import type { ResourceGroup } from "./ResourceGroup.ts";

export type NamedResourceGroup = string | ResourceGroup;

export interface PhysicalNameOptions {
  maxLength?: number;
  suffixLength?: number;
  lowercase?: boolean;
  delimiter?: string;
  sanitize?: (name: string) => string;
}

export const makePhysicalNames = Effect.gen(function* () {
  const stack = yield* Stack;
  const stage = yield* Stage;

  const defaultName = (
    id: string,
    instanceId: string,
    options: PhysicalNameOptions = {},
  ) => {
    const suffixLength = options.suffixLength ?? 16;
    const delimiter = options.delimiter ?? "-";
    const lowercase = options.lowercase ?? false;
    const prefix = `${stack.name}${delimiter}${id}${delimiter}${stage}${delimiter}`;
    const suffix = base32(Buffer.from(instanceId, "hex")).slice(0, suffixLength);
    const raw = `${prefix}${suffix}`;
    const maxLength = options.maxLength ?? 64;
    const truncated = maxLength && raw.length > maxLength
      ? `${prefix.slice(0, maxLength - suffix.length)}${suffix}`
      : raw;
    const sanitized = (lowercase ? truncated.toLowerCase() : truncated).replaceAll(
      lowercase ? /[^a-z0-9-]/g : /[^a-zA-Z0-9-]/g,
      delimiter,
    );
    return options.sanitize?.(sanitized) ?? sanitized;
  };

  const physicalName = (
    id: string,
    instanceId: string,
    name: string | undefined,
    options?: PhysicalNameOptions,
  ) => name ?? defaultName(id, instanceId, options);

  return { defaultName, physicalName };
});

export const physicalName = (
  id: string,
  instanceId: string,
  name: string | undefined,
  options?: PhysicalNameOptions,
) => makePhysicalNames.pipe(Effect.map((names) => names.physicalName(id, instanceId, name, options)));

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const outputLength = Math.ceil((bytes.length * 8) / 5);
  const output = Array.from<string>({ length: outputLength });
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output[index++] = alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output[index++] = alphabet[(buffer << (5 - bits)) & 31];
  }
  return index === outputLength ? output.join("") : output.slice(0, index).join("");
}

export const resourceGroupName = (resourceGroup: NamedResourceGroup) =>
  Effect.gen(function* () {
    if (resourceGroup === undefined) return undefined as never;
    if (typeof resourceGroup === "string") return resourceGroup;
    return yield* resolveResourceValue(resourceGroup.name);
  });

export const resourceGroupLocation = (resourceGroup: NamedResourceGroup) =>
  Effect.gen(function* () {
    if (typeof resourceGroup === "string") return undefined;
    return yield* resolveResourceValue(resourceGroup.location);
  });

export function resolveResourceValue<T>(value: T) {
  return Effect.gen(function* () {
    if (Effect.isEffect(value)) return yield* value;
    const maybeOutput = value as { asEffect?: () => Effect.Effect<Effect.Effect<T>> };
    if (typeof maybeOutput?.asEffect === "function") {
      const accessor = yield* maybeOutput.asEffect();
      return yield* accessor;
    }
    return value;
  });
}

export const requireLocation = (
  id: string,
  location: string | undefined,
  resourceGroup: NamedResourceGroup,
) =>
  Effect.gen(function* () {
    const resolved = location ?? (yield* resourceGroupLocation(resourceGroup));
    if (!resolved) {
      throw new Error(`${id} requires location when resourceGroup is a string.`);
    }
    return resolved;
  });

export async function collectAzurePages<T>(source: AsyncIterable<T> | Promise<{ value?: T[] }> | Promise<T[]>): Promise<T[]> {
  const resolved = await source;
  if (isAsyncIterable<T>(resolved)) {
    const items: T[] = [];
    for await (const item of resolved) items.push(item);
    return items;
  }
  return Array.isArray(resolved) ? resolved : (resolved.value ?? []);
}

export function diffValueEqual(left: unknown, right: unknown) {
  return JSON.stringify(stableDiffValue(left)) === JSON.stringify(stableDiffValue(right));
}

function stableDiffValue(value: unknown): unknown {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(stableDiffValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, stableDiffValue(record[key])]),
    );
  }
  return value;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof (value as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === "function";
}
