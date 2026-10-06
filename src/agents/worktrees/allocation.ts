import { verifyOpenClawStateLeaseOwnership } from "../../state/openclaw-state-lease-storage.js";
import { withOpenClawStateLeasesWorkerAdmission } from "../../state/openclaw-state-lease-worker-owner.js";
import {
  OpenClawStateLeaseError,
  withOpenClawStateLeaseAsync,
} from "../../state/openclaw-state-lease.js";
import { WORKTREE_CREATE_LEASE_SCOPE, WORKTREE_MUTATION_LEASE_SCOPE } from "./capacity-contract.js";
import {
  createWorktreeDiskAdmission,
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
  type WorktreeCapacityContentionError,
} from "./capacity.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import { recoverPendingWorktrees } from "./pending-slots.js";
import { captureWorktreeRunEndContext, retainWorktreeRunEndFailure } from "./run-end-lifecycle.js";
import type { WorktreeLeaseSet, WorktreeWorkerAuthority } from "./types.js";

const WORKTREE_CREATE_LEASE_MS = 60_000;
// A dependency install can take 15 minutes; contenders also wait for checkout and cleanup.
export const WORKTREE_CREATE_LEASE_WAIT_MS = 30 * 60_000;

export type WorktreeAllocationGuard = WorktreeFilesystemOptions & {
  rollbackGuard: () => void;
  waitUntil?: number;
  workerAuthority: WorktreeWorkerAuthority & { leaseSet: WorktreeLeaseSet };
  requireDiskSpace: ReturnType<typeof createWorktreeDiskAdmission>["requireDiskSpace"];
};

type WorktreeLeaseParams = {
  env: NodeJS.ProcessEnv;
  id?: string;
  waitUntil?: number;
  signal?: AbortSignal;
  commitGuard?: () => void;
  rollbackGuard?: () => void;
  workerAuthority?: WorktreeWorkerAuthority;
};

/** Serialize slot admission and count-changing maintenance across repositories and processes. */
export async function withWorktreeAllocationLease<T>(
  params: WorktreeLeaseParams,
  run: (guard: WorktreeAllocationGuard) => Promise<T>,
): Promise<T> {
  return await withWorktreeLease(params, WORKTREE_CREATE_LEASE_SCOPE, "capacity", async (guard) => {
    await recoverPendingWorktrees(params.env, guard.workerAuthority);
    return params.id
      ? withWorktreeMutationLease({ ...params, ...guard, id: params.id }, run)
      : run(guard);
  });
}

/** Registered retirement owns only its checkout; disk admission accounts for concurrent writes. */
export async function withWorktreeMutationLease<T>(
  params: WorktreeLeaseParams & { id: string },
  run: (guard: WorktreeAllocationGuard) => Promise<T>,
): Promise<T> {
  return await withWorktreeLease(params, WORKTREE_MUTATION_LEASE_SCOPE, params.id, run);
}

export async function waitForWorktreeCapacity(
  error: WorktreeCapacityContentionError,
  params: WorktreeLeaseParams,
): Promise<void> {
  params.commitGuard?.();
  await withOpenClawStateLeaseAsync(
    {
      scope: WORKTREE_CAPACITY_RESERVATION_SCOPE,
      key: error.reservationKey,
      leaseMs: WORKTREE_CREATE_LEASE_MS,
      waitMs: remainingWorktreeWait(params),
      signal: params.signal,
      leaseLabel: "managed worktree disk admission",
      operationLabel: "agents.worktrees.capacity-wait",
    },
    captureWorktreeRunEndContext(params.env),
    async () => params.commitGuard?.(),
  );
}

function remainingWorktreeWait(params: WorktreeLeaseParams): number {
  if (params.waitUntil === undefined) {
    return WORKTREE_CREATE_LEASE_WAIT_MS;
  }
  const remaining = Math.floor(params.waitUntil - performance.now());
  if (remaining <= 0) {
    throw new Error(
      "Managed worktree creation timed out waiting for capacity or checkout custody; inspect openclaw worktrees list and run openclaw worktrees gc before retrying.",
    );
  }
  return remaining;
}

async function withWorktreeLease<T>(
  params: WorktreeLeaseParams,
  scope: string,
  key: string,
  run: (guard: WorktreeAllocationGuard) => Promise<T>,
): Promise<T> {
  const acquisition = new AbortController();
  const abortAcquisition = () => acquisition.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", abortAcquisition, { once: true });
  if (params.signal?.aborted) {
    abortAcquisition();
  }
  try {
    params.commitGuard?.();
    const captured = captureWorktreeRunEndContext(params.env);
    const inherited = params.workerAuthority?.leaseSet;
    const context = inherited?.context ?? captured;
    if (context.admission.coordinationKey !== captured.admission.coordinationKey) {
      throw new Error("Managed worktree lease set belongs to another database");
    }
    return await withOpenClawStateLeaseAsync(
      {
        scope,
        key,
        leaseMs: WORKTREE_CREATE_LEASE_MS,
        waitMs: remainingWorktreeWait(params),
        heartbeat: "worker",
        leaseLabel: "managed worktree allocation lease",
        operationLabel: "agents.worktrees.allocation",
        signal: acquisition.signal,
      },
      context,
      (lease) => {
        const leaseSet: WorktreeLeaseSet = {
          context,
          leases: [...(inherited?.leases ?? []), lease],
        };
        return withOpenClawStateLeasesWorkerAdmission(
          leaseSet.leases,
          context,
          async (authority) => {
            // Caller cancellation stops new work; ownership survives through native settlement.
            params.signal?.removeEventListener("abort", abortAcquisition);
            const signal = params.signal
              ? AbortSignal.any([params.signal, lease.signal])
              : lease.signal;
            const assertOwned = () => {
              authority.assertCurrent();
              for (const identity of authority.identities) {
                verifyOpenClawStateLeaseOwnership({
                  ...identity,
                  leaseLabel: "managed worktree allocation lease",
                  database: {
                    scope: "shared",
                    options: { path: context.admission.databasePath, env: context.environment },
                  },
                });
              }
            };
            const commitGuard = () => {
              assertOwned();
              signal.throwIfAborted();
              params.commitGuard?.();
            };
            const workerAuthority = {
              leaseSet,
              predicates: params.workerAuthority?.predicates,
              assertCurrent: () => {
                captured.admission.assertCurrent();
                signal.throwIfAborted();
                (params.workerAuthority
                  ? params.workerAuthority.assertCurrent
                  : params.commitGuard)?.();
              },
            };
            const capacity = createWorktreeDiskAdmission({
              env: params.env,
              workerAuthority,
              assertCurrent: commitGuard,
            });
            let releaseCapacity = true;
            try {
              const result = await run({
                signal,
                waitUntil: params.waitUntil,
                commitGuard,
                rollbackGuard: () => {
                  assertOwned();
                  params.rollbackGuard?.();
                },
                workerAuthority,
                requireDiskSpace: capacity.requireDiskSpace,
              });
              signal.throwIfAborted();
              return result;
            } catch (error) {
              if (hasWorktreeUnknownOutcome(error)) {
                releaseCapacity = false;
                retainWorktreeRunEndFailure(error);
                throw error;
              }
              if (params.signal?.aborted) {
                assertOwned();
                throw new OpenClawStateLeaseError(
                  "managed worktree allocation lease operation was aborted",
                  { code: "OPENCLAW_STATE_LEASE_ABORTED", cause: params.signal.reason },
                );
              }
              throw error;
            } finally {
              if (releaseCapacity) {
                await capacity.release();
              }
            }
          },
        );
      },
    );
  } finally {
    params.signal?.removeEventListener("abort", abortAcquisition);
  }
}
