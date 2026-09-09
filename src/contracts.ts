/**
 * @description Public, provider-neutral work-contract schemas and values.
 *
 * @module work/contracts
 * @file Contracts.ts
 */

import {
	array,
	check,
	literal,
	optional,
	picklist,
	pipe,
	regex,
	strictObject,
	string,
} from 'valibot'

/** @description File-defined work artifact families supported by the compiler. */
export type WorkArtifactKind = 'initiative' | 'prd' | 'issue' | 'task' | 'eval' | `custom:${string}`

/** @description Whether a definition is directly executable or derives progress from children. */
export type WorkExecution = 'task' | 'aggregate'

/** @description Canonical compiler/provider limits for one file-owned work definition. */
export const WORK_DEFINITION_LIMITS = Object.freeze({
	acceptanceItems: 1000,
	acceptanceBytes: 16_000,
	aggregateChildren: 64,
	bodyBytes: 5_000_000,
	definitionListEntryBytes: 2000,
	dependencies: 64,
	evidenceRequirements: 100,
	identityBytes: 128,
	kindBytes: 128,
	manifestFieldNames: 100,
	manifestPatterns: 1000,
	manifestSources: 1000,
	projectIdBytes: 128,
	sourcePathBytes: 500,
	titleBytes: 500,
	workIdentities: 100,
})

/** @description Canonical portable work identity syntax shared by compilers and providers. */
export const WORK_ID_PATTERN = /^[A-Z][A-Z0-9]*-[A-Z0-9][A-Z0-9-]{0,63}$/

/** @description Evidence categories that can satisfy a terminal work requirement. */
export type EvidenceKind =
	| 'test'
	| 'review'
	| 'build'
	| 'ci'
	| 'security'
	| 'artifact'
	| `custom:${string}`

/** @description Built-in delivery-policy preset selected by a repository manifest. */
export type DeliveryProfile = 'evidence-only' | 'local-direct' | 'protected-pr'

/** @description Isolation boundary required before a work item may be claimed. */
export type WorkIsolation = 'none' | 'worktree' | 'container'

/** @description Integration mechanism expected to make a candidate durable. */
export type WorkIntegration = 'evidence' | 'local' | 'pull-request'

/** @description Repository-defined milestone at which operational work is terminal. */
export type WorkTerminalMilestone = 'evidence' | 'candidate' | 'landed' | 'merged' | 'deployed'

/** @description Typed gate names accepted by the completion-policy evaluator. */
export type WorkDeliveryGate =
	| 'validation'
	| 'pull-request'
	| 'review'
	| 'ci'
	| 'security'
	| 'landing'
	| 'merge'
	| 'deployment'

/** @description Normalized outcome of a candidate-bound gate observation. */
export type WorkGateDisposition = 'passed' | 'failed' | 'unavailable' | 'stale' | 'waived'

/** @description Effective, fully expanded delivery contract for one repository. */
export interface WorkDeliveryPolicy {
	readonly profile: DeliveryProfile
	readonly isolation: WorkIsolation
	readonly integration: WorkIntegration
	readonly terminal: WorkTerminalMilestone
	readonly targetRef?: string
	readonly protectedRefs?: readonly string[]
	readonly requiredGates: readonly WorkDeliveryGate[]
}

/** @description Exact canonical definition snapshot used by one loaded work project. */
export interface CanonicalDefinitionRevision {
	readonly targetRef: string
	/** @description Accepted only while reading older schema-v3 provider records. */
	readonly targetSha?: string | undefined
	readonly graphFingerprint: string
}

/** @description Runtime boundary for an exact configured target-ref definition revision. */
export const CanonicalDefinitionRevisionSchema = strictObject({
	targetRef: pipe(
		string(),
		check((value) => Buffer.byteLength(value, 'utf8') <= 256),
		regex(/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u),
		check(
			(value) =>
				!value.includes('//') &&
				!value.includes('..') &&
				!value.endsWith('.') &&
				value
					.split('/')
					.every(
						(segment) =>
							segment.length > 0 &&
							!segment.startsWith('.') &&
							!segment.toLowerCase().endsWith('.lock'),
					),
			'Canonical target refs must follow conservative Git ref syntax.',
		),
	),
	targetSha: optional(pipe(string(), regex(/^[a-f0-9]{40,64}$/u))),
	graphFingerprint: pipe(string(), regex(/^[a-f0-9]{64}$/u)),
})

/** @description Backward-compatible policy used when an existing manifest omits delivery. */
export const EVIDENCE_ONLY_DELIVERY_POLICY: WorkDeliveryPolicy = Object.freeze({
	profile: 'evidence-only',
	isolation: 'none',
	integration: 'evidence',
	terminal: 'evidence',
	requiredGates: Object.freeze([]),
})

/** @description Sanitized read-only observation of the current Git execution boundary. */
export interface WorkspaceObservation {
	readonly available: boolean
	readonly repositoryId?: string
	readonly headSha?: string
	readonly treeSha?: string
	readonly ref?: string
	readonly isolation: 'none' | 'main' | 'worktree' | 'container'
	readonly dirty: boolean
}

/** @description Opaque state identity safe to compare across worktrees without exposing paths. */
export interface ProviderStateObservation {
	readonly identity: string
	readonly projectUid?: string
	readonly scope: 'repository' | 'workspace'
	readonly shared: boolean
}

/** @description Layer responsible for one semantic continuation. */
export type WorkActionOwner = 'work' | 'review' | 'integration' | 'validation' | 'operator'

/** @description Semantic continuation returned by preparation and lifecycle commands. */
export type WorkNextAction =
	| {
			readonly action: 'start'
			readonly owner: 'work'
			readonly command: 'work start'
			readonly workId: string
			readonly requires: readonly ['actor']
	  }
	| {
			readonly action: 'provision_workspace'
			readonly owner: 'integration'
			readonly isolation: 'worktree' | 'container'
			readonly workId: string
			readonly then: 'work start'
	  }
	| { readonly action: 'perform_work'; readonly owner: 'operator'; readonly workId: string }
	| {
			readonly action: 'prepare_review'
			readonly owner: 'work'
			readonly command: 'work review prepare'
			readonly workId: string
			readonly actor: string
	  }
	| {
			readonly action: 'perform_review'
			readonly owner: 'review'
			readonly workId: string
			readonly reviewedHead: string
			readonly report: string
	  }
	| {
			readonly action: 'ensure_review_evidence_committed'
			readonly owner: 'operator'
			readonly paths: readonly string[]
	  }
	| {
			readonly action: 'verify_review_status'
			readonly owner: 'work'
			readonly command: 'work review status'
			readonly workId: string
	  }
	| { readonly action: 'resume_rework'; readonly owner: 'operator'; readonly workId: string }
	| {
			readonly action: 'finalize'
			readonly owner: 'work'
			readonly command: 'work finalize'
			readonly workId: string
			readonly actor: string
			readonly evidenceRequirements: readonly EvidenceKind[]
	  }
	| {
			readonly action: 'integrate_candidate'
			readonly owner: 'integration'
			readonly workId: string
			readonly candidateGeneration: number
			readonly integration: WorkIntegration
			readonly targetRef?: string
			readonly then: 'work reconcile'
	  }
	| {
			readonly action: 'submit'
			readonly owner: 'work'
			readonly command: 'work submit'
			readonly workId: string
			readonly actor: string
			readonly evidenceRequirements: readonly EvidenceKind[]
	  }
	| {
			readonly action: 'complete'
			readonly owner: 'work'
			readonly command: 'work complete'
			readonly workId: string
			readonly actor: string
			readonly evidenceRequirements: readonly EvidenceKind[]
			readonly requiredGates: readonly WorkDeliveryGate[]
	  }
	| {
			readonly action: 'provide_gate_receipts'
			readonly owner: 'validation'
			readonly workId: string
			readonly gates: readonly WorkDeliveryGate[]
			readonly then: 'work reconcile'
	  }
	| {
			readonly action: 'cleanup_workspace'
			readonly owner: 'integration'
			readonly workId: string
			readonly eligible: boolean
	  }
	| { readonly action: 'review_next_work'; readonly owner: 'operator'; readonly command: 'work' }

/** @description Exhaustive stable error codes returned by public work-contract operations. */
export const WORK_ERROR_CODES = [
	'activity_missing',
	'active_definition_conflict',
	'aggregate_not_executable',
	'aggregate_not_ready',
	'ambiguous_work_reference',
	'archive_close_failed',
	'archive_close_failed_recovery_required',
	'beads_command_failed',
	'beads_item_limit_exceeded',
	'beads_unavailable',
	'claim_compensation_failed',
	'claim_persistence_failed',
	'candidate_dirty',
	'candidate_missing',
	'candidate_stale',
	'completion_close_failed',
	'completion_close_failed_recovery_required',
	'configuration_locked',
	'configuration_lock_release_failed',
	'canonical_definition_drift',
	'definition_already_exists',
	'definition_drift',
	'evidence_digest_mismatch',
	'evidence_incomplete',
	'evidence_too_large',
	'evidence_unavailable',
	'delivery_gates_incomplete',
	'feedback_write_failed',
	'handoff_audit_failed',
	'handoff_audit_failed_recovery_required',
	'handoff_release_failed',
	'handoff_release_failed_recovery_required',
	'hooks_config_exists',
	'hooks_config_too_large',
	'hooks_config_unavailable',
	'hooks_config_uncommitted',
	'hooks_trust_failed',
	'invalid_actor',
	'invalid_beads_json',
	'invalid_beads_record',
	'invalid_cli_invocation',
	'invalid_completion_record',
	'invalid_context_budget',
	'invalid_depth',
	'invalid_evidence_kind',
	'invalid_external_evidence',
	'invalid_feedback',
	'invalid_frontmatter',
	'invalid_handoff',
	'invalid_hook_input',
	'invalid_hooks_config',
	'integration_locked',
	'integration_lock_release_failed',
	'invalid_ledger_projection',
	'invalid_limit',
	'invalid_operation_input',
	'invalid_integration_lock',
	'invalid_prefix',
	'invalid_proposal',
	'invalid_proposal_id',
	'invalid_proposed_work_graph',
	'invalid_reason',
	'invalid_sync_plan',
	'invalid_telemetry_filter',
	'invalid_telemetry_run_id',
	'invalid_telemetry_session_id',
	'invalid_transition',
	'invalid_work_artifact',
	'invalid_work_graph',
	'invalid_work_manifest',
	'invalid_delivery_receipt',
	'ledger_not_synchronized',
	'orphaned_ledger_item',
	'ownership_conflict',
	'project_mismatch',
	'projection_write_failed',
	'completion_record_write_failed',
	'proposal_apply_failed',
	'proposal_apply_locked',
	'proposal_apply_state_uncertain',
	'proposal_approval_mismatch',
	'proposal_cleanup_failed',
	'proposal_delete_not_authorized',
	'proposal_lock_release_failed',
	'proposal_overlay_failed',
	'proposal_path_not_allowed',
	'proposal_rollback_failed',
	'proposal_source_unavailable',
	'proposal_target_exists',
	'proposal_target_unavailable',
	'proposal_too_large',
	'proposal_unavailable',
	'proposal_validation_failed',
	'provider_busy',
	'provider_capacity_exceeded',
	'provider_failed',
	'provider_lock_release_failed',
	'provider_mutation_failed',
	'relation_reconciliation_failed',
	'review_actor_conflict',
	'review_decision_conflict',
	'review_receipt_invalid',
	'review_report_invalid',
	'review_required',
	'review_target_stale',
	'role_conflict',
	'role_not_allowed',
	'session_conflict',
	'skill_install_conflict',
	'skill_install_failed',
	'source_item_limit_exceeded',
	'source_read_failed',
	'source_too_large',
	'stale_proposal_file',
	'stale_proposal_graph',
	'stale_proposal_graph_source',
	'stale_sync_plan',
	'summary_too_large',
	'summary_unavailable',
	'sync_apply_failed',
	'sync_projection_failed',
	'telemetry_limit_exceeded',
	'telemetry_read_failed',
	'telemetry_write_failed',
	'transition_audit_failed',
	'transition_status_failed',
	'transition_status_failed_recovery_required',
	'unsafe_evidence_path',
	'unsafe_feedback_path',
	'unsafe_hooks_path',
	'unsafe_configuration_lock',
	'unsafe_projection_path',
	'unsafe_proposal_lock',
	'unsafe_proposal_path',
	'unsafe_provider_lock',
	'unsafe_skill_path',
	'unsafe_source_path',
	'unsafe_summary_path',
	'unsafe_telemetry_path',
	'unsafe_work_directory',
	'unsafe_work_reference',
	'unsafe_work_manifest',
	'workspace_required',
	'unsupported_beads',
	'unvalidated_proposal_plan',
	'unvalidated_sync_plan',
	'work_manifest_too_large',
	'work_not_found',
	'work_not_ready',
] as const

/** @description Exhaustive recoverable package error code. */
export type WorkErrorCode = (typeof WORK_ERROR_CODES)[number]

/** @description Runtime schema for the stable recoverable package error envelope. */
export const WorkErrorSchema = strictObject({
	type: literal('work_contract_error'),
	code: picklist(WORK_ERROR_CODES),
	message: string(),
	details: optional(array(string())),
})

/** @description Stable recoverable error envelope returned across package boundaries. */
export interface WorkError {
	readonly type: 'work_contract_error'
	readonly code: WorkErrorCode
	readonly message: string
	readonly details?: readonly string[]
}

/** @description Portable discriminated result specialized to work-contract failures. */
export type WorkResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: WorkError }

/** @description One typed manifest source and its configurable relation aliases. */
export interface WorkSourceConfig {
	readonly kind: WorkArtifactKind
	readonly include: readonly string[]
	readonly parentFields: readonly string[]
	readonly dependencyFields: readonly string[]
}

/** @description Parsed version-one work manifest and effective policies. */
export interface WorkManifest {
	readonly schemaVersion: 1
	readonly projectId: string
	readonly projectUid?: string
	readonly completionLedger?: boolean
	readonly sources: readonly WorkSourceConfig[]
	readonly policies: {
		readonly contextMaxBytes: number
		readonly staleClaimMinutes: number
		readonly terminalEvidence: readonly EvidenceKind[]
		readonly delivery?: WorkDeliveryPolicy
	}
}

/** @description Canonical format for a generated repository-owned project identity. */
export const PROJECT_UID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** @description Repository-relative definition source revision. */
export interface WorkSourceReference {
	readonly path: string
	readonly hash: string
}

/** @description Normalized file-owned node in the work graph. */
export interface WorkArtifact {
	readonly id: string
	readonly kind: WorkArtifactKind
	readonly execution: WorkExecution
	readonly title: string
	readonly parentId?: string
	readonly source: WorkSourceReference
	readonly dependencies: readonly string[]
	readonly acceptance: readonly string[]
	readonly owners: readonly string[]
	readonly roles: readonly string[]
	readonly evidenceRequirements: readonly EvidenceKind[]
	readonly body: string
}

/** @description Deterministic validated graph compiled from one manifest revision. */
export interface CompiledWorkGraph {
	readonly schemaVersion: 1
	readonly projectId: string
	readonly fingerprint: string
	readonly items: readonly WorkArtifact[]
}

/** @description Bounded hierarchy projection rooted at one work item. */
export interface WorkGraphProjection {
	readonly rootId: string
	readonly depth: number
	readonly items: readonly WorkArtifact[]
}

/** @description Bounded Markdown definition context for an agent or human operation. */
export interface ContextPacket {
	readonly schemaVersion: 1
	readonly itemId: string
	readonly graphFingerprint: string
	readonly markdown: string
	readonly truncated: boolean
}

/** @description Read-only, bounded launch packet produced before an agent claims work. */
export interface WorkLaunchPacket {
	readonly schemaVersion: 1
	readonly projectId: string
	readonly graphFingerprint: string
	readonly reference: string
	readonly workId: string
	readonly execution: WorkExecution
	readonly sourcePath: string
	readonly parentId?: string
	readonly dependencies: readonly string[]
	readonly roles: readonly string[]
	readonly evidenceRequirements: readonly EvidenceKind[]
	readonly context: ContextPacket
	readonly deliveryPolicy: WorkDeliveryPolicy
	readonly workspace?: WorkspaceObservation
	readonly providerState?: ProviderStateObservation
	readonly admission: {
		readonly admitted: boolean
		readonly reasons: readonly string[]
	}
	readonly nextActions: readonly WorkNextAction[]
	readonly startable: boolean
}
