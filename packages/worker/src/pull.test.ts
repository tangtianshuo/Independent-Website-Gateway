import assert from "node:assert/strict";
import { test } from "node:test";
import { DockerOperationError } from "./docker-client.js";
import { pullApprovedImage, retryCodeForDockerFailure } from "./pull.js";

test("records a bounded operation failure when an approved public image pull fails", async () => {
  let failureRecorded = false;
  const failure = new DockerOperationError("pull", "registry unavailable", {
    transient: true,
  });
  const pulled = await pullApprovedImage(
    async () => {
      throw failure;
    },
    async () => {
      failureRecorded = true;
    },
  );
  assert.equal(pulled, false);
  assert.equal(failureRecorded, true);
});

test("does not record failure after a successful pull", async () => {
  let failureRecorded = false;
  const pulled = await pullApprovedImage(
    async () => undefined,
    async () => {
      failureRecorded = true;
    },
  );
  assert.equal(pulled, true);
  assert.equal(failureRecorded, false);
});

test("classifies only transport, timeout, rate-limit and server failures as retryable", () => {
  assert.equal(
    retryCodeForDockerFailure(
      new DockerOperationError("pull", "Docker image request unavailable", {
        transient: true,
      }),
      "registry_unavailable",
    ),
    "registry_unavailable",
  );
  assert.equal(
    retryCodeForDockerFailure(
      new DockerOperationError("pull", "Docker image pull failed (429)", {
        statusCode: 429,
      }),
      "registry_unavailable",
    ),
    "registry_unavailable",
  );
  assert.equal(
    retryCodeForDockerFailure(
      new DockerOperationError("pull", "Docker image pull failed (503)", {
        statusCode: 503,
      }),
      "registry_unavailable",
    ),
    "registry_unavailable",
  );
  for (const statusCode of [400, 401, 403, 404]) {
    assert.equal(
      retryCodeForDockerFailure(
        new DockerOperationError(
          "pull",
          `Docker image pull failed (${statusCode})`,
          { statusCode },
        ),
        "registry_unavailable",
      ),
      undefined,
    );
  }
  assert.equal(
    retryCodeForDockerFailure(
      new Error("Docker pulled image digest mismatch"),
      "registry_unavailable",
    ),
    undefined,
  );
  const wrapped = new Error("Failed to start created candidate", {
    cause: new DockerOperationError(
      "start",
      "Docker Engine request unavailable",
      {
        transient: true,
      },
    ),
  });
  assert.equal(
    retryCodeForDockerFailure(wrapped, "docker_unavailable"),
    "docker_unavailable",
  );
});
