import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { registryAwsEcr } = await import("./aws-ecr.js");

describe("registry.aws.ecr", () => {
  it("constructs an ECR repository with docker-login-ready auth", async () => {
    const out = registryAwsEcr("test", { region: "us-east-1", repositoryName: "geodeploy/api" });

    const url = await new Promise((resolve) => out.repositoryUrl.apply(resolve));
    expect(url).toContain("dkr.ecr");

    const username = await new Promise((resolve) => out.auth.username.apply(resolve));
    const password = await new Promise((resolve) => out.auth.password.apply(resolve));
    expect(username).toBe("AWS");
    expect(typeof password).toBe("string");
    expect((password as string).length).toBeGreaterThan(0);
  });
});
