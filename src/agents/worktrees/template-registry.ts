import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import type { Selectable } from "kysely";
import { classifyGatewayOwnerProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  parseStateLeaseProcessOwner,
  type StateLeaseProcessOwner,
} from "../../infra/state-lease-process-owner.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "../../state/openclaw-state-feature-schema.js";

export type WorktreeTemplateRecord = {
  cacheKey: string;
  id: string;
  repoRoot: string;
  commonDir: string;
  worktreeRoot: string;
  path: string;
  backend: string;
  sourceCommit: string;
  contentKey: string;
  status: "preparing" | "ready";
  createdAt: number;
  lastUsedAt: number;
};

type TemplateDatabase = Pick<OpenClawStateKyselyDatabase, "worktree_templates" | "state_leases">;
type TemplateRow = Selectable<TemplateDatabase["worktree_templates"]>;
const TEMPLATE_READER_SCOPE = "core:managed-worktrees:template-readers";

const ensureTemplateSchema = createOpenClawStateSchemaEnsurer({
  table: "worktree_templates",
  operationLabel: "agents.worktrees.templates.schema.ensure",
});

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<TemplateDatabase>(db);
}

function rowToRecord(row: TemplateRow): WorktreeTemplateRecord {
  if (row.status !== "preparing" && row.status !== "ready") {
    throw new Error(`Invalid worktree template status: ${row.status}`);
  }
  return {
    cacheKey: row.cache_key,
    id: row.id,
    repoRoot: row.repo_root,
    commonDir: row.common_dir,
    worktreeRoot: row.worktree_root,
    path: row.path,
    backend: row.backend,
    sourceCommit: row.source_commit,
    contentKey: row.content_key,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function openTemplateDatabase(env: NodeJS.ProcessEnv): DatabaseSync {
  ensureTemplateSchema({ env });
  return openOpenClawStateDatabase({ env }).db;
}

export function readTemplate(
  env: NodeJS.ProcessEnv,
  cacheKey: string,
): WorktreeTemplateRecord | undefined {
  const db = openTemplateDatabase(env);
  const row = executeSqliteQuerySync(
    db,
    kyselyFor(db).selectFrom("worktree_templates").selectAll().where("cache_key", "=", cacheKey),
  ).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function hasTemplates(env: NodeJS.ProcessEnv): boolean {
  const db = openTemplateDatabase(env);
  return (
    executeSqliteQuerySync(
      db,
      kyselyFor(db).selectFrom("worktree_templates").select("cache_key").limit(1),
    ).rows.length > 0
  );
}

export function listTemplates(env: NodeJS.ProcessEnv): WorktreeTemplateRecord[] {
  const db = openTemplateDatabase(env);
  return executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .selectFrom("worktree_templates")
      .selectAll()
      .orderBy("last_used_at", "asc")
      .orderBy("id", "asc"),
  ).rows.map(rowToRecord);
}

// The cache holds template custody across filesystem work. Durable mutations
// recheck that custody inside the shared-state transaction.
function mutateTemplate<T>(
  env: NodeJS.ProcessEnv,
  commitGuard: () => void,
  operationLabel: string,
  mutate: (db: DatabaseSync) => T,
): T {
  commitGuard();
  ensureTemplateSchema({ env });
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      commitGuard();
      return mutate(db);
    },
    { env },
    { operationLabel },
  );
}

/** Reserve before creating the artifact; an occupied slot must be retired first. */
export function reserveTemplate(
  env: NodeJS.ProcessEnv,
  record: WorktreeTemplateRecord & { status: "preparing" },
  commitGuard: () => void,
): void {
  mutateTemplate(env, commitGuard, "agents.worktrees.templates.reserve", (db) => {
    executeSqliteQuerySync(
      db,
      kyselyFor(db).insertInto("worktree_templates").values({
        cache_key: record.cacheKey,
        id: record.id,
        repo_root: record.repoRoot,
        common_dir: record.commonDir,
        worktree_root: record.worktreeRoot,
        path: record.path,
        backend: record.backend,
        source_commit: record.sourceCommit,
        content_key: record.contentKey,
        status: record.status,
        created_at: record.createdAt,
        last_used_at: record.lastUsedAt,
      }),
    );
  });
}

export function markTemplateReady(
  env: NodeJS.ProcessEnv,
  id: string,
  now: number,
  commitGuard: () => void,
): boolean {
  return mutateTemplate(env, commitGuard, "agents.worktrees.templates.ready", (db) => {
    return (
      executeSqliteQuerySync(
        db,
        kyselyFor(db)
          .updateTable("worktree_templates")
          .set({ status: "ready", last_used_at: now })
          .where("id", "=", id)
          .where("status", "=", "preparing"),
      ).numAffectedRows === 1n
    );
  });
}

export function touchTemplate(
  env: NodeJS.ProcessEnv,
  id: string,
  now: number,
  commitGuard: () => void,
): boolean {
  return mutateTemplate(env, commitGuard, "agents.worktrees.templates.touch", (db) => {
    return (
      executeSqliteQuerySync(
        db,
        kyselyFor(db)
          .updateTable("worktree_templates")
          .set({ last_used_at: now })
          .where("id", "=", id)
          .where("status", "=", "ready"),
      ).numAffectedRows === 1n
    );
  });
}

/** A stale cleanup must never delete a replacement occupying the same cache key. */
export function deleteTemplate(
  env: NodeJS.ProcessEnv,
  id: string,
  commitGuard: () => void,
): boolean {
  return mutateTemplate(env, commitGuard, "agents.worktrees.templates.delete", (db) => {
    return (
      executeSqliteQuerySync(
        db,
        kyselyFor(db).deleteFrom("worktree_templates").where("id", "=", id),
      ).numAffectedRows === 1n
    );
  });
}

/** Readers never expire while a native clone can still borrow template bytes. */
export function retainTemplateReader(
  env: NodeJS.ProcessEnv,
  input: { id: string; key: string; owner: StateLeaseProcessOwner; unpublish?: true },
  commitGuard: () => void,
): void {
  mutateTemplate(env, commitGuard, "agents.worktrees.templates.retain", (db) => {
    const now = Date.now();
    if (input.unpublish) {
      executeSqliteQuerySync(
        db,
        kyselyFor(db)
          .updateTable("worktree_templates")
          .set({ status: "preparing" })
          .where("id", "=", input.id),
      );
    }
    executeSqliteQuerySync(
      db,
      kyselyFor(db)
        .insertInto("state_leases")
        .values({
          scope: TEMPLATE_READER_SCOPE,
          lease_key: input.key,
          owner: input.key,
          expires_at: null,
          heartbeat_at: null,
          payload_json: JSON.stringify({ owner: input.owner, template: input.id }),
          created_at: now,
          updated_at: now,
        }),
    );
  });
}

export function releaseTemplateReader(
  env: NodeJS.ProcessEnv,
  key: string,
  commitGuard: () => void,
): void {
  mutateTemplate(env, commitGuard, "agents.worktrees.templates.release", (db) => {
    executeSqliteQuerySync(
      db,
      kyselyFor(db)
        .deleteFrom("state_leases")
        .where("scope", "=", TEMPLATE_READER_SCOPE)
        .where("lease_key", "=", key)
        .where("owner", "=", key),
    );
  });
}

export function hasTemplateReaders(
  env: NodeJS.ProcessEnv,
  id: string,
  commitGuard: () => void,
): boolean {
  return mutateTemplate(env, commitGuard, "agents.worktrees.templates.readers", (db) => {
    const k = kyselyFor(db);
    const rows = executeSqliteQuerySync(
      db,
      k
        .selectFrom("state_leases")
        .select(["lease_key", "owner", "payload_json"])
        .where("scope", "=", TEMPLATE_READER_SCOPE),
    ).rows;
    let retained = false;
    for (const row of rows) {
      const payload = safeParseJsonRecord(row.payload_json ?? "");
      if (typeof payload?.template !== "string") {
        throw new Error("Worktree template reader is unreadable; template retained");
      }
      const owner = parseStateLeaseProcessOwner(row.payload_json);
      // A dead parent does not prove its native child stopped. Only an older
      // boot proves those borrowers are gone without an explicit settlement.
      if (
        owner?.processNamespace &&
        classifyGatewayOwnerProcessNamespace(owner.processNamespace) === "dead"
      ) {
        executeSqliteQuerySync(
          db,
          k
            .deleteFrom("state_leases")
            .where("scope", "=", TEMPLATE_READER_SCOPE)
            .where("lease_key", "=", row.lease_key)
            .where("owner", "=", row.owner),
        );
      } else if (payload.template === id) {
        retained = true;
      }
    }
    return retained;
  });
}
