import { describe, expect, it, vi } from "vitest";
import { handleJobsBatch } from "./consumer";
import type { JobMessage } from "../shared/jobs";

/**
 * MessageBatch<JobMessage> の最小モック。ack/retry を vi.fn で持たせ、
 * 呼ばれたかどうかを検証する。
 */
function makeMessage(id: string, body: unknown) {
  return {
    id,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function makeBatch(messages: ReturnType<typeof makeMessage>[]) {
  return { messages } as unknown as MessageBatch<JobMessage>;
}

describe("handleJobsBatch", () => {
  it("正常なメッセージは処理後に ack される", async () => {
    const message = makeMessage("msg-1", {
      type: "email.send",
      to: "user@example.com",
      subject: "件名",
      body: "本文",
    });
    const batch = makeBatch([message]);

    await handleJobsBatch(batch, {} as CloudflareBindings);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("パース不能なメッセージは console.error の上で ack される (リトライしない)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = makeMessage("msg-2", { type: "not.a.real.type" });
    const batch = makeBatch([message]);

    await handleJobsBatch(batch, {} as CloudflareBindings);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("ハンドラ内で例外が発生した場合は retry される", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("ハンドラ内で発生した想定外の例外");
    });
    const message = makeMessage("msg-3", {
      type: "email.send",
      to: "user@example.com",
      subject: "件名",
      body: "本文",
    });
    const batch = makeBatch([message]);

    await handleJobsBatch(batch, {} as CloudflareBindings);

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
