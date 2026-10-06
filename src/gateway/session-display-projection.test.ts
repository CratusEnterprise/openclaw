import { describe, expect, test } from "vitest";
import { projectSessionDisplayMessage } from "./session-display-projection.js";

const SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS = 240;

describe("projectSessionDisplayMessage", () => {
  test("keeps visible user and assistant text while excluding non-display rows", () => {
    const messages = [
      { role: "user", content: "Initial request" },
      { role: "assistant", content: "Visible final answer" },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      { role: "system", content: "system event" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private thought" },
          { type: "reasoning", text: "reasoning summary" },
        ],
      },
      { role: "assistant", content: "NO_REPLY" },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        openclawDelivery: { replyToCurrent: true },
      },
    ];

    expect(messages.map((message) => projectSessionDisplayMessage(message))).toEqual([
      { role: "user", text: "Initial request" },
      { role: "assistant", text: "Visible final answer" },
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("bounds previews without splitting surrogate pairs", () => {
    const longReply = `${"a".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS - 2)}😊tail`;
    const preview = projectSessionDisplayMessage({ role: "assistant", content: longReply });

    expect(preview?.text).toHaveLength(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS);
    expect(preview?.text).toBe(`${"a".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS - 3)}...`);
  });

  test("honors explicit preview budgets up to the shared cap", () => {
    const maxChars = 800;
    const message = { role: "assistant", content: "a".repeat(maxChars + 20) };
    const preview = projectSessionDisplayMessage(message, { maxChars });

    expect(preview?.text).toHaveLength(maxChars);
    expect(preview?.text).toBe(`${"a".repeat(maxChars - 3)}...`);
    expect(projectSessionDisplayMessage(message, { maxChars: Number.MAX_SAFE_INTEGER })?.text).toBe(
      `${"a".repeat(maxChars - 3)}...`,
    );
  });

  test("flattens Markdown before bounding a preview", () => {
    const longUrl = `https://example.com/${"x".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS)}`;
    const preview = projectSessionDisplayMessage(
      { role: "assistant", content: `Read the [deployment guide](${longUrl})` },
      { flattenMarkdown: true },
    );

    expect(preview?.text).toBe("Read the deployment guide");
  });

  test("preserves quoted directive examples", () => {
    const quoted = "Use `[[reply_to_current]]` literally.";
    expect(projectSessionDisplayMessage({ role: "assistant", content: quoted })?.text).toBe(quoted);
  });

  test("display view strips internal runtime-context blocks from user text", () => {
    const withInternalContext =
      "What is the deploy status?\n\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
      "# requester_profile\n" +
      "profileId=synthetic-test-001\n" +
      "email=test@example.invalid\n" +
      "trustLevel=owner\n" +
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

    const preview = projectSessionDisplayMessage({ role: "user", content: withInternalContext });

    expect(preview?.text).toBe("What is the deploy status?");
  });

  test("model-context view preserves internal runtime-context blocks for debug auditing", () => {
    const withInternalContext =
      "What is the deploy status?\n\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
      "# requester_profile\n" +
      "profileId=synthetic-test-001\n" +
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

    const preview = projectSessionDisplayMessage(
      { role: "user", content: withInternalContext },
      { view: "model-context" },
    );

    expect(preview?.text).toBe(withInternalContext);
  });

  test("display view still strips recognized channel/timestamp envelope headers", () => {
    const preview = projectSessionDisplayMessage({
      role: "user",
      content: "[WebChat 2026-10-06 13:02] What is the deploy status?",
    });

    expect(preview?.text).toBe("What is the deploy status?");
  });

  test("display view strips text that merely looks like the internal-context delimiter", () => {
    // Pre-existing, accepted behavior shared with stripUserEnvelopeForDisplay everywhere
    // else it's used: delimiter-shaped text from an untrusted sender is not distinguishable
    // from a real internal-context block, so it is stripped too. This is a fidelity/
    // availability edge case, not a confidentiality regression.
    const literalDelimiterText =
      "See this marker:\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nnot really internal\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

    const preview = projectSessionDisplayMessage({ role: "user", content: literalDelimiterText });

    expect(preview?.text).toBe("See this marker:");
  });
});
