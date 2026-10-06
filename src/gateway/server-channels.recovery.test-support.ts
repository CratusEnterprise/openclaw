import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createTestPlugin,
  flushMicrotasks,
  type createTestChannelManager,
  type createTestChannelRegistry,
  type TestAccount,
} from "./server-channels.test-support.js";

export function registerChannelAutostartRecoveryTests({
  createManager,
  installTestRegistry,
  stayRunning,
}: {
  createManager: typeof createTestChannelManager;
  installTestRegistry: typeof createTestChannelRegistry;
  stayRunning: (context: ChannelGatewayContext<TestAccount>) => Promise<void>;
}): void {
  describe("crash-loop channel autostart recovery", () => {
    let originalEnv: ReturnType<typeof captureEnv>;
    beforeEach(() => {
      originalEnv = captureEnv(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"]);
      deleteTestEnvValue("OPENCLAW_SKIP_CHANNELS");
      deleteTestEnvValue("OPENCLAW_SKIP_PROVIDERS");
    });
    afterEach(() => originalEnv.restore());

    it.each(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"])(
      "preserves %s suppression after breaker recovery while allowing manual starts",
      async (envKey) => {
        setTestEnvValue(envKey, "1");
        const startAccount = vi.fn(stayRunning);
        installTestRegistry(createTestPlugin({ startAccount }));
        const manager = createManager({ tryRecoverAutostartSuppression: async () => true });
        manager.setAutostartSuppression({ reason: "crash-loop-breaker", message: "safe mode" });

        await expect(manager.recoverAutostartSuppression()).resolves.toBe(true);
        expect(manager.getAutostartSuppression()).toBeNull();
        expect(startAccount).not.toHaveBeenCalled();

        await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
        expect(startAccount).toHaveBeenCalledOnce();
      },
    );
    it("joins concurrent autostart recovery without undoing manual stops", async () => {
      const startAccount = vi.fn(stayRunning);
      installTestRegistry(
        createTestPlugin({
          startAccount,
          listAccountIds: () => [DEFAULT_ACCOUNT_ID, "work"],
        }),
      );
      const transition = createDeferred<boolean>();
      const tryRecover = vi.fn(() => transition.promise);
      const manager = createManager({
        tryRecoverAutostartSuppression: tryRecover,
        getRuntimeConfig: () => ({
          channels: { discord: { healthMonitor: { enabled: false } } },
        }),
      });
      manager.setAutostartSuppression({
        reason: "crash-loop-breaker",
        message: "safe mode",
      });

      await manager.startChannels();
      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
      await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
      const recovery = manager.recoverAutostartSuppression();
      const concurrentRecovery = manager.recoverAutostartSuppression();
      await flushMicrotasks();
      expect(manager.getAutostartSuppression()).not.toBeNull();
      expect(startAccount).toHaveBeenCalledTimes(1);
      transition.resolve(true);
      await expect(Promise.all([recovery, concurrentRecovery])).resolves.toEqual([true, true]);
      await flushMicrotasks();

      expect(tryRecover).toHaveBeenCalledOnce();
      expect(manager.getAutostartSuppression()).toBeNull();
      expect(startAccount.mock.calls.map(([ctx]) => ctx.accountId)).toEqual([
        DEFAULT_ACCOUNT_ID,
        "work",
      ]);
      expect(manager.isHealthMonitorEnabled("discord", "work")).toBe(false);
      expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
    });

    it("does not start recovered accounts after gateway close begins during handoff", async () => {
      const accountStartReady = createDeferred();
      const startAccount = vi.fn(async () => {});
      let closing = false;
      installTestRegistry(createTestPlugin({ startAccount }));
      const manager = createManager({
        deferStartupAccountStartsUntil: accountStartReady.promise,
        isClosing: () => closing,
        tryRecoverAutostartSuppression: async () => true,
      });
      manager.setAutostartSuppression({
        reason: "crash-loop-breaker",
        message: "safe mode",
      });

      const recovery = manager.recoverAutostartSuppression();
      await flushMicrotasks();
      closing = true;
      accountStartReady.resolve();
      await recovery;
      await flushMicrotasks();

      expect(manager.getAutostartSuppression()).toBeNull();
      expect(startAccount).not.toHaveBeenCalled();
    });

    it("keeps suppression when persisted recovery is not proven", async () => {
      const startAccount = vi.fn(async () => {});
      installTestRegistry(createTestPlugin({ startAccount }));
      const manager = createManager({ tryRecoverAutostartSuppression: async () => false });
      manager.setAutostartSuppression({
        reason: "crash-loop-breaker",
        message: "safe mode",
      });

      await expect(manager.recoverAutostartSuppression()).resolves.toBe(false);

      expect(manager.getAutostartSuppression()?.reason).toBe("crash-loop-breaker");
      expect(startAccount).not.toHaveBeenCalled();
    });

    it.each(["closing", "replacement"] as const)(
      "keeps suppression when %s overtakes the persisted recovery transition",
      async (change) => {
        const transition = createDeferred<boolean>();
        const startAccount = vi.fn(async () => {});
        let closing = false;
        installTestRegistry(createTestPlugin({ startAccount }));
        const manager = createManager({
          isClosing: () => closing,
          tryRecoverAutostartSuppression: () => transition.promise,
        });
        const suppression = { reason: "crash-loop-breaker" as const, message: "safe mode" };
        manager.setAutostartSuppression(suppression);

        const recovery = manager.recoverAutostartSuppression();
        const current = change === "replacement" ? { ...suppression } : suppression;
        manager.setAutostartSuppression(current);
        closing = change === "closing";
        transition.resolve(true);

        await expect(recovery).resolves.toBe(false);
        expect(manager.getAutostartSuppression()).toBe(current);
        expect(startAccount).not.toHaveBeenCalled();
      },
    );
  });
}
