import { afterEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const destroyMock = vi.fn();

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: sendMock,
    destroy: destroyMock,
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

const getTokenMock = vi.fn();

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(() => ({
    getToken: getTokenMock,
  })),
}));

const getClientMock = vi.fn();

vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: getClientMock,
  })),
}));

import {
  verifyAwsIdentity,
  verifyAzureIdentity,
  verifyCloudflareIdentity,
  verifyGcpIdentity,
  verifyNs1Identity,
} from "./tier2.js";

describe("tier2 identity checks", () => {
  afterEach(() => {
    // Deliberately not vi.restoreAllMocks()/resetAllMocks(): those would also
    // wipe out the mockImplementation set on the STSClient/DefaultAzureCredential/
    // GoogleAuth constructors up in the vi.mock() factories above, since those
    // are plain vi.fn()s (not vi.spyOn() on a real implementation) with nothing
    // to "restore" to. Just reset the individual leaf mocks instead.
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    sendMock.mockReset();
    destroyMock.mockReset();
    getTokenMock.mockReset();
    getClientMock.mockReset();
  });

  describe("verifyAwsIdentity", () => {
    it("returns true when GetCallerIdentity resolves", async () => {
      sendMock.mockResolvedValueOnce({ Account: "123456789012" });
      await expect(verifyAwsIdentity()).resolves.toBe(true);
    });

    it("returns false, and never throws, when the call rejects", async () => {
      sendMock.mockRejectedValueOnce(new Error("network error"));
      await expect(verifyAwsIdentity()).resolves.toBe(false);
    });
  });

  describe("verifyAzureIdentity", () => {
    it("returns true when getToken resolves with a token", async () => {
      getTokenMock.mockResolvedValueOnce({ token: "abc", expiresOnTimestamp: Date.now() + 1000 });
      await expect(verifyAzureIdentity()).resolves.toBe(true);
    });

    it("returns false, and never throws, when getToken rejects", async () => {
      getTokenMock.mockRejectedValueOnce(new Error("no credential available"));
      await expect(verifyAzureIdentity()).resolves.toBe(false);
    });
  });

  describe("verifyGcpIdentity", () => {
    it("returns true when a client + access token can be obtained", async () => {
      getClientMock.mockResolvedValueOnce({
        getAccessToken: vi.fn().mockResolvedValueOnce({ token: "gcp-token" }),
      });
      await expect(verifyGcpIdentity()).resolves.toBe(true);
    });

    it("returns false, and never throws, when no ADC is available", async () => {
      getClientMock.mockRejectedValueOnce(new Error("Could not load the default credentials"));
      await expect(verifyGcpIdentity()).resolves.toBe(false);
    });
  });

  describe("verifyNs1Identity", () => {
    it("returns false immediately with no API key set (no fetch attempted)", async () => {
      vi.stubEnv("NS1_APIKEY", "");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(verifyNs1Identity()).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns true on a 200 response", async () => {
      vi.stubEnv("NS1_APIKEY", "test-key");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true }));

      await expect(verifyNs1Identity()).resolves.toBe(true);
    });

    it("returns false on a non-2xx response", async () => {
      vi.stubEnv("NS1_APIKEY", "test-key");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));

      await expect(verifyNs1Identity()).resolves.toBe(false);
    });

    it("returns false, and never throws, when fetch rejects", async () => {
      vi.stubEnv("NS1_APIKEY", "test-key");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("timeout")));

      await expect(verifyNs1Identity()).resolves.toBe(false);
    });
  });

  describe("verifyCloudflareIdentity", () => {
    it("returns false with no credentials configured (no fetch attempted)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(verifyCloudflareIdentity()).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns true on a successful token verify", async () => {
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) }),
      );

      await expect(verifyCloudflareIdentity()).resolves.toBe(true);
    });

    it("returns false when the API reports failure", async () => {
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: false }) }),
      );

      await expect(verifyCloudflareIdentity()).resolves.toBe(false);
    });

    it("returns false, and never throws, when fetch rejects for a legacy key+email pair", async () => {
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      vi.stubEnv("CLOUDFLARE_API_KEY", "legacy-key");
      vi.stubEnv("CLOUDFLARE_EMAIL", "user@example.com");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network error")));

      await expect(verifyCloudflareIdentity()).resolves.toBe(false);
    });
  });
});
