import { describe, expect, it } from "vitest";
import { jobMessageSchema } from "./jobs";

describe("jobMessageSchema", () => {
  it("email.send の正常なメッセージを受理する", () => {
    const result = jobMessageSchema.safeParse({
      type: "email.send",
      to: "user@example.com",
      subject: "件名",
      body: "本文",
    });
    expect(result.success).toBe(true);
  });

  it("stripe.webhook.process の正常なメッセージを受理する", () => {
    const result = jobMessageSchema.safeParse({
      type: "stripe.webhook.process",
      eventId: "evt_123",
      eventType: "checkout.session.completed",
    });
    expect(result.success).toBe(true);
  });

  it("email形式が不正な to を拒否する", () => {
    const result = jobMessageSchema.safeParse({
      type: "email.send",
      to: "not-an-email",
      subject: "件名",
      body: "本文",
    });
    expect(result.success).toBe(false);
  });

  it("空文字の subject (email.send) を拒否する", () => {
    const result = jobMessageSchema.safeParse({
      type: "email.send",
      to: "user@example.com",
      subject: "",
      body: "本文",
    });
    expect(result.success).toBe(false);
  });

  it("未知の type を拒否する", () => {
    const result = jobMessageSchema.safeParse({
      type: "unknown.type",
      foo: "bar",
    });
    expect(result.success).toBe(false);
  });

  it("空オブジェクトを拒否する", () => {
    const result = jobMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
