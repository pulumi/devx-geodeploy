import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { registryGcpAr } = await import("./gcp-ar.js");

describe("registry.gcp.ar", () => {
  it("constructs an Artifact Registry docker repository with an oauth2 access token password", async () => {
    const out = registryGcpAr("test", { location: "us-central1", repositoryId: "geodeploy-api" });

    const url = await new Promise((resolve) => out.registryUrl.apply(resolve));
    expect(url).toBe("us-central1-docker.pkg.dev/fake-project/geodeploy-api");

    const username = await new Promise((resolve) => out.auth.username.apply(resolve));
    const password = await new Promise((resolve) => out.auth.password.apply(resolve));
    expect(username).toBe("oauth2accesstoken");
    expect(password).toBe("fake-gcp-access-token");
  });
});
