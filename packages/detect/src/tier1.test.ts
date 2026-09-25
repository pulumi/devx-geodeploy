import { afterEach, describe, expect, it, vi } from "vitest";

// node:fs's real module namespace object is sealed (non-configurable) under
// native ESM, so vi.spyOn(fs, "existsSync") fails with "Cannot redefine
// property" here. Mocking the whole module through vi.mock instead gives both
// tier1.ts and this test file the same virtualized module, which Vitest is
// happy to let us swap the implementation of.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

import * as fs from "node:fs";
import {
  checkAwsTier1,
  checkAzureTier1,
  checkCloudflareTier1,
  checkGcpTier1,
  checkNs1Tier1,
} from "./tier1.js";

const existsSyncMock = vi.mocked(fs.existsSync);

describe("tier1 presence checks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    existsSyncMock.mockReset();
  });

  describe("checkAwsTier1", () => {
    it("is absent with no env vars and no ~/.aws files", () => {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_PROFILE", "");
      vi.stubEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "");
      existsSyncMock.mockReturnValue(false);

      const result = checkAwsTier1();
      expect(result.tier1).toBe(false);
      expect(result.detail).toEqual(expect.any(String));
    });

    it("is present with an access key pair", () => {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
      existsSyncMock.mockReturnValue(false);

      expect(checkAwsTier1().tier1).toBe(true);
    });

    it("is present with AWS_PROFILE and an existing ~/.aws/credentials file", () => {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_PROFILE", "default");
      existsSyncMock.mockReturnValue(true);

      expect(checkAwsTier1().tier1).toBe(true);
    });

    it("is absent with AWS_PROFILE set but no credentials/config file present", () => {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_PROFILE", "default");
      existsSyncMock.mockReturnValue(false);

      expect(checkAwsTier1().tier1).toBe(false);
    });

    it("is present with a container-credentials env marker", () => {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/abc");
      existsSyncMock.mockReturnValue(false);

      expect(checkAwsTier1().tier1).toBe(true);
    });
  });

  describe("checkAzureTier1", () => {
    it("is present with a full service-principal env triple", () => {
      vi.stubEnv("AZURE_CLIENT_ID", "client-id");
      vi.stubEnv("AZURE_CLIENT_SECRET", "client-secret");
      vi.stubEnv("AZURE_TENANT_ID", "tenant-id");
      existsSyncMock.mockReturnValue(false);

      expect(checkAzureTier1().tier1).toBe(true);
    });

    it("is absent with a partial service-principal triple and no CLI profile", () => {
      vi.stubEnv("AZURE_CLIENT_ID", "client-id");
      vi.stubEnv("AZURE_CLIENT_SECRET", "");
      vi.stubEnv("AZURE_TENANT_ID", "");
      existsSyncMock.mockReturnValue(false);

      expect(checkAzureTier1().tier1).toBe(false);
    });

    it("is present with an existing ~/.azure/azureProfile.json", () => {
      vi.stubEnv("AZURE_CLIENT_ID", "");
      vi.stubEnv("AZURE_CLIENT_SECRET", "");
      vi.stubEnv("AZURE_TENANT_ID", "");
      existsSyncMock.mockReturnValue(true);

      expect(checkAzureTier1().tier1).toBe(true);
    });
  });

  describe("checkGcpTier1", () => {
    it("is present when GOOGLE_APPLICATION_CREDENTIALS points at an existing file", () => {
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/creds.json");
      vi.stubEnv("GOOGLE_API_KEY", "");
      existsSyncMock.mockReturnValue(true);

      expect(checkGcpTier1().tier1).toBe(true);
    });

    it("is absent when GOOGLE_APPLICATION_CREDENTIALS points at a missing file and nothing else is set", () => {
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/missing.json");
      vi.stubEnv("GOOGLE_API_KEY", "");
      existsSyncMock.mockReturnValue(false);

      expect(checkGcpTier1().tier1).toBe(false);
    });

    it("is present with GOOGLE_API_KEY alone", () => {
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
      vi.stubEnv("GOOGLE_API_KEY", "api-key");
      existsSyncMock.mockReturnValue(false);

      expect(checkGcpTier1().tier1).toBe(true);
    });

    it("is present with an existing gcloud ADC file", () => {
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
      vi.stubEnv("GOOGLE_API_KEY", "");
      existsSyncMock.mockReturnValue(true);

      expect(checkGcpTier1().tier1).toBe(true);
    });

    it("is absent with nothing set and no ADC file", () => {
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
      vi.stubEnv("GOOGLE_API_KEY", "");
      existsSyncMock.mockReturnValue(false);

      expect(checkGcpTier1().tier1).toBe(false);
    });
  });

  describe("checkNs1Tier1", () => {
    it("is present when NS1_APIKEY is set", () => {
      vi.stubEnv("NS1_APIKEY", "ns1-key");
      expect(checkNs1Tier1().tier1).toBe(true);
    });

    it("is absent when NS1_APIKEY is unset", () => {
      vi.stubEnv("NS1_APIKEY", "");
      expect(checkNs1Tier1().tier1).toBe(false);
    });
  });

  describe("checkCloudflareTier1", () => {
    it("is present with an API token", () => {
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
      expect(checkCloudflareTier1().tier1).toBe(true);
    });

    it("is present with a legacy key + email pair", () => {
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      vi.stubEnv("CLOUDFLARE_API_KEY", "legacy-key");
      vi.stubEnv("CLOUDFLARE_EMAIL", "user@example.com");
      expect(checkCloudflareTier1().tier1).toBe(true);
    });

    it("is absent with only a legacy key and no email", () => {
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      vi.stubEnv("CLOUDFLARE_API_KEY", "legacy-key");
      vi.stubEnv("CLOUDFLARE_EMAIL", "");
      expect(checkCloudflareTier1().tier1).toBe(false);
    });

    it("is absent with nothing set", () => {
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      vi.stubEnv("CLOUDFLARE_API_KEY", "");
      vi.stubEnv("CLOUDFLARE_EMAIL", "");
      expect(checkCloudflareTier1().tier1).toBe(false);
    });
  });
});
