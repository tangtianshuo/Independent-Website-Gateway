import assert from "node:assert/strict";
import test from "node:test";
import { readPublishLimits } from "./claim.js";
import { retryDelayMs } from "./retry-policy.js";

test("uses exact bounded exponential delays only for transient failures", () => {
  assert.equal(retryDelayMs(1, "registry_unavailable"), 5_000);
  assert.equal(retryDelayMs(2, "gateway_unavailable"), 10_000);
  assert.equal(retryDelayMs(7, "docker_unavailable"), 300_000);
  assert.equal(retryDelayMs(8, "registry_unavailable"), null);
  assert.equal(retryDelayMs(1, "invalid_release"), null);
  assert.equal(retryDelayMs(0, "registry_unavailable"), null);
  assert.equal(retryDelayMs(1.5, "registry_unavailable"), null);
});

test("validates server-configurable queue defaults and overrides", () => {
  assert.deepEqual(readPublishLimits({}), {
    maxSiteLeases: 1,
    maxWorkspaceLeases: 2,
    maxGlobalLeases: 4,
    siteStartIntervalMs: 5_000,
  });
  assert.deepEqual(
    readPublishLimits({
      GATEWAY_PUBLISH_SITE_LEASES: "2",
      GATEWAY_PUBLISH_WORKSPACE_LEASES: "3",
      GATEWAY_PUBLISH_GLOBAL_LEASES: "6",
      GATEWAY_PUBLISH_SITE_INTERVAL_MS: "9000",
    }),
    {
      maxSiteLeases: 2,
      maxWorkspaceLeases: 3,
      maxGlobalLeases: 6,
      siteStartIntervalMs: 9_000,
    },
  );
  assert.throws(
    () => readPublishLimits({ GATEWAY_PUBLISH_GLOBAL_LEASES: "0" }),
    /Invalid/,
  );
  assert.throws(
    () => readPublishLimits({ GATEWAY_PUBLISH_SITE_INTERVAL_MS: "abc" }),
    /Invalid/,
  );
  assert.throws(
    () =>
      readPublishLimits({
        GATEWAY_PUBLISH_SITE_LEASES: "5",
        GATEWAY_PUBLISH_WORKSPACE_LEASES: "2",
        GATEWAY_PUBLISH_GLOBAL_LEASES: "4",
      }),
    /Inconsistent/,
  );
});
