/**
 * @description Verifies the public provider schemas reject malformed and oversized boundary data.
 *
 * @module work/provider
 * @file Provider.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Boundary tables contain explicit terminal assertions. */

import { safeParse } from 'valibot'
import { describe, expect, it } from 'vitest'

import { CanonicalDefinitionRevisionSchema, WORK_DEFINITION_LIMITS } from './contracts'
import {
	LedgerActivityInputSchema,
	LedgerClaimInputSchema,
	LedgerDefinitionInputSchema,
	LedgerHandoffInputSchema,
	LedgerItemSchema,
	LedgerReviewInputSchema,
	LedgerRelationsInputSchema,
	LedgerTransitionInputSchema,
	LedgerWorkIdInputSchema,
	sanitizeProviderError,
} from './provider'

const timestamp = '2026-09-02T00:00:00.000Z'
const digest = 'a'.repeat(64)
const expectedDefinition = () => ({
	schemaVersion: 2 as const,
	title: 'Issue title',
	kind: 'issue' as const,
	execution: 'task' as const,
	source: { path: 'docs/work/issues/ISSUE-1.md', hash: digest },
	parentId: undefined,
	dependencies: [],
	roles: ['implementer'],
	evidenceRequirements: ['test'],
})

const definitionInput = () => ({
	projectId: 'example',
	graphFingerprint: digest,
	artifact: {
		id: 'ISSUE-1',
		kind: 'issue',
		execution: 'task',
		title: 'Issue title',
		source: { path: 'docs/work/issues/ISSUE-1.md', hash: digest },
		dependencies: [],
		acceptance: [],
		owners: [],
		roles: [],
		evidenceRequirements: [],
		body: 'Issue body.',
	},
})

const claimInput = () => ({
	workId: 'ISSUE-1',
	actor: 'codex-1',
	role: 'implementer',
	session: 'session-1',
	timestamp,
	expectedDefinition: expectedDefinition(),
	expectedDefinitionClosure: [{ workId: 'ISSUE-1', ...expectedDefinition() }],
	expectedDependencies: [],
})

const handoffInput = () => ({
	workId: 'ISSUE-1',
	actor: 'codex-1',
	role: 'implementer',
	session: 'session-1',
	handoff: {
		actor: 'codex-1',
		summary: 'Continue from the recorded state.',
		remaining: ['Run the focused checks.'],
		references: ['docs/work/issues/ISSUE-1.md'],
		createdAt: timestamp,
		fromSession: 'session-1',
		toActor: 'codex-2',
	},
	release: true,
	expectedDefinition: expectedDefinition(),
	expectedDefinitionClosure: [{ workId: 'ISSUE-1', ...expectedDefinition() }],
})

const completeInput = () => ({
	type: 'complete' as const,
	workId: 'ISSUE-1',
	actor: 'codex-1',
	role: 'implementer',
	session: 'session-1',
	evidence: [
		{
			kind: 'test' as const,
			reference: 'evidence/test.txt',
			digest,
			recordedAt: timestamp,
			actor: 'codex-1',
		},
	],
	timestamp,
	expectedDefinition: expectedDefinition(),
	expectedDefinitionClosure: [{ workId: 'ISSUE-1', ...expectedDefinition() }],
	expectedDependencies: [],
})

describe('public provider schemas', () => {
	it('accepts a bounded independent-review decision and rejects an incomplete subject', () => {
		const review = {
			disposition: 'approved',
			implementationActor: 'implementer',
			subject: {
				repositoryId: digest,
				headSha: '1'.repeat(40),
				treeSha: '2'.repeat(40),
			},
			reviewer: { actor: 'reviewer', session: 'review-session', evaluator: 'agent' },
			report: { reference: 'docs/work/reviews/ISSUE-1.md', digest },
			decidedAt: timestamp,
		}
		const input = {
			workId: 'ISSUE-1',
			review,
			expectedDefinition: expectedDefinition(),
			expectedDefinitionClosure: [{ workId: 'ISSUE-1', ...expectedDefinition() }],
		}

		expect(safeParse(LedgerReviewInputSchema, input).success).toBe(true)
		expect(
			safeParse(LedgerReviewInputSchema, {
				...input,
				review: { ...review, subject: { repositoryId: digest, headSha: '1'.repeat(40) } },
			}).success,
		).toBe(false)
	})

	it.each([
		{ targetRef: 'main', targetSha: '1'.repeat(40), graphFingerprint: digest },
		{ targetRef: 'refs/heads/feature.lock', targetSha: '1'.repeat(40), graphFingerprint: digest },
		{ targetRef: 'refs/heads/a//b', targetSha: '1'.repeat(40), graphFingerprint: digest },
		{ targetRef: 'refs/heads/a..b', targetSha: '1'.repeat(40), graphFingerprint: digest },
		{ targetRef: 'refs/heads/.hidden', targetSha: '1'.repeat(40), graphFingerprint: digest },
		{ targetRef: 'refs/heads/feature/', targetSha: '1'.repeat(40), graphFingerprint: digest },
		{ targetRef: 'refs/heads/main', targetSha: 'not-a-sha', graphFingerprint: digest },
		{ targetRef: 'refs/heads/main', targetSha: '1'.repeat(40), graphFingerprint: 'short' },
	])('rejects an invalid canonical definition revision: %#', (revision) => {
		expect(safeParse(CanonicalDefinitionRevisionSchema, revision).success).toBe(false)
	})

	it('discriminates ledger definition revisions by metadata version', () => {
		const base = {
			providerId: 'provider-issue-1',
			projectId: 'example',
			workId: 'ISSUE-1',
			title: 'Issue title',
			kind: 'issue',
			status: 'open',
			parentId: undefined,
			dependencies: [],
			roles: [],
			evidenceRequirements: [],
			source: { path: 'docs/ISSUE-1.md', hash: digest },
			graphFingerprint: digest,
			assignee: undefined,
			activity: undefined,
			handoff: undefined,
			evidence: [],
			blockReason: undefined,
			updatedAt: timestamp,
		}
		const definitionRevision = {
			targetRef: 'refs/heads/main',
			targetSha: '1'.repeat(40),
			graphFingerprint: digest,
		}

		expect(safeParse(LedgerItemSchema, { ...base, definitionSchemaVersion: 3 }).success).toBe(false)
		for (const definitionSchemaVersion of [1, 2] as const) {
			expect(
				safeParse(LedgerItemSchema, {
					...base,
					definitionSchemaVersion,
					definitionRevision,
				}).success,
			).toBe(false)
		}
		expect(
			safeParse(LedgerItemSchema, {
				...base,
				definitionSchemaVersion: 3,
				definitionRevision: { ...definitionRevision, graphFingerprint: 'b'.repeat(64) },
			}).success,
		).toBe(false)
		expect(
			safeParse(LedgerItemSchema, {
				...base,
				definitionSchemaVersion: 3,
				definitionRevision,
			}).success,
		).toBe(true)
	})

	it('discriminates actor definition expectations by metadata version and fingerprint', () => {
		const revision = {
			targetRef: 'refs/heads/main',
			targetSha: '1'.repeat(40),
			graphFingerprint: 'b'.repeat(64),
		}
		const input = claimInput()
		const validExpectation = {
			...expectedDefinition(),
			schemaVersion: 3 as const,
			graphFingerprint: revision.graphFingerprint,
			definitionRevision: revision,
		}
		const invalidExpectations = [
			{
				...expectedDefinition(),
				schemaVersion: 3 as const,
				graphFingerprint: revision.graphFingerprint,
			},
			{ ...expectedDefinition(), definitionRevision: revision },
			{
				...expectedDefinition(),
				schemaVersion: 3 as const,
				graphFingerprint: 'c'.repeat(64),
				definitionRevision: revision,
			},
		]

		for (const expectedDefinitionValue of invalidExpectations) {
			expect(
				safeParse(LedgerClaimInputSchema, {
					...input,
					expectedDefinition: expectedDefinitionValue,
					expectedDefinitionClosure: [{ workId: input.workId, ...validExpectation }],
				}).success,
			).toBe(false)
			expect(
				safeParse(LedgerClaimInputSchema, {
					...input,
					expectedDefinition: validExpectation,
					expectedDefinitionClosure: [{ workId: input.workId, ...expectedDefinitionValue }],
				}).success,
			).toBe(false)
			expect(
				safeParse(LedgerClaimInputSchema, {
					...input,
					expectedDefinition: validExpectation,
					expectedDefinitionClosure: [{ workId: input.workId, ...validExpectation }],
					expectedDependencies: [{ workId: 'ISSUE-0', ...expectedDefinitionValue }],
				}).success,
			).toBe(false)
		}
		expect(
			safeParse(LedgerClaimInputSchema, {
				...input,
				expectedDefinition: validExpectation,
				expectedDefinitionClosure: [{ workId: input.workId, ...validExpectation }],
			}).success,
		).toBe(true)
	})

	it('rejects inconsistent canonical definition revisions', () => {
		expect(
			safeParse(LedgerDefinitionInputSchema, {
				...definitionInput(),
				definitionRevision: {
					targetRef: 'refs/heads/main',
					targetSha: '1'.repeat(40),
					graphFingerprint: 'b'.repeat(64),
				},
			}).success,
		).toBe(false)
	})

	it('redacts provider failures while preserving bounded recovery semantics', () => {
		const canary = `PRIVATE_PROVIDER_${'x'.repeat(100_000)}`
		const result = sanitizeProviderError({
			type: 'work_contract_error',
			code: canary,
			message: canary,
			details: [
				canary,
				'stateMayHaveChanged=true',
				'retrySafe=true',
				'cleanupFailure=provider_lock_release_failed',
				`cleanupFailure=${canary}`,
			],
		})

		expect(result).toMatchObject({
			code: 'provider_failed',
			details: [
				'stateMayHaveChanged=true',
				'retrySafe=true',
				'cleanupFailure=provider_lock_release_failed',
				'recovery=inspect provider state and reconcile before retrying',
			],
		})
		expect(JSON.stringify(result)).not.toContain(canary)
		expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(1024)

		const flooded = sanitizeProviderError({
			code: 'provider_failed',
			details: Array.from({ length: 100_000 }, (_, index) =>
				index === 99_999 ? 'retrySafe=true' : canary,
			),
		})
		expect(flooded).not.toHaveProperty('details')
	})

	it('preserves the allowlisted temporary metadata cleanup marker', () => {
		const result = sanitizeProviderError({
			code: 'provider_failed',
			details: ['cleanupFailure=temporary_metadata_cleanup_failed'],
		})

		expect(result.details).toContain('cleanupFailure=temporary_metadata_cleanup_failed')
	})

	it('bounds actor and session labels by UTF-8 bytes while accepting ordinary Unicode', () => {
		// Given: valid human labels at their exact byte ceilings and one byte beyond them
		const actorAtLimit = `${'界'.repeat(42)}ab`
		const roleAtLimit = '😀'.repeat(32)
		const sessionAtLimit = '😀'.repeat(64)

		// When: the public claim schema parses each label
		const accepted = safeParse(LedgerClaimInputSchema, {
			...claimInput(),
			actor: actorAtLimit,
			role: roleAtLimit,
			session: sessionAtLimit,
		})
		const actorTooLarge = safeParse(LedgerClaimInputSchema, {
			...claimInput(),
			actor: `${actorAtLimit}a`,
		})
		const roleTooLarge = safeParse(LedgerClaimInputSchema, {
			...claimInput(),
			role: `${roleAtLimit}a`,
		})
		const sessionTooLarge = safeParse(LedgerClaimInputSchema, {
			...claimInput(),
			session: `${sessionAtLimit}a`,
		})

		// Then: exact limits pass and byte-overflow values fail
		expect(Buffer.byteLength(actorAtLimit, 'utf8')).toBe(128)
		expect(Buffer.byteLength(roleAtLimit, 'utf8')).toBe(128)
		expect(Buffer.byteLength(sessionAtLimit, 'utf8')).toBe(256)
		expect(accepted.success).toBe(true)
		expect(actorTooLarge.success).toBe(false)
		expect(roleTooLarge.success).toBe(false)
		expect(sessionTooLarge.success).toBe(false)
	})

	it('accepts ordinary Unicode human identity labels', () => {
		// Given/When: ordinary internationalized labels cross the public claim boundary
		const result = safeParse(LedgerClaimInputSchema, {
			...claimInput(),
			actor: 'Zoë-代理人',
			role: '工程师',
			session: '会話-😀',
		})

		// Then: semantic human labels are not restricted to ASCII
		expect(result.success).toBe(true)
	})

	it.each([
		['actor', '   '],
		['actor', 'codex\n2'],
		['role', '   '],
		['role', 'review\0owner'],
		['session', '   '],
		['session', 'session\u007F2'],
	] as const)('rejects invalid %s labels before provider use', (field, value) => {
		// Given: a claim with a blank or control-bearing identity label
		const input = { ...claimInput(), [field]: value }

		// When: the public claim schema parses it
		const result = safeParse(LedgerClaimInputSchema, input)

		// Then: the malformed label is rejected
		expect(result.success).toBe(false)
	})

	it('bounds definition strings by UTF-8 bytes', () => {
		// Given: multibyte title and body values at and immediately above their byte ceilings
		const titleAtLimit = `${'😀'.repeat(124)}abcd`
		const bodyAtLimit = '😀'.repeat(1_250_000)
		const input = definitionInput()

		// When: the public definition schema parses each boundary value
		const accepted = safeParse(LedgerDefinitionInputSchema, {
			...input,
			artifact: { ...input.artifact, title: titleAtLimit, body: bodyAtLimit },
		})
		const titleTooLarge = safeParse(LedgerDefinitionInputSchema, {
			...input,
			artifact: { ...input.artifact, title: `${titleAtLimit}a` },
		})
		const bodyTooLarge = safeParse(LedgerDefinitionInputSchema, {
			...input,
			artifact: { ...input.artifact, body: `${bodyAtLimit}a` },
		})

		// Then: byte limits, rather than UTF-16 code-unit counts, own acceptance
		expect(Buffer.byteLength(titleAtLimit, 'utf8')).toBe(500)
		expect(Buffer.byteLength(bodyAtLimit, 'utf8')).toBe(5_000_000)
		expect(accepted.success).toBe(true)
		expect(titleTooLarge.success).toBe(false)
		expect(bodyTooLarge.success).toBe(false)
	})

	it('bounds acceptance at the safe aggregate argv transport budget', () => {
		const atLimit = ['a'.repeat(2000), ...Array.from({ length: 7 }, () => 'a'.repeat(1999))]
		const tooLarge = [atLimit[0] ?? '', `${atLimit[1] ?? ''}a`, ...atLimit.slice(2)]
		const input = definitionInput()

		const accepted = safeParse(LedgerDefinitionInputSchema, {
			...input,
			artifact: { ...input.artifact, acceptance: atLimit },
		})
		const rejected = safeParse(LedgerDefinitionInputSchema, {
			...input,
			artifact: { ...input.artifact, acceptance: tooLarge },
		})

		expect(Buffer.byteLength(atLimit.join('\n'), 'utf8')).toBe(
			WORK_DEFINITION_LIMITS.acceptanceBytes,
		)
		expect(accepted.success).toBe(true)
		expect(rejected.success).toBe(false)
	})

	it('bounds work IDs and accepts the exact ASCII ceiling', () => {
		// Given: work IDs at and one byte above the public ceiling
		const atLimit = `${'A'.repeat(63)}-${'B'.repeat(64)}`
		const tooLarge = `${'A'.repeat(64)}-${'B'.repeat(64)}`

		// When: the work-ID schema parses them
		const accepted = safeParse(LedgerWorkIdInputSchema, { workId: atLimit })
		const rejected = safeParse(LedgerWorkIdInputSchema, { workId: tooLarge })

		// Then: the exact bound passes and the extra byte fails
		expect(Buffer.byteLength(atLimit, 'utf8')).toBe(128)
		expect(Buffer.byteLength(tooLarge, 'utf8')).toBe(129)
		expect(accepted.success).toBe(true)
		expect(rejected.success).toBe(false)
	})

	it.each([' issue-1', 'ISSUE 1', 'ISSUE-1\n', 'ＩＳＳＵＥ-1'])(
		'rejects malformed work ID %j',
		(workId) => {
			// Given/When: a non-canonical work identifier crosses the public schema
			const result = safeParse(LedgerWorkIdInputSchema, { workId })

			// Then: IDs remain canonical ASCII tokens
			expect(result.success).toBe(false)
		},
	)

	it('bounds repository-relative Unicode source paths by UTF-8 bytes', () => {
		// Given: a repository-relative Unicode path at and one byte beyond the limit
		const atLimit = `docs/${'界'.repeat(164)}abc`
		const tooLarge = `${atLimit}a`
		const input = definitionInput()

		// When: the definition schema parses each path
		const accepted = safeParse(LedgerDefinitionInputSchema, {
			...input,
			artifact: { ...input.artifact, source: { ...input.artifact.source, path: atLimit } },
		})
		const rejected = safeParse(LedgerDefinitionInputSchema, {
			...input,
			artifact: { ...input.artifact, source: { ...input.artifact.source, path: tooLarge } },
		})

		// Then: the exact UTF-8 ceiling passes and the overflow fails
		expect(Buffer.byteLength(atLimit, 'utf8')).toBe(500)
		expect(accepted.success).toBe(true)
		expect(rejected.success).toBe(false)
	})

	it.each([
		'/absolute/ISSUE-1.md',
		String.raw`C:\work\ISSUE-1.md`,
		String.raw`\\server\share\ISSUE-1.md`,
		String.raw`docs\..\outside.md`,
		'   ',
		'docs/work\nISSUE-1.md',
	])('rejects non-repository source path %j', (path) => {
		// Given: a definition with a non-relative or malformed source path
		const input = definitionInput()

		// When: the public definition schema parses it
		const result = safeParse(LedgerDefinitionInputSchema, {
			...input,
			artifact: { ...input.artifact, source: { ...input.artifact.source, path } },
		})

		// Then: the source reference is rejected before provider use
		expect(result.success).toBe(false)
	})

	it('bounds transition reasons and evidence references by UTF-8 bytes', () => {
		// Given: multibyte values at and immediately above their byte ceilings
		const atLimit = '😀'.repeat(500)
		const transition = {
			type: 'block' as const,
			workId: 'ISSUE-1',
			actor: 'codex-1',
			reason: atLimit,
			expectedDefinition: expectedDefinition(),
			expectedDefinitionClosure: [{ workId: 'ISSUE-1', ...expectedDefinition() }],
		}
		const complete = completeInput()

		// When: transition and evidence schemas parse those values
		const acceptedReason = safeParse(LedgerTransitionInputSchema, transition)
		const rejectedReason = safeParse(LedgerTransitionInputSchema, {
			...transition,
			reason: `${atLimit}a`,
		})
		const acceptedReference = safeParse(LedgerTransitionInputSchema, {
			...complete,
			evidence: [{ ...complete.evidence[0], reference: atLimit }],
		})
		const rejectedReference = safeParse(LedgerTransitionInputSchema, {
			...complete,
			evidence: [{ ...complete.evidence[0], reference: `${atLimit}a` }],
		})

		// Then: both public values use their documented 2000-byte ceiling
		expect(Buffer.byteLength(atLimit, 'utf8')).toBe(2000)
		expect(acceptedReason.success).toBe(true)
		expect(rejectedReason.success).toBe(false)
		expect(acceptedReference.success).toBe(true)
		expect(rejectedReference.success).toBe(false)
	})

	it('requires explicit direct-child expectations for aggregate completion', () => {
		const complete = completeInput()
		const aggregateDefinition = { ...expectedDefinition(), execution: 'aggregate' as const }
		const aggregateComplete = {
			...complete,
			expectedDefinition: aggregateDefinition,
			expectedDefinitionClosure: [{ workId: complete.workId, ...aggregateDefinition }],
		}

		expect(safeParse(LedgerTransitionInputSchema, aggregateComplete).success).toBe(false)
		expect(
			safeParse(LedgerTransitionInputSchema, {
				...aggregateComplete,
				expectedChildren: [],
			}).success,
		).toBe(false)
		expect(
			safeParse(LedgerTransitionInputSchema, {
				...aggregateComplete,
				expectedChildren: [{ workId: 'ISSUE-2', ...expectedDefinition() }],
			}).success,
		).toBe(true)
	})

	it.each(['', '   ', 'line one\nline two', 'reason\0suffix'])(
		'rejects invalid transition reason %j',
		(reason) => {
			// Given/When: an empty, blank, or control-bearing reason crosses the schema
			const result = safeParse(LedgerTransitionInputSchema, {
				type: 'release',
				workId: 'ISSUE-1',
				actor: 'codex-1',
				reason,
			})

			// Then: the transition is rejected
			expect(result.success).toBe(false)
		},
	)

	it('bounds handoff summary strings by UTF-8 bytes', () => {
		// Given: a multibyte summary at and one byte beyond its ceiling
		const atLimit = `${'界'.repeat(1333)}a`
		const input = handoffInput()

		// When: the handoff schema parses each value
		const accepted = safeParse(LedgerHandoffInputSchema, {
			...input,
			handoff: { ...input.handoff, summary: atLimit },
		})
		const rejected = safeParse(LedgerHandoffInputSchema, {
			...input,
			handoff: { ...input.handoff, summary: `${atLimit}a` },
		})

		// Then: byte-accurate bounds decide the result
		expect(Buffer.byteLength(atLimit, 'utf8')).toBe(4000)
		expect(accepted.success).toBe(true)
		expect(rejected.success).toBe(false)
	})

	it('accepts bounded multiline Markdown handoff summaries', () => {
		const input = handoffInput()

		expect(
			safeParse(LedgerHandoffInputSchema, {
				...input,
				handoff: {
					...input.handoff,
					summary: 'Completed the investigation.\n\n## Remaining\n\n- Run integration tests.',
				},
			}).success,
		).toBe(true)
	})

	it.each([
		['summary', '   '],
		['summary', 'line one\u000Bline two'],
		['actor', 'codex\0one'],
		['fromSession', 'session\u001Fone'],
		['toActor', 'codex\u007Ftwo'],
	] as const)('rejects invalid handoff %s strings', (field, value) => {
		// Given: a handoff containing a blank or control-bearing scalar
		const input = handoffInput()

		// When: the public handoff schema parses it
		const result = safeParse(LedgerHandoffInputSchema, {
			...input,
			handoff: { ...input.handoff, [field]: value },
		})

		// Then: the handoff is rejected
		expect(result.success).toBe(false)
	})

	it.each([
		['remaining', ['valid', '   ']],
		['remaining', ['valid', 'bad\nentry']],
		['references', ['valid', '']],
		['references', ['valid', 'bad\0reference']],
	] as const)('rejects control-bearing handoff %s entries', (field, value) => {
		// Given: a handoff collection with one malformed string
		const input = handoffInput()

		// When: the public handoff schema parses it
		const result = safeParse(LedgerHandoffInputSchema, {
			...input,
			handoff: { ...input.handoff, [field]: value },
		})

		// Then: the entire handoff fails closed
		expect(result.success).toBe(false)
	})

	it('enforces public collection count ceilings', () => {
		// Given: every public collection with one entry beyond its declared ceiling
		const definition = definitionInput()
		const handoff = handoffInput()
		const complete = completeInput()
		const evidence = complete.evidence[0]

		// When: each owning schema parses the oversized collection
		const results = [
			safeParse(LedgerRelationsInputSchema, {
				workId: 'ISSUE-1',
				parentId: undefined,
				dependencies: Array.from({ length: 1001 }, (_, index) => `ISSUE-${index + 1}`),
			}),
			safeParse(LedgerDefinitionInputSchema, {
				...definition,
				artifact: {
					...definition.artifact,
					acceptance: Array.from({ length: 1001 }, () => 'criterion'),
				},
			}),
			safeParse(LedgerDefinitionInputSchema, {
				...definition,
				artifact: {
					...definition.artifact,
					owners: Array.from({ length: 101 }, () => 'owner'),
				},
			}),
			safeParse(LedgerDefinitionInputSchema, {
				...definition,
				artifact: {
					...definition.artifact,
					roles: Array.from({ length: 101 }, () => 'role'),
				},
			}),
			safeParse(LedgerDefinitionInputSchema, {
				...definition,
				artifact: {
					...definition.artifact,
					evidenceRequirements: Array.from({ length: 101 }, () => 'test'),
				},
			}),
			safeParse(LedgerHandoffInputSchema, {
				...handoff,
				handoff: {
					...handoff.handoff,
					remaining: Array.from({ length: 101 }, () => 'remaining'),
				},
			}),
			safeParse(LedgerHandoffInputSchema, {
				...handoff,
				handoff: {
					...handoff.handoff,
					references: Array.from({ length: 101 }, () => 'reference'),
				},
			}),
			safeParse(LedgerTransitionInputSchema, {
				...complete,
				evidence: Array.from({ length: 101 }, () => evidence),
			}),
			safeParse(LedgerClaimInputSchema, {
				...claimInput(),
				expectedDefinition: {
					...expectedDefinition(),
					dependencies: Array.from({ length: 1001 }, (_, index) => `ISSUE-${index + 1}`),
				},
			}),
			safeParse(LedgerClaimInputSchema, {
				...claimInput(),
				expectedDependencies: Array.from({ length: 1001 }, (_, index) => ({
					workId: `ISSUE-${index + 1}`,
					...expectedDefinition(),
				})),
			}),
			safeParse(LedgerClaimInputSchema, {
				...claimInput(),
				expectedDefinition: {
					...expectedDefinition(),
					roles: Array.from({ length: 101 }, () => 'implementer'),
				},
			}),
			safeParse(LedgerClaimInputSchema, {
				...claimInput(),
				expectedDefinition: {
					...expectedDefinition(),
					evidenceRequirements: Array.from({ length: 101 }, () => 'test'),
				},
			}),
		]

		// Then: every oversized collection is rejected
		expect(results.every((result) => !result.success)).toBe(true)
	})

	it('requires target and dependency expectations to use unique dependency work IDs', () => {
		const duplicateDefinition = { ...expectedDefinition(), dependencies: ['ISSUE-2', 'ISSUE-2'] }
		const results = [
			safeParse(LedgerClaimInputSchema, {
				...claimInput(),
				expectedDefinition: duplicateDefinition,
			}),
			safeParse(LedgerClaimInputSchema, {
				...claimInput(),
				expectedDependencies: [
					{ workId: 'ISSUE-2', ...expectedDefinition() },
					{ workId: 'ISSUE-2', ...expectedDefinition() },
				],
			}),
		]

		expect(results.every((result) => !result.success)).toBe(true)
	})

	it('requires the guarded target in every actor-mutation definition closure', () => {
		const input = claimInput()
		const result = safeParse(LedgerClaimInputSchema, {
			...input,
			expectedDefinitionClosure: [
				{
					workId: 'ISSUE-2',
					...expectedDefinition(),
					source: { ...expectedDefinition().source, path: 'docs/work/issues/ISSUE-2.md' },
				},
			],
		})

		expect(result.success).toBe(false)
	})

	it.each([
		['digest', 'A'.repeat(64)],
		['digest', 'a'.repeat(63)],
		['recordedAt', 'not-a-timestamp'],
	] as const)('rejects invalid evidence %s values', (field, value) => {
		// Given: a completion containing malformed durable evidence metadata
		const input = completeInput()

		// When: the transition schema parses the evidence receipt
		const result = safeParse(LedgerTransitionInputSchema, {
			...input,
			evidence: [{ ...input.evidence[0], [field]: value }],
		})

		// Then: invalid hashes and timestamps are rejected
		expect(result.success).toBe(false)
	})

	it.each([
		['claim', LedgerClaimInputSchema, { ...claimInput(), timestamp: '2026-09-02' }],
		[
			'activity',
			LedgerActivityInputSchema,
			{
				...claimInput(),
				activity: {
					actor: 'codex-1',
					role: 'implementer',
					session: 'session-1',
					startedAt: 'invalid',
					touchedAt: timestamp,
				},
			},
		],
		[
			'handoff',
			LedgerHandoffInputSchema,
			{
				...handoffInput(),
				handoff: { ...handoffInput().handoff, createdAt: 'invalid' },
			},
		],
	] as const)('rejects invalid %s timestamps', (_name, schema, input) => {
		// Given/When: malformed time metadata crosses a public operation schema
		const result = safeParse(schema, input)

		// Then: the operation is rejected
		expect(result.success).toBe(false)
	})
})
