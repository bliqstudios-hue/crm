import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyZernioWebhookSignature } from "./zernio-signature";

const SECRET = process.env.ZERNIO_WEBHOOK_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyZernioWebhookSignature", () => {
  it("accepts a request signed with the correct secret", () => {
    const body = JSON.stringify({ event: "message.received" });
    expect(verifyZernioWebhookSignature(body, signedHeader(body))).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = "{}";
    expect(verifyZernioWebhookSignature(body, signedHeader(body, "wrong"))).toBe(
      false,
    );
  });

  it("rejects when the body has been tampered with after signing", () => {
    const original = '{"event":"message.received"}';
    const header = signedHeader(original);
    const tampered = '{"event":"message.deleted"}';
    expect(verifyZernioWebhookSignature(tampered, header)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyZernioWebhookSignature("anything", null)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    expect(verifyZernioWebhookSignature("{}", "tooshort")).toBe(false);
  });

  describe("fail-closed when secret is missing", () => {
    const originalSecret = process.env.ZERNIO_WEBHOOK_SECRET;
    beforeEach(() => {
      delete process.env.ZERNIO_WEBHOOK_SECRET;
    });
    afterEach(() => {
      process.env.ZERNIO_WEBHOOK_SECRET = originalSecret;
    });

    it("rejects even a correctly-formed signature when no secret is configured", () => {
      const body = "{}";
      const header = signedHeader(body, originalSecret!);
      expect(verifyZernioWebhookSignature(body, header)).toBe(false);
    });
  });
});
