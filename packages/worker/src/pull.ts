import { DockerOperationError } from "./docker-client.js";

export type DockerFailureClass = "registry_unavailable" | "docker_unavailable";

export function retryCodeForDockerFailure(
  error: unknown,
  transientCode: DockerFailureClass,
): DockerFailureClass | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown): DockerOperationError | undefined => {
    if (!value || seen.has(value)) return undefined;
    seen.add(value);
    if (value instanceof DockerOperationError) return value;
    if (value instanceof AggregateError) {
      for (const child of value.errors) {
        const found = visit(child);
        if (found) return found;
      }
    }
    if (value instanceof Error && value.cause !== undefined) {
      return visit(value.cause);
    }
    return undefined;
  };
  const dockerError = visit(error);
  return dockerError?.transient ? transientCode : undefined;
}

export async function pullApprovedImage(
  pull: () => Promise<void>,
  recordFailure: (error: unknown) => Promise<unknown>,
): Promise<boolean> {
  try {
    await pull();
    return true;
  } catch (error) {
    await recordFailure(error);
    return false;
  }
}
