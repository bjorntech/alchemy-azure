import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { resolveResourceValue } from "./Internal.ts";
import type { ContainerRegistry } from "./ContainerRegistry.ts";
import type { Providers } from "./Providers.ts";

export interface ContainerImageProps {
  /** Azure Container Registry object or login server. */
  registry: string | ContainerRegistry;
  /** Repository name inside the registry. Defaults to the logical id lowercased. */
  repository?: string;
  /** Image tag. @default buildHash ?? "latest" */
  tag?: string;
  /** Docker build context path. @default "." */
  context?: string;
  /** Dockerfile path, relative to context or absolute. */
  dockerfile?: string;
  /** Build hash from an external build step. Changing this rebuilds and pushes. */
  buildHash?: string;
  /** Docker build arguments. */
  buildArgs?: Record<string, string>;
  /** Docker platform. Defaults to `linux/amd64` because Azure Container Apps requires an amd64 image. */
  platform?: string;
  /** Do not use Docker build cache. */
  noCache?: boolean;
  /** Registry username. Defaults to registry.username when a ContainerRegistry is supplied. */
  username?: string;
  /** Registry password. Defaults to registry.password when a ContainerRegistry is supplied. */
  password?: string | Redacted.Redacted<string>;
}

export type ContainerImage = Resource<
  "Azure.ContainerImage",
  ContainerImageProps,
  {
    image: string;
    loginServer: string;
    repository: string;
    tag: string;
    buildHash?: string;
  },
  never,
  Providers
>;

/**
 * Builds a local Docker context and pushes it to Azure Container Registry.
 *
 * @example
 * ```ts
 * const image = yield* Azure.ContainerImage("Image", {
 *   registry,
 *   context: ".",
 *   buildHash: build.hash,
 * });
 * ```
 */
export const ContainerImage = Resource<ContainerImage>("Azure.ContainerImage");

export const ContainerImageProvider = () =>
  Provider.effect(
    ContainerImage,
    Effect.gen(function* () {
      return ContainerImage.Provider.of({
        stables: ["image", "loginServer", "repository", "tag"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const desired = yield* desiredImage(id, news);
          if (desired.image !== output.image || desired.buildHash !== output.buildHash) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, session }) {
          const desired = yield* desiredImage(id, news);
          const credentials = yield* registryCredentials(news);
          if (credentials.username && credentials.password) {
            yield* session.note(`Logging in to Azure Container Registry: ${desired.loginServer}`);
            yield* run(
              "docker",
              [
                "login",
                desired.loginServer,
                "--username",
                credentials.username,
                "--password-stdin",
              ],
              Redacted.value(credentials.password),
            );
          }
          yield* session.note(`Building container image: ${desired.image}`);
          yield* run("docker", dockerBuildArgs(news, desired.image));
          yield* session.note(`Pushing container image: ${desired.image}`);
          yield* run("docker", ["push", desired.image]);
          return desired;
        }),
        delete: Effect.fnUntraced(function* () {
          // Images are immutable build artifacts in ACR; deleting tags here would be surprising.
        }),
      });
    }),
  );

function desiredImage(id: string, props: ContainerImageProps) {
  return Effect.gen(function* () {
    const loginServer = yield* registryLoginServer(props.registry);
    const repository = props.repository ?? id.toLowerCase().replaceAll(/[^a-z0-9._/-]/g, "-");
    const tag = props.tag ?? props.buildHash?.slice(0, 40) ?? "latest";
    return {
      image: `${loginServer}/${repository}:${tag}`,
      loginServer,
      repository,
      tag,
      buildHash: props.buildHash,
    } satisfies ContainerImage["Attributes"];
  });
}

function registryLoginServer(registry: string | ContainerRegistry) {
  return Effect.gen(function* () {
    if (typeof registry === "string") return registry;
    return yield* resolveResourceValue(registry.loginServer);
  });
}

function registryCredentials(props: ContainerImageProps) {
  return Effect.gen(function* () {
    if (props.username && props.password) {
      return {
        username: props.username,
        password:
          typeof props.password === "string" ? Redacted.make(props.password) : props.password,
      };
    }
    if (typeof props.registry === "string") return {};
    const username = yield* resolveResourceValue(props.registry.username);
    const password = yield* resolveResourceValue(props.registry.password);
    return { username, password };
  });
}

function dockerBuildArgs(props: ContainerImageProps, image: string) {
  const args = ["build", props.context ?? ".", "--tag", image];
  if (props.dockerfile) args.push("--file", props.dockerfile);
  args.push("--platform", props.platform ?? "linux/amd64");
  if (props.noCache) args.push("--no-cache");
  for (const [key, value] of Object.entries(props.buildArgs ?? {})) {
    args.push("--build-arg", `${key}=${value}`);
  }
  return args;
}

function run(command: string, args: string[], stdin?: string) {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
          stdio: [stdin ? "pipe" : "ignore", "inherit", "inherit"],
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
        });
        if (stdin && child.stdin) {
          child.stdin.write(stdin);
          child.stdin.end();
        }
      }),
    catch: (cause) => new Error(`Failed to run ${command} ${args.join(" ")}`, { cause }),
  });
}
