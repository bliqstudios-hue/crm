import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendZernioText } from "./zernio-api";

describe("sendZernioText", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the conversation's messages endpoint with the accountId and message", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, data: { messageId: "wamid.ABC123" } }),
        { status: 200 },
      ),
    );

    const result = await sendZernioText({
      accountId: "acct-1",
      conversationId: "conv-1",
      message: "hola",
    });

    expect(result).toEqual({ messageId: "wamid.ABC123" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://zernio.com/api/v1/inbox/conversations/conv-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-zernio-api-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ accountId: "acct-1", message: "hola" }),
      }),
    );
  });

  it("throws with Zernio's error message on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Conversation not found" }), {
        status: 404,
      }),
    );

    await expect(
      sendZernioText({ accountId: "a", conversationId: "c", message: "m" }),
    ).rejects.toThrow("Conversation not found");
  });

  it("throws when the response is 2xx but carries no messageId", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }),
    );

    await expect(
      sendZernioText({ accountId: "a", conversationId: "c", message: "m" }),
    ).rejects.toThrow(/no messageId/);
  });

  it("throws when ZERNIO_API_KEY is not configured", async () => {
    const original = process.env.ZERNIO_API_KEY;
    delete process.env.ZERNIO_API_KEY;
    try {
      await expect(
        sendZernioText({ accountId: "a", conversationId: "c", message: "m" }),
      ).rejects.toThrow(/ZERNIO_API_KEY/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.ZERNIO_API_KEY = original;
    }
  });
});
