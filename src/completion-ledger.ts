/**
 * @description Reads and writes the repository-owned completion ledger.
 *
 * @module work/completion-ledger
 * @file Completion-ledger.ts
 */

import { createHash } from 'node:crypto'
import { opendir } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
	array,
	custom,
	isoTimestamp,
	literal,
	maxLength,
	minLength,
	optional,
	picklist,
	pipe,
	regex,
	safeParse,
	strictObject,
	string,
} from 'valibot'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import type { EvidenceKind, WorkResult } from './contracts'
import { WORK_DEFINITION_LIMITS, WORK_ID_PATTERN } from './contracts'
import {
	INPUT_LIMITS,
	readBoundedContainedFile,
	readBoundedContainedUtf8,
	writeUtf8NoFollow,
} from './files'
import { prepareSafeOutputPath } from './paths'

export const COMPLETION_LEDGER_DIRECTORY = 'docs/work/ledger'
const MAX_RECORD_BYTES = 64 * 1024
const MAX_RECORDS = 10_000

const EvidenceKindSchema = custom<EvidenceKind>(
	(value) =>
		typeof value === 'string' &&
		Buffer.byteLength(value, 'utf8') <= WORK_DEFINITION_LIMITS.identityBytes &&
		(['test', 'review', 'build', 'ci', 'security', 'artifact'].includes(value) ||
			/^custom:[a-z][a-z0-9-]*$/u.test(value)),
)

const EvidenceSchema = strictObject({
	kind: EvidenceKindSchema,
	reference: pipe(string(), minLength(1), maxLength(500)),
	digest: pipe(string(), regex(/^[a-f0-9]{64}$/u)),
})

const CompletionRecordSchema = strictObject({
	version: literal(1),
	work_id: pipe(string(), regex(WORK_ID_PATTERN)),
	state: picklist(['open', 'closed']),
	implementation: optional(pipe(string(), regex(/^[a-f0-9]{40,64}$/u))),
	completed_at: optional(pipe(string(), maxLength(40), isoTimestamp())),
	reopened_at: optional(pipe(string(), maxLength(40), isoTimestamp())),
	actor: pipe(string(), minLength(1), maxLength(256)),
	role: optional(pipe(string(), minLength(1), maxLength(128))),
	session: optional(pipe(string(), minLength(1), maxLength(256))),
	reason: optional(pipe(string(), minLength(1), maxLength(2000))),
	evidence: array(EvidenceSchema),
})

interface CompletionEvidence {
	readonly kind: EvidenceKind
	readonly reference: string
	readonly digest: string
}

export interface CompletionRecord {
	readonly version: 1
	readonly workId: string
	readonly state: 'open' | 'closed'
	readonly implementation?: string
	readonly completedAt?: string
	readonly reopenedAt?: string
	readonly actor: string
	readonly role?: string
	readonly session?: string
	readonly reason?: string
	readonly evidence: readonly CompletionEvidence[]
}

/** @description Verifies repository evidence and constructs a closed completion record. */
export const buildCompletionRecord = async (input: {
	readonly root: string
	readonly workId: string
	readonly actor: string
	readonly role?: string
	readonly session?: string
	readonly implementation?: string
	readonly completedAt?: string
	readonly requiredEvidence: readonly EvidenceKind[]
	readonly evidence: readonly {
		readonly kind: EvidenceKind
		readonly reference: string
		readonly digest?: string
	}[]
}): Promise<WorkResult<CompletionRecord>> => {
	const evidence: CompletionEvidence[] = []
	const kinds = new Set<EvidenceKind>()
	for (const candidate of input.evidence) {
		if (kinds.has(candidate.kind)) {
			return failure(`Completion record ${input.workId} contains duplicate evidence kinds.`)
		}
		const content = await readBoundedContainedFile({
			root: input.root,
			reference: candidate.reference,
			maxBytes: INPUT_LIMITS.evidenceBytes,
			unsafeCode: 'unsafe_evidence_path',
			unavailableCode: 'evidence_unavailable',
			tooLargeCode: 'evidence_too_large',
			label: 'Completion evidence',
		})
		if (!content.ok) {
			return content
		}
		const digest = createHash('sha256').update(content.value).digest('hex')
		if (candidate.digest !== undefined && candidate.digest !== digest) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'evidence_digest_mismatch',
					message: 'Evidence digest does not match the current file.',
				},
			}
		}
		kinds.add(candidate.kind)
		evidence.push({ kind: candidate.kind, reference: candidate.reference, digest })
	}
	const missing = input.requiredEvidence.filter((kind) => !kinds.has(kind))
	if (missing.length > 0) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'evidence_incomplete',
				message: `Missing required evidence: ${missing.join(', ')}.`,
			},
		}
	}
	return {
		ok: true,
		value: {
			version: 1,
			workId: input.workId,
			state: 'closed',
			...(input.implementation === undefined ? {} : { implementation: input.implementation }),
			completedAt: input.completedAt ?? new Date().toISOString(),
			actor: input.actor,
			...(input.role === undefined ? {} : { role: input.role }),
			...(input.session === undefined ? {} : { session: input.session }),
			evidence,
		},
	}
}

const failure = (message: string): WorkResult<never> => ({
	ok: false,
	error: { type: 'work_contract_error', code: 'invalid_completion_record', message },
})

const isMissing = (error: unknown): boolean =>
	typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const pathFor = (workId: string): string => `${COMPLETION_LEDGER_DIRECTORY}/${workId}.yaml`

const parseRecord = (source: string, expectedWorkId: string): WorkResult<CompletionRecord> => {
	let document: unknown
	try {
		document = parseYaml(source)
	} catch {
		return failure(`Completion record ${expectedWorkId} is not valid YAML.`)
	}
	const parsed = safeParse(CompletionRecordSchema, document)
	if (!parsed.success || parsed.output.work_id !== expectedWorkId) {
		return failure(`Completion record ${expectedWorkId} failed schema validation.`)
	}
	if (
		(parsed.output.state === 'closed' && parsed.output.completed_at === undefined) ||
		(parsed.output.state === 'open' && parsed.output.reopened_at === undefined)
	) {
		return failure(`Completion record ${expectedWorkId} is missing its state timestamp.`)
	}
	const evidenceKinds = new Set<string>()
	for (const evidence of parsed.output.evidence) {
		if (evidenceKinds.has(evidence.kind)) {
			return failure(`Completion record ${expectedWorkId} contains duplicate evidence kinds.`)
		}
		evidenceKinds.add(evidence.kind)
	}
	return {
		ok: true,
		value: {
			version: 1,
			workId: parsed.output.work_id,
			state: parsed.output.state,
			...(parsed.output.implementation === undefined
				? {}
				: { implementation: parsed.output.implementation }),
			...(parsed.output.completed_at === undefined
				? {}
				: { completedAt: parsed.output.completed_at }),
			...(parsed.output.reopened_at === undefined ? {} : { reopenedAt: parsed.output.reopened_at }),
			actor: parsed.output.actor,
			...(parsed.output.role === undefined ? {} : { role: parsed.output.role }),
			...(parsed.output.session === undefined ? {} : { session: parsed.output.session }),
			...(parsed.output.reason === undefined ? {} : { reason: parsed.output.reason }),
			evidence: parsed.output.evidence,
		},
	}
}

/** @description Reads every bounded, item-scoped completion record in a repository snapshot. */
export const loadCompletionLedger = async (input: {
	readonly root: string
}): Promise<WorkResult<readonly CompletionRecord[]>> => {
	const directory = resolve(input.root, COMPLETION_LEDGER_DIRECTORY)
	let handle: Awaited<ReturnType<typeof opendir>>
	try {
		handle = await opendir(directory)
	} catch (error: unknown) {
		return isMissing(error)
			? { ok: true, value: [] }
			: failure('Completion ledger cannot be opened.')
	}
	const records: CompletionRecord[] = []
	try {
		for await (const entry of handle) {
			if (!entry.isFile() || !entry.name.endsWith('.yaml')) {
				return failure('Completion ledger may contain only YAML record files.')
			}
			if (records.length >= MAX_RECORDS) {
				return failure('Completion ledger contains too many records.')
			}
			const workId = entry.name.slice(0, -'.yaml'.length)
			if (!WORK_ID_PATTERN.test(workId)) {
				return failure(`Completion ledger contains an invalid work ID ${workId}.`)
			}
			const source = await readBoundedContainedUtf8({
				root: input.root,
				reference: pathFor(workId),
				maxBytes: MAX_RECORD_BYTES,
				unsafeCode: 'invalid_completion_record',
				unavailableCode: 'invalid_completion_record',
				tooLargeCode: 'invalid_completion_record',
				label: 'Completion record',
			})
			if (!source.ok) {
				return source
			}
			const record = parseRecord(source.value, workId)
			if (!record.ok) {
				return record
			}
			records.push(record.value)
		}
	} catch (error: unknown) {
		return records.length === 0 && isMissing(error)
			? { ok: true, value: [] }
			: failure('Completion ledger could not be read safely.')
	}
	return {
		ok: true,
		value: records.toSorted((left, right) => left.workId.localeCompare(right.workId)),
	}
}

/** @description Writes exactly one selected completion record in the caller's worktree. */
export const writeCompletionRecord = async (input: {
	readonly root: string
	readonly record: CompletionRecord
}): Promise<WorkResult<{ readonly path: string; readonly record: CompletionRecord }>> => {
	const serialized = stringifyYaml({
		version: 1,
		work_id: input.record.workId,
		state: input.record.state,
		...(input.record.implementation === undefined
			? {}
			: { implementation: input.record.implementation }),
		...(input.record.completedAt === undefined ? {} : { completed_at: input.record.completedAt }),
		...(input.record.reopenedAt === undefined ? {} : { reopened_at: input.record.reopenedAt }),
		actor: input.record.actor,
		...(input.record.role === undefined ? {} : { role: input.record.role }),
		...(input.record.session === undefined ? {} : { session: input.record.session }),
		...(input.record.reason === undefined ? {} : { reason: input.record.reason }),
		evidence: input.record.evidence,
	})
	const parsed = parseRecord(serialized, input.record.workId)
	if (!parsed.ok || Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
		return parsed.ok ? failure('Completion record exceeds its size limit.') : parsed
	}
	const path = pathFor(input.record.workId)
	const target = await prepareSafeOutputPath({
		root: input.root,
		path,
		errorCode: 'invalid_completion_record',
	})
	if (!target.ok) {
		return target
	}
	try {
		await writeUtf8NoFollow({ path: target.value, content: serialized, mode: 'replace' })
		return { ok: true, value: { path, record: parsed.value } }
	} catch {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'completion_record_write_failed',
				message: `Unable to write completion record for ${input.record.workId}.`,
			},
		}
	}
}
