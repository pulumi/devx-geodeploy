import { describe, it, expect } from "vitest";
import { installPulumiMocks } from "../test-utils/mocks.js";

installPulumiMocks();

const { registryAzureAcr } = await import("./azure-acr.js");

describe("registry.azure.acr", () => {
  it("constructs an ACR registry with admin credentials", async () => {
    const out = registryAzureAcr("test", { location: "eastus", registryName: "geodeployacr" });

    const loginServer = await new Promise((resolve) => out.loginServer.apply(resolve));
    expect(loginServer).toContain("azurecr.io");

    const username = await new Promise((resolve) => out.auth.username.apply(resolve));
    const password = await new Promise((resolve) => out.auth.password.apply(resolve));
    expect(username).toBe("fake-acr-user");
    expect(password).toBe("fake-acr-password");
  });
});
