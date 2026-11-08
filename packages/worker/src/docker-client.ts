import { request as httpRequest } from "node:http";
import { runtimeOwnership } from "./runtime-scope.js";

interface DockerRequest {
  method: "POST" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}
interface DockerEngineOptions {
  socketPath?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  approvedImages?: readonly string[];
  platform?: string;
  runtimeScope?: string;
}
const imagePattern =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@)?sha256:[a-f0-9]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releasePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
const networkPattern = /^gateway-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const containerIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const createPathPattern =
  /^\/containers\/create\?name=(gateway-[a-zA-Z0-9_-]{1,120})$/;
const snapshotBindPattern =
  /^\/[A-Za-z0-9._/-]{1,512}:\/var\/lib\/gateway\/artifacts\/published\.json:ro$/;

export class DockerOperationError extends Error {
  readonly operation: string;
  readonly statusCode?: number;
  readonly transient: boolean;

  constructor(
    operation: string,
    message: string,
    options: { statusCode?: number; cause?: unknown; transient?: boolean } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "DockerOperationError";
    this.operation = operation;
    this.statusCode = options.statusCode;
    this.transient =
      options.transient ??
      (options.statusCode === 408 ||
        options.statusCode === 425 ||
        options.statusCode === 429 ||
        (options.statusCode !== undefined && options.statusCode >= 500));
  }
}

function fields(
  value: unknown,
  expected: string[],
): Record<string, unknown> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key))
  )
    return undefined;
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}
function arrayValues(value: unknown, length: number): unknown[] | undefined {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== length ||
    Reflect.ownKeys(value).length !== length + 1
  )
    return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return undefined;
    result.push(descriptor.value);
  }
  return result;
}
function jsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, value);
}
function jsonArray<T>(value: T[]): T[] {
  return Object.setPrototypeOf(value, null) as T[];
}

function validIngestEnvironment(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    !value.startsWith("NUXT_PUBLIC_INGEST_ORIGIN=")
  )
    return false;
  const origin = value.slice("NUXT_PUBLIC_INGEST_ORIGIN=".length);
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

function validCreateBody(
  body: Record<string, unknown> | undefined,
  approvedImages: ReadonlySet<string>,
  ownership: ReturnType<typeof runtimeOwnership>,
): Record<string, unknown> | undefined {
  const values = fields(body, ["Env", "HostConfig", "Image", "Labels", "User"]);
  if (!values) return undefined;
  const { Image, User, Env, Labels, HostConfig } = values;
  const env = arrayValues(Env, Array.isArray(Env) && Env.length === 8 ? 8 : 7);
  if (
    typeof Image !== "string" ||
    !imagePattern.test(Image) ||
    !approvedImages.has(Image) ||
    User !== "10001:10001" ||
    !env ||
    typeof env[0] !== "string" ||
    !env[0].startsWith("SITE_ID=") ||
    !uuidPattern.test(env[0].slice(8)) ||
    typeof env[1] !== "string" ||
    !env[1].startsWith("RELEASE_ID=") ||
    !releasePattern.test(env[1].slice(11)) ||
    typeof env[2] !== "string" ||
    !env[2].startsWith("NUXT_WORKSPACE_ID=") ||
    !uuidPattern.test(env[2].slice(18)) ||
    env[3] !== `NUXT_SITE_ID=${env[0].slice(8)}` ||
    typeof env[4] !== "string" ||
    !/^NUXT_GATEWAY_URL=http:\/\/(?:host\.docker\.internal|gateway-control):[1-9][0-9]{0,4}$/.test(
      env[4],
    ) ||
    Number(new URL(env[4].slice(17)).port) > 65535 ||
    typeof env[5] !== "string" ||
    !/^NUXT_SITE_CREDENTIAL=[a-f0-9]{64}$/.test(env[5]) ||
    !validIngestEnvironment(env[6]) ||
    (env.length === 8 &&
      env[7] !==
        "PUBLISHED_SNAPSHOT_PATH=/var/lib/gateway/artifacts/published.json")
  )
    return undefined;
  const labels = fields(Labels, ownership.keys);
  if (
    !labels ||
    !ownership.matches(labels) ||
    labels[ownership.siteKey] !== env[0].slice(8) ||
    labels[ownership.releaseKey] !== env[1].slice(11)
  )
    return undefined;
  const hasBinds =
    !!HostConfig &&
    typeof HostConfig === "object" &&
    Object.hasOwn(HostConfig, "Binds");
  const hostKeys = hasBinds
    ? [
        "Binds",
        "CapDrop",
        "Memory",
        "NanoCpus",
        "NetworkMode",
        "PidsLimit",
        "PortBindings",
        "Privileged",
        "ReadonlyRootfs",
        "SecurityOpt",
      ]
    : [
        "CapDrop",
        "Memory",
        "NanoCpus",
        "NetworkMode",
        "PidsLimit",
        "PortBindings",
        "Privileged",
        "ReadonlyRootfs",
        "SecurityOpt",
      ];
  const host = fields(HostConfig, hostKeys);
  if (
    !host ||
    typeof host.NetworkMode !== "string" ||
    !networkPattern.test(host.NetworkMode) ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    arrayValues(host.CapDrop, 1)?.[0] !== "ALL" ||
    arrayValues(host.SecurityOpt, 1)?.[0] !== "no-new-privileges:true" ||
    host.Memory !== 512 * 1024 * 1024 ||
    host.NanoCpus !== 500_000_000 ||
    host.PidsLimit !== 128
  )
    return undefined;
  const binding = fields(host.PortBindings, ["3000/tcp"]);
  const ports = binding && arrayValues(binding["3000/tcp"], 1);
  const port = ports && fields(ports[0], ["HostIp", "HostPort"]);
  if (
    !port ||
    port.HostIp !== "127.0.0.1" ||
    typeof port.HostPort !== "string" ||
    !/^[1-9][0-9]{3,4}$/.test(port.HostPort) ||
    Number(port.HostPort) < 1024 ||
    Number(port.HostPort) > 65535
  )
    return undefined;
  if (env.length === 8) {
    const binds = arrayValues(host.Binds, 1);
    if (
      !binds ||
      typeof binds[0] !== "string" ||
      !snapshotBindPattern.test(binds[0])
    )
      return undefined;
  } else if (hasBinds) return undefined;
  return jsonObject({
    Image,
    User: "10001:10001",
    Env: jsonArray(env as string[]),
    Labels: jsonObject(ownership.labels(env[0].slice(8), env[1].slice(11))),
    HostConfig: jsonObject({
      NetworkMode: host.NetworkMode,
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: jsonArray(["ALL"]),
      SecurityOpt: jsonArray(["no-new-privileges:true"]),
      Memory: 512 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 128,
      PortBindings: jsonObject({
        "3000/tcp": jsonArray([
          jsonObject({ HostIp: "127.0.0.1", HostPort: port.HostPort }),
        ]),
      }),
      ...(env.length === 8
        ? { Binds: jsonArray([String((host.Binds as unknown[])[0])]) }
        : {}),
    }),
  });
}

export function createDockerEngineClient({
  socketPath = "/var/run/docker.sock",
  timeoutMs = 10_000,
  maxResponseBytes = 1024 * 1024,
  approvedImages = [],
  platform,
  runtimeScope,
}: DockerEngineOptions = {}) {
  if (
    !socketPath ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    (platform !== undefined &&
      !["linux/amd64", "linux/arm64"].includes(platform)) ||
    approvedImages.some((image) => !imagePattern.test(image))
  )
    throw new Error("Invalid Docker Engine configuration");
  const ownership = runtimeOwnership(runtimeScope);
  const platformQuery = platform
    ? `&platform=${encodeURIComponent(platform)}`
    : "";
  const allowed = new Set(approvedImages);
  const candidates = new Set<string>();
  return {
    async pull(image: string): Promise<void> {
      if (!allowed.has(image) || !image.includes("@"))
        throw new Error("Unapproved image pull");
      const deadline = Date.now() + timeoutMs;
      const path = `/images/create?fromImage=${encodeURIComponent(image)}${platformQuery}`;
      const send = (
        method: string,
        requestPath: string,
        consume: (
          response: import("node:http").IncomingMessage,
        ) => Promise<void>,
      ) =>
        new Promise<void>((resolve, reject) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            reject(
              new DockerOperationError(
                "pull",
                "Docker image request timed out",
                { transient: true },
              ),
            );
            return;
          }
          let incoming: import("node:http").IncomingMessage | undefined;
          const timer = setTimeout(() => {
            reject(
              new DockerOperationError(
                "pull",
                "Docker image request timed out",
                { transient: true },
              ),
            );
            incoming?.destroy();
            request.destroy();
          }, remaining);
          const request = httpRequest(
            { socketPath, path: requestPath, method },
            (response) => {
              incoming = response;
              consume(response).then(
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                (error) => {
                  clearTimeout(timer);
                  response.destroy();
                  reject(error);
                },
              );
            },
          );
          request.on("error", (cause) => {
            clearTimeout(timer);
            reject(
              new DockerOperationError(
                "pull",
                "Docker image request unavailable",
                {
                  cause,
                  transient: true,
                },
              ),
            );
          });
          request.end();
        });
      await send("POST", path, async (response) => {
        if (response.statusCode !== 200) {
          throw new DockerOperationError(
            "pull",
            `Docker image pull failed (${response.statusCode ?? 0})`,
            {
              statusCode: response.statusCode ?? 0,
            },
          );
        }
        let bytes = 0;
        let pending = "";
        const checkLine = (line: string) => {
          if (!line.trim()) return;
          try {
            const data = JSON.parse(line);
            if (data.error || data.errorDetail) {
              const detail = String(
                data.errorDetail?.message ??
                  data.error ??
                  "Docker image pull failed",
              );
              const deterministic =
                /unauthorized|denied|not found|manifest unknown|invalid reference|digest|authentication/i.test(
                  detail,
                );
              throw new DockerOperationError(
                "pull",
                "Docker image pull failed",
                {
                  cause: detail,
                  transient: !deterministic,
                },
              );
            }
          } catch (error) {
            if (error instanceof SyntaxError)
              throw new Error("Invalid Docker image pull response");
            throw error;
          }
        };
        for await (const chunk of response) {
          if (Date.now() >= deadline)
            throw new Error("Docker image pull timed out");
          bytes += chunk.length;
          if (bytes > maxResponseBytes * 4)
            throw new Error("Docker pull response too large");
          pending += chunk.toString("utf8");
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0) {
            checkLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
        }
        checkLine(pending);
      });
      await send(
        "GET",
        `/images/${encodeURIComponent(image)}/json`,
        async (response) => {
          if (response.statusCode !== 200) {
            throw new DockerOperationError(
              "inspect",
              `Docker image inspect failed (${response.statusCode ?? 0})`,
              {
                statusCode: response.statusCode ?? 0,
              },
            );
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            if (Date.now() >= deadline)
              throw new Error("Docker image inspect timed out");
            bytes += chunk.length;
            if (bytes > maxResponseBytes)
              throw new Error("Docker image inspect response too large");
            chunks.push(Buffer.from(chunk));
          }
          let inspection: unknown;
          try {
            inspection = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            throw new Error("Invalid Docker image inspection");
          }
          const repoDigests =
            inspection && typeof inspection === "object"
              ? (inspection as { RepoDigests?: unknown }).RepoDigests
              : undefined;
          if (!Array.isArray(repoDigests) || !repoDigests.includes(image)) {
            throw new DockerOperationError(
              "inspect",
              "Docker pulled image digest mismatch",
              {
                transient: false,
              },
            );
          }
        },
      );
    },
    request(input: DockerRequest): Promise<{ Id: string }> {
      const method = input.method;
      const path = input.path;
      const requestBody = input.body;
      let payload: string | undefined;
      if (method === "POST" && createPathPattern.test(path)) {
        const body = validCreateBody(requestBody, allowed, ownership);
        if (!body) {
          return Promise.reject(
            new DockerOperationError("start", "Invalid Docker request", {
              transient: false,
            }),
          );
        }
        payload = JSON.stringify(body);
      } else {
        if (requestBody !== undefined)
          return Promise.reject(new Error("Invalid Docker request"));
        const match =
          /^\/containers\/([a-zA-Z0-9_-]{1,128})(\/start|\?force=true)$/.exec(
            path,
          );
        if (
          !match ||
          !candidates.has(match[1]) ||
          !(
            (method === "POST" && match[2] === "/start") ||
            (method === "DELETE" && match[2] === "?force=true")
          )
        ) {
          return Promise.reject(
            new DockerOperationError("start", "Invalid Docker request", {
              transient: false,
            }),
          );
        }
      }
      return new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath,
            path: path.startsWith("/containers/create?")
              ? path + platformQuery
              : path,
            method,
            headers:
              payload === undefined
                ? undefined
                : {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                  },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maxResponseBytes) {
                reject(new Error("Docker Engine response too large"));
                request.destroy();
              } else chunks.push(chunk);
            });
            response.on("end", () => {
              const status = response.statusCode ?? 0;
              if (status < 200 || status >= 300) {
                reject(
                  new DockerOperationError(
                    "start",
                    `Docker Engine request failed (${status})`,
                    {
                      statusCode: status,
                    },
                  ),
                );
                return;
              }
              if (path.startsWith("/containers/create?")) {
                try {
                  const data: unknown = JSON.parse(
                    Buffer.concat(chunks).toString("utf8"),
                  );
                  if (
                    !data ||
                    typeof data !== "object" ||
                    !("Id" in data) ||
                    typeof data.Id !== "string" ||
                    !containerIdPattern.test(data.Id)
                  )
                    throw new Error();
                  candidates.add(data.Id);
                  resolve({ Id: data.Id });
                } catch {
                  reject(
                    new DockerOperationError(
                      "start",
                      "Invalid Docker Engine response",
                      {
                        transient: false,
                      },
                    ),
                  );
                }
              } else {
                if (method === "DELETE")
                  candidates.delete(/^\/containers\/([^?]+)/.exec(path)![1]);
                resolve({ Id: "" });
              }
            });
          },
        );
        request.on("error", (cause) =>
          reject(
            new DockerOperationError(
              "start",
              "Docker Engine request unavailable",
              {
                cause,
                transient: true,
              },
            ),
          ),
        );
        const timer = setTimeout(() => {
          reject(
            new DockerOperationError(
              "start",
              "Docker Engine request timed out",
              {
                transient: true,
              },
            ),
          );
          request.destroy();
        }, timeoutMs);
        request.on("close", () => clearTimeout(timer));
        request.end(payload);
      });
    },
  };
}
