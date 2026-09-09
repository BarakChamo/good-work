/**
 * @description Owns durable independent-review receipts and exact implementation-tree validation.
 *
 * @module work/review
 * @file Review.ts
 */

import { createHash } from 'node:crypto'

import {
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
import type { InferOutput } from 'valibot'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import type { WorkResult } from './contracts'
import { WORK_ID_PATTERN } from './contracts'
import { readBoundedContainedUtf8, writeUtf8NoFollow } from './files'
import { observeGitWorkspace } from './git-observer'
import { prepareSafeOutputPath } from './paths'
import { executeFile } from './subprocess'

export const REVIEW_DIRECTORY = 'docs/work/reviews'
const MAX_REVIEW_REPORT_BYTES = 128 * 1024
const MAX_REVIEW_RECEIPT_BYTES = 32 * 1024

const HashSchema = pipe(string(), regex(/^[a-f0-9]{64}$/u))
const CommitHashSchema = pipe(string(), regex(/^[a-f0-9]{40,64}$/u))
const BoundedIdentitySchema = pipe(string(), minLength(1), maxLength(256))
const RepositoryPathSchema = pipe(
	string(),
	minLength(1),
	maxLength(2000),
	regex(/^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/u),
)

const ReviewReceiptSchema = strictObject({
	version: literal(1),
	project_id: pipe(string(), minLength(1), maxLength(128)),
	work_id: pipe(string(), regex(WORK_ID_PATTERN)),
	definition_hash: HashSchema,
	disposition: picklist(['approved', 'changes_requested']),
	implementation_actor: BoundedIdentitySchema,
	reviewed_repository: HashSchema,
	reviewed_head: CommitHashSchema,
	reviewed_tree: CommitHashSchema,
	reviewer: strictObject({
		actor: BoundedIdentitySchema,
		session: optional(BoundedIdentitySchema),
		evaluator: picklist(['agent', 'human']),
	}),
	report: strictObject({ reference: RepositoryPathSchema, digest: HashSchema }),
	decided_at: pipe(string(), maxLength(40), isoTimestamp()),
})

/** @description Exact clean Git revision handed to an independent reviewer. */
export interface ReviewSubject {
	readonly repositoryId: string
	readonly headSha: string
	readonly treeSha: string
}

/** @description Durable repository receipt for one independent review decision. */
export interface ReviewReceipt {
	readonly version: 1
	readonly projectId: string
	readonly workId: string
	readonly definitionHash: string
	readonly disposition: 'approved' | 'changes_requested'
	readonly implementationActor: string
	readonly subject: ReviewSubject
	readonly reviewer: {
		readonly actor: string
		readonly session?: string
		readonly evaluator: 'agent' | 'human'
	}
	readonly report: { readonly reference: string; readonly digest: string }
	readonly decidedAt: string
}

const failure = (
	code:
		| 'review_decision_conflict'
		| 'review_receipt_invalid'
		| 'review_report_invalid'
		| 'review_target_stale',
	message: string,
): WorkResult<never> => ({
	ok: false,
	error: { type: 'work_contract_error', code, message },
})

const receiptPathFor = (workId: string): string => `${REVIEW_DIRECTORY}/${workId}.yaml`
const completionPathFor = (workId: string): string => `docs/work/ledger/${workId}.yaml`

const toReceipt = (value: InferOutput<typeof ReviewReceiptSchema>): ReviewReceipt => ({
	version: 1,
	projectId: value.project_id,
	workId: value.work_id,
	definitionHash: value.definition_hash,
	disposition: value.disposition,
	implementationActor: value.implementation_actor,
	subject: {
		repositoryId: value.reviewed_repository,
		headSha: value.reviewed_head,
		treeSha: value.reviewed_tree,
	},
	reviewer: {
		actor: value.reviewer.actor,
		...(value.reviewer.session === undefined ? {} : { session: value.reviewer.session }),
		evaluator: value.reviewer.evaluator,
	},
	report: value.report,
	decidedAt: value.decided_at,
})

const serializeReceipt = (receipt: ReviewReceipt): string =>
	stringifyYaml({
		version: 1,
		project_id: receipt.projectId,
		work_id: receipt.workId,
		definition_hash: receipt.definitionHash,
		disposition: receipt.disposition,
		implementation_actor: receipt.implementationActor,
		reviewed_repository: receipt.subject.repositoryId,
		reviewed_head: receipt.subject.headSha,
		reviewed_tree: receipt.subject.treeSha,
		reviewer: receipt.reviewer,
		report: receipt.report,
		decided_at: receipt.decidedAt,
	})

const parseReceipt = (source: string, expectedWorkId: string): WorkResult<ReviewReceipt> => {
	let document: unknown
	try {
		document = parseYaml(source)
	} catch {
		return failure('review_receipt_invalid', `Review receipt ${expectedWorkId} is not valid YAML.`)
	}
	const parsed = safeParse(ReviewReceiptSchema, document)
	if (!parsed.success || parsed.output.work_id !== expectedWorkId) {
		return failure(
			'review_receipt_invalid',
			`Review receipt ${expectedWorkId} failed schema validation.`,
		)
	}
	return { ok: true, value: toReceipt(parsed.output) }
}

const gitOutput = async (root: string, args: readonly string[]): Promise<string> => {
	const result = await executeFile('git', args, {
		cwd: root,
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	})
	return result.stdout
}

const statusPaths = (source: string): readonly string[] =>
	source
		.split('\0')
		.filter(Boolean)
		.map((entry) => entry.slice(3).split(' -> ').at(-1) ?? '')
		.filter(Boolean)

const changedPaths = async (input: {
	readonly root: string
	readonly subjectHead: string
}): Promise<WorkResult<readonly string[]>> => {
	try {
		const observedHead = (await gitOutput(input.root, ['rev-parse', 'HEAD'])).trim()
		const committed = await gitOutput(input.root, [
			'diff',
			'--no-renames',
			'--name-only',
			'-z',
			input.subjectHead,
			observedHead,
			'--',
		])
		const dirty = await gitOutput(input.root, [
			'status',
			'--porcelain=v1',
			'-z',
			'--untracked-files=all',
			'--no-renames',
		])
		const confirmedHead = (await gitOutput(input.root, ['rev-parse', 'HEAD'])).trim()
		if (confirmedHead !== observedHead) {
			return failure('review_target_stale', 'The implementation changed while review was active.')
		}
		return {
			ok: true,
			value: [
				...new Set([...committed.split('\0').filter(Boolean), ...statusPaths(dirty)]),
			].toSorted(),
		}
	} catch {
		return failure('review_target_stale', 'The reviewed implementation revision is unavailable.')
	}
}

const validateReport = async (input: {
	readonly root: string
	readonly receipt: ReviewReceipt
}): Promise<WorkResult<{ readonly current: true }>> => {
	if (input.receipt.report.reference !== `${REVIEW_DIRECTORY}/${input.receipt.workId}.md`) {
		return failure('review_report_invalid', 'Review receipt references an unexpected report path.')
	}
	const report = await readBoundedContainedUtf8({
		root: input.root,
		reference: input.receipt.report.reference,
		maxBytes: MAX_REVIEW_REPORT_BYTES,
		unsafeCode: 'review_report_invalid',
		unavailableCode: 'review_report_invalid',
		tooLargeCode: 'review_report_invalid',
		invalidUtf8Code: 'review_report_invalid',
		label: 'Review report',
	})
	if (!report.ok) {
		return report
	}
	const digest = createHash('sha256').update(report.value).digest('hex')
	return digest === input.receipt.report.digest
		? { ok: true, value: { current: true } }
		: failure('review_target_stale', 'The independent review report changed after approval.')
}

/** @description Captures the exact clean Git revision that a reviewer must inspect. */
export const prepareReviewSubject = async (input: {
	readonly root: string
}): Promise<WorkResult<ReviewSubject>> => {
	const workspace = await observeGitWorkspace({ root: input.root })
	if (
		!workspace.ok ||
		!workspace.value.available ||
		workspace.value.repositoryId === undefined ||
		workspace.value.headSha === undefined ||
		workspace.value.treeSha === undefined ||
		workspace.value.dirty
	) {
		return failure(
			'review_target_stale',
			'Independent review requires a clean committed implementation revision.',
		)
	}
	return {
		ok: true,
		value: {
			repositoryId: workspace.value.repositoryId,
			headSha: workspace.value.headSha,
			treeSha: workspace.value.treeSha,
		},
	}
}

/** @description Reads one optional item-scoped review receipt from the repository. */
export const loadReviewReceipt = async (input: {
	readonly root: string
	readonly workId: string
}): Promise<WorkResult<ReviewReceipt | undefined>> => {
	const source = await readBoundedContainedUtf8({
		root: input.root,
		reference: receiptPathFor(input.workId),
		maxBytes: MAX_REVIEW_RECEIPT_BYTES,
		unsafeCode: 'review_receipt_invalid',
		unavailableCode: 'review_receipt_invalid',
		tooLargeCode: 'review_receipt_invalid',
		invalidUtf8Code: 'review_receipt_invalid',
		label: 'Review receipt',
	})
	if (!source.ok) {
		return source.error.details?.includes('System error code: ENOENT.') === true
			? { ok: true, value: undefined }
			: source
	}
	return parseReceipt(source.value, input.workId)
}

/** @description Verifies that only the review protocol files changed after the reviewed tree. */
export const validateReviewReceipt = async (input: {
	readonly root: string
	readonly receipt: ReviewReceipt
}): Promise<WorkResult<{ readonly current: true }>> => {
	const workspace = await observeGitWorkspace({ root: input.root })
	if (!workspace.ok || !workspace.value.available) {
		return failure('review_target_stale', 'The reviewed Git revision is unavailable.')
	}
	try {
		const reviewedTree = (
			await gitOutput(input.root, ['rev-parse', `${input.receipt.subject.headSha}^{tree}`])
		).trim()
		if (reviewedTree !== input.receipt.subject.treeSha) {
			return failure('review_target_stale', 'The reviewed implementation tree is inconsistent.')
		}
	} catch {
		return failure('review_target_stale', 'The reviewed implementation revision is unavailable.')
	}
	const paths = await changedPaths({ root: input.root, subjectHead: input.receipt.subject.headSha })
	if (!paths.ok) {
		return paths
	}
	const allowed = new Set([
		input.receipt.report.reference,
		receiptPathFor(input.receipt.workId),
		completionPathFor(input.receipt.workId),
	])
	if (paths.value.some((path) => !allowed.has(path))) {
		return failure(
			'review_target_stale',
			'The implementation changed after independent review; request a fresh review.',
		)
	}
	return validateReport(input)
}

/** @description Verifies durable historical review evidence without coupling it to current HEAD. */
export const validateHistoricalReviewReceipt = validateReport

/** @description Validates a report-only reviewer workspace and builds its durable decision receipt. */
export const prepareReviewReceipt = async (input: {
	readonly root: string
	readonly projectId: string
	readonly definitionHash: string
	readonly workId: string
	readonly implementationActor: string
	readonly reviewer: ReviewReceipt['reviewer']
	readonly disposition: ReviewReceipt['disposition']
	readonly reportReference: string
	readonly subject: ReviewSubject
	readonly decidedAt: string
}): Promise<WorkResult<{ readonly path: string; readonly receipt: ReviewReceipt }>> => {
	const report = await readBoundedContainedUtf8({
		root: input.root,
		reference: input.reportReference,
		maxBytes: MAX_REVIEW_REPORT_BYTES,
		unsafeCode: 'review_report_invalid',
		unavailableCode: 'review_report_invalid',
		tooLargeCode: 'review_report_invalid',
		invalidUtf8Code: 'review_report_invalid',
		label: 'Review report',
	})
	if (!report.ok) {
		return failure('review_report_invalid', 'Review report must be a bounded repository file.')
	}
	if (input.reportReference !== `${REVIEW_DIRECTORY}/${input.workId}.md`) {
		return failure(
			'review_report_invalid',
			`Review report must be ${REVIEW_DIRECTORY}/${input.workId}.md.`,
		)
	}
	const workspace = await observeGitWorkspace({ root: input.root })
	if (
		!workspace.ok ||
		!workspace.value.available ||
		workspace.value.repositoryId !== input.subject.repositoryId ||
		workspace.value.headSha !== input.subject.headSha ||
		workspace.value.treeSha !== input.subject.treeSha
	) {
		return failure('review_target_stale', 'The implementation changed while review was active.')
	}
	const paths = await changedPaths({ root: input.root, subjectHead: input.subject.headSha })
	if (!paths.ok) {
		return paths
	}
	const receiptPath = receiptPathFor(input.workId)
	if (paths.value.some((path) => path !== input.reportReference && path !== receiptPath)) {
		return failure('review_target_stale', 'A reviewer may change only its report and receipt.')
	}
	const confirmed = await observeGitWorkspace({ root: input.root })
	if (
		!confirmed.ok ||
		!confirmed.value.available ||
		confirmed.value.repositoryId !== input.subject.repositoryId ||
		confirmed.value.headSha !== input.subject.headSha ||
		confirmed.value.treeSha !== input.subject.treeSha
	) {
		return failure('review_target_stale', 'The implementation changed while review was active.')
	}
	const receipt: ReviewReceipt = {
		version: 1,
		projectId: input.projectId,
		workId: input.workId,
		definitionHash: input.definitionHash,
		disposition: input.disposition,
		implementationActor: input.implementationActor,
		subject: input.subject,
		reviewer: input.reviewer,
		report: {
			reference: input.reportReference,
			digest: createHash('sha256').update(report.value).digest('hex'),
		},
		decidedAt: input.decidedAt,
	}
	const serialized = serializeReceipt(receipt)
	const parsed = parseReceipt(serialized, input.workId)
	if (!parsed.ok || Buffer.byteLength(serialized, 'utf8') > MAX_REVIEW_RECEIPT_BYTES) {
		return parsed.ok
			? failure('review_receipt_invalid', 'Review receipt exceeds its size limit.')
			: parsed
	}
	return { ok: true, value: { path: receiptPath, receipt: parsed.value } }
}

/** @description Persists one already-validated review receipt without replacing another decision. */
export const persistReviewReceipt = async (input: {
	readonly root: string
	readonly receipt: ReviewReceipt
}): Promise<WorkResult<{ readonly path: string; readonly receipt: ReviewReceipt }>> => {
	const path = receiptPathFor(input.receipt.workId)
	const serialized = serializeReceipt(input.receipt)
	const parsed = parseReceipt(serialized, input.receipt.workId)
	if (!parsed.ok || Buffer.byteLength(serialized, 'utf8') > MAX_REVIEW_RECEIPT_BYTES) {
		return parsed.ok
			? failure('review_receipt_invalid', 'Review receipt exceeds its size limit.')
			: parsed
	}
	const existing = await loadReviewReceipt({ root: input.root, workId: input.receipt.workId })
	if (!existing.ok) {
		return existing
	}
	if (
		existing.value !== undefined &&
		existing.value.subject.headSha === input.receipt.subject.headSha &&
		serializeReceipt(existing.value) !== serialized
	) {
		return failure(
			'review_decision_conflict',
			'This implementation revision already has a different review receipt.',
		)
	}
	const target = await prepareSafeOutputPath({
		root: input.root,
		path,
		errorCode: 'review_receipt_invalid',
	})
	if (!target.ok) {
		return target
	}
	try {
		await writeUtf8NoFollow({
			path: target.value,
			content: serialized,
			mode: existing.value === undefined ? 'exclusive' : 'replace',
		})
		return { ok: true, value: { path, receipt: parsed.value } }
	} catch {
		return failure('review_receipt_invalid', 'Unable to write the independent review receipt.')
	}
}

/** @description Validates and writes a review receipt for repository-boundary callers. */
export const writeReviewReceipt = async (
	input: Parameters<typeof prepareReviewReceipt>[0],
): Promise<WorkResult<{ readonly path: string; readonly receipt: ReviewReceipt }>> => {
	const prepared = await prepareReviewReceipt(input)
	return prepared.ok
		? persistReviewReceipt({ root: input.root, receipt: prepared.value.receipt })
		: prepared
}
