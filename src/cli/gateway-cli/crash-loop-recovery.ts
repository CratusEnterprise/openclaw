import {
  inspectGatewayCrashLoopBreakerAsync,
  recordGatewayCrashLoopRecovery,
} from "../../infra/gateway-boot-lifecycle.js";

export function createGatewayCrashLoopRecovery(params: {
  bootId: string | undefined;
  getActiveBootId: () => string | undefined;
  onRecovered: (bootId: string) => void;
}): () => Promise<boolean> {
  return async () => {
    const suppressedBootId = params.bootId;
    if (!suppressedBootId || params.getActiveBootId() !== suppressedBootId) {
      return false;
    }
    const decision = await inspectGatewayCrashLoopBreakerAsync(process.env);
    // The open safe-mode boot must prove stable for the full unclean window.
    if (
      params.getActiveBootId() !== suppressedBootId ||
      !decision.recovered ||
      decision.uncleanBoots !== 0
    ) {
      return false;
    }
    const recoveredBootId = await recordGatewayCrashLoopRecovery(
      suppressedBootId,
      process.env,
      undefined,
      () => {
        if (params.getActiveBootId() !== suppressedBootId) {
          throw new Error("Gateway crash-loop recovery belongs to a replaced boot");
        }
      },
    );
    if (!recoveredBootId || params.getActiveBootId() !== suppressedBootId) {
      return false;
    }
    params.onRecovered(recoveredBootId);
    return true;
  };
}
