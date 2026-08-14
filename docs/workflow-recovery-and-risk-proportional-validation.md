# Workflow recovery and risk-proportional validation (#4560)

Long `ralplan -> ultragoal` runs can compact mid-flight. Before #4560, compaction preserved only a thin best-effort projection (active goal objective/status, workflow phase, open todos) plus a generic continuation prompt, and boundary validation applied the full review cohort unconditionally. This document describes the two mechanisms #4560 adds: a **structured workflow recovery projection** consumed by compaction, and a **deterministic validation-applicability policy** for Ultragoal boundary lanes.

## Structured workflow recovery projection

`packages/coding-agent/src/gjc-runtime/workflow-recovery-projection.ts` derives a bounded projection from canonical durable state through read-only filesystem access:

- **Ralplan**: the newest complete `final` stage row of a run's `index.jsonl` resolves the persisted plan artifact; objective/scope/non-goals/acceptance criteria/unresolved decisions are parsed from its bounded `##` sections, with a `sha256` digest over the artifact bytes.
- **Ultragoal**: `goals.json` + `ledger.jsonl` produce the aggregate objective, per-goal accepted scope, completed-goal acceptance evidence, the current goal (active/failed or first schedulable), measurable progress counters (total/completed/outstanding goals, latest joined cohort generation + frozen `sourceHash`, newest ledger event id), and the exact next action class (`continue-current-goal`, `start-next-goal`, `resolve-review-blockers`, `final-aggregate-checkpoint`, ...).

Safety properties:

- **Safe degradation** — malformed, stale, unreadable, or tampered durable state yields `undefined` and compaction falls back to the previous thin projection; projection failures never abort compaction.
- **Read-only** — the projection never mutates `.gjc/` state.

### Compaction consumption

`AgentSession`'s compaction state snapshot attaches the projection whenever an active recognized workflow (`ultragoal` first, then `ralplan`) owns the session:

- `#compactionStateContext` renders bounded `<compaction-state>` lines: workflow contract, accepted scope, non-goals, acceptance criteria, current goal, progress (including frozen `sourceHash`), next action, and contract digest. These flow into the compaction summary through the existing state-aware context path.
- The post-compaction auto-continue prompt for active recognized workflows replaces the generic `auto-continue.md` text with a `<workflow-recovery>` block plus rules: reload the durable contract before acting, latest-user-intent supremacy, **no silent scope expansion** (work beyond accepted scope must be classified as new scope and recorded durably), no duplicate already-verified review generations when the recorded source hash and evidence basis are unchanged, and bounded zero-progress escalation.
- Inertness is preserved: paused goals, manifest-terminal phases, and unknown skills never receive the structured continuation (the generic prompt and existing skip logic stay authoritative).

### Bounded zero-progress cycles

Each compaction observation fingerprints the projection's contract-relevant fields (`hashWorkflowRecoveryProjection`). `trackWorkflowRecoveryZeroProgress` counts consecutive observations with an unchanged fingerprint; at `ZERO_PROGRESS_STALL_THRESHOLD` (2) the continuation prompt carries an explicit `STALLED` directive ordering a durable blocker/escalation instead of repeating the same next action. Any measurable durable progress (completed obligations, changed blocker disposition, changed source hash, goal status change) resets the counter. This bounds — but does not claim to eliminate — post-compaction continuation loops.

## Ultragoal validation-applicability policy

`packages/coding-agent/src/gjc-runtime/ultragoal-validation-policy.ts` selects expensive boundary lanes deterministically from durable facts. Selection is runtime-authoritative and inspectable; free-form model prose can never grant a reduction.

Low-risk eligibility (the only case where redundant lanes may be omitted) requires **all** of:

- a trusted, completely captured change set,
- exactly one outstanding goal,
- no open review blockers,
- no high-risk path (auth/security, native crates, SDK/extensibility public contract, agent-wire protocol, shared behavior registries), migration path, or computer-control-surface path.

Everything else — including a missing or untrusted change set — is high risk and keeps the full heavyweight cohort (`cleaner || architect || qa`, join-before-repair, terminal critic).

Omission mechanics:

- The **QA lane can never be omitted**. Targeted verification and real-surface evidence stay mandatory at every boundary.
- A leader presenting a reduced cohort must carry a top-level `validationLaneSelection` proof (`riskClass`, `reasons`, `omittedLanes`) that exactly mirrors the runtime-computed selection. Mismatches fail closed with typed diagnostics (`reduction_not_applicable`, `selection_mismatch`, `omitted_lanes_mismatch`, `qa_lane_mandatory`) and the full cohort requirement stays in force.
- The **terminal critic** is proportional: `criticReview.verdict: OKAY` remains mandatory for final aggregates except when the run is single-goal, low-risk, blocker-free, **and** the immutable source basis is unchanged (`basisUnchanged`), in which case the already-joined cohort evidence satisfies the terminus without a duplicate critic read pass.

### Unchanged-basis rerun avoidance

`basisUnchanged` is true only when the newest ledger-recorded joined cohort source hash equals the current frozen cohort source hash under review and no review blockers reopened. A changed source, a review fix, an integration-base change, incomplete capture, or invalidated evidence forces a full rerun exactly as before; cohort parallelism and the frozen-source-hash lane binding are untouched whenever lanes run.

## Guarantees preserved

- `sourceHash` frozen-snapshot binding, receipts, provenance, immutable cohort snapshots, join-before-repair, validation batches, and high-risk QA/live-surface evidence requirements are unchanged.
- Executor parallelism and `cleaner || architect || qa` cohort parallelism are unchanged (the policy only decides *whether* a lane applies, never how lanes that do apply are scheduled).
- Review-blocker recursion caps and terminal-critic ceilings are unchanged.
