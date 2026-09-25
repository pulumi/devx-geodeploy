import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { imageBuildMultiarch } = await import("./multiarch.js");

describe("image.build.multiarch", () => {
  it("constructs a multi-platform docker-build Image pushed to the given registry", async () => {
    const out = imageBuildMultiarch("test", {
      registry: {
        registryUrl: "123456789012.dkr.ecr.us-east-1.amazonaws.com",
        username: "AWS",
        password: "fake-password",
      },
      repositoryName: "geodeploy/api",
      tag: "v1",
    });

    const platforms = await new Promise((resolve) => out.image.platforms.apply(resolve));
    expect(platforms).toEqual(["linux/amd64", "linux/arm64"]);

    const push = await new Promise((resolve) => out.image.push.apply(resolve));
    expect(push).toBe(true);

    const ref = await new Promise((resolve) => out.ref.apply(resolve));
    expect(ref).toBe("123456789012.dkr.ecr.us-east-1.amazonaws.com/geodeploy/api:v1");

    const digest = await new Promise((resolve) => out.digest.apply(resolve));
    expect(digest).toMatch(/^sha256:/);
  });
});
