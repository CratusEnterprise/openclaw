import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type {
  inspectGatewayCrashLoopBreakerAsync,
  recordGatewayCrashLoopRecovery,
} from "../../infra/gateway-boot-lifecycle.js";
import { createGatewayCrashLoopRecovery } from "./crash-loop-recovery.js";

const lifecycle = vi.hoisted(() => ({
  inspect: vi.fn<typeof inspectGatewayCrashLoopBreakerAsync>(),
  record: vi.fn<typeof recordGatewayCrashLoopRecovery>(),
}));

// mock-isolation: The adapter owns boot identity; the persistence owner has its own worker tests.
vi.mock("../../infra/gateway-boot-lifecycle.js", () => ({
  inspectGatewayCrashLoopBreakerAsync: lifecycle.inspect,
  recordGatewayCrashLoopRecovery: lifecycle.record,
}));

const cleared = {
  tripped: false,
  recoveryPausedUntilMs: undefined,
  uncleanBoots: 0,
  windowMs: 300_000,
  shouldWriteStabilityBundle: false,
  recovered: true,
};

function createFixture() {
  let activeBootId = "boot-id";
  const onRecovered = vi.fn((bootId: string) => {
    activeBootId = bootId;
  });
  return {
    onRecovered,
    replaceBoot: () => {
      activeBootId = "next-boot-id";
    },
    recover: createGatewayCrashLoopRecovery({
      bootId: activeBootId,
      getActiveBootId: () => activeBootId,
      onRecovered,
    }),
  };
}

describe("Gateway crash-loop recovery adapter", () => {
  beforeEach(() => {
    lifecycle.inspect.mockReset().mockResolvedValue(cleared);
    lifecycle.record.mockReset().mockResolvedValue("recovered-boot-id");
  });

  it("recovers channel autostart only after the full breaker window drains", async () => {
    const fixture = createFixture();
    lifecycle.inspect.mockResolvedValueOnce({ ...cleared, uncleanBoots: 1 });

    await expect(fixture.recover()).resolves.toBe(false);
    expect(lifecycle.record).not.toHaveBeenCalled();
    expect(fixture.onRecovered).not.toHaveBeenCalled();

    await expect(fixture.recover()).resolves.toBe(true);
    expect(lifecycle.record.mock.calls[0]?.[0]).toBe("boot-id");
    expect(fixture.onRecovered).toHaveBeenCalledExactlyOnceWith("recovered-boot-id");
    await expect(fixture.recover()).resolves.toBe(false);
    expect(lifecycle.record).toHaveBeenCalledOnce();
  });

  it.each(["inspection", "recording"] as const)(
    "does not recover a boot replaced during breaker %s",
    async (phase) => {
      const fixture = createFixture();
      const pending = createDeferred();
      const entered = createDeferred();
      if (phase === "inspection") {
        lifecycle.inspect.mockImplementationOnce(async () => {
          entered.resolve();
          await pending.promise;
          return cleared;
        });
      } else {
        lifecycle.record.mockImplementationOnce(async () => {
          entered.resolve();
          await pending.promise;
          return "old-recovered-boot";
        });
      }

      const recovery = fixture.recover();
      await awaitGateBeforeSettlement(
        entered.promise,
        recovery,
        `Recovery settled before the ${phase} boundary`,
      );
      fixture.replaceBoot();
      pending.resolve();

      await expect(recovery).resolves.toBe(false);
      expect(lifecycle.record).toHaveBeenCalledTimes(phase === "inspection" ? 0 : 1);
      if (phase === "recording") {
        expect(lifecycle.record.mock.calls[0]?.[3]).toThrow("replaced boot");
      }
      expect(fixture.onRecovered).not.toHaveBeenCalled();
    },
  );
});
