/**
 * @description Loads and compiles repository work definitions into a deterministic graph.
 *
 * @module work/compiler
 * @file Compiler.ts
 */

import { createHash } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { join as joinPosix } from 'node:path/posix'
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32'

import picomatch from 'picomatch'
import {
	array,
	literal,
	number,
	optional,
	picklist,
	safeParse,
	strictObject,
	string,
	union,
} from 'valibot'
import { parse as parseYaml } from 'yaml'

import type {
	CompiledWorkGraph,
	EvidenceKind,
	WorkDeliveryGate,
	WorkDeliveryPolicy,
	WorkArtifact,
	WorkArtifactKind,
	WorkExecution,
	WorkManifest,
	WorkResult,
	WorkSourceConfig,
} from './contracts'
import {
	WORK_DEFINITION_LIMITS,
	WORK_ID_PATTERN,
	EVIDENCE_ONLY_DELIVERY_POLICY,
	PROJECT_UID_PATTERN,
} from './contracts'
import { measureCommandPhase } from './command-profile'
import { INPUT_LIMITS, readBoundedContainedUtf8, safeSystemErrorDetails } from './files'

/* oxlint-disable unicorn/max-nested-calls -- Declarative validation schemas are clearer when structurally nested. */
/** @description Runtime schema for untrusted version-one work manifest documents. */
export const WorkManifestInputSchema = strictObject({
	version: literal(1),
	project: strictObject({ id: string(), uid: optional(string()) }),
	completionLedger: optional(literal(true)),
	sources: array(
		strictObject({
			kind: string(),
			include: union([string(), array(string())]),
			parentFields: optional(array(string())),
			dependencyFields: optional(array(string())),
		}),
	),
	policies: optional(
		strictObject({
			contextMaxBytes: optional(union([number(), string()])),
			staleClaimMinutes: optional(union([number(), string()])),
			terminalEvidence: optional(array(string())),
			delivery: optional(
				strictObject({
					profile: picklist(['evidence-only', 'local-direct', 'protected-pr']),
					isolation: optional(picklist(['none', 'worktree', 'container'])),
					integration: optional(picklist(['evidence', 'local', 'pull-request'])),
					terminal: optional(picklist(['evidence', 'candidate', 'landed', 'merged', 'deployed'])),
					targetRef: optional(string()),
					protectedRefs: optional(array(string())),
					requiredGates: optional(
						array(
							picklist([
								'validation',
								'pull-request',
								'review',
								'ci',
								'security',
								'landing',
								'merge',
								'deployment',
							]),
						),
					),
				}),
			),
		}),
	),
})
/* oxlint-enable unicorn/max-nested-calls */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const containsControlCharacter = (value: string): boolean => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
const GRAPH_VALIDATION_DETAIL_LIMIT = 100
const GRAPH_CYCLE_NODE_DETAIL_LIMIT = 20

const isWorkId = (value: string): boolean =>
	Buffer.byteLength(value, 'utf8') <= WORK_DEFINITION_LIMITS.identityBytes &&
	WORK_ID_PATTERN.test(value)

const stringListBytes = (values: readonly string[]): number =>
	values.reduce(
		(total, value, index) => total + Buffer.byteLength(value, 'utf8') + (index === 0 ? 0 : 1),
		0,
	)

const splitBounded = (value: string, maximumItems: number): readonly string[] | undefined => {
	const values: string[] = []
	let start = 0
	for (let index = 0; index <= value.length; index += 1) {
		if (index !== value.length && value[index] !== ',') {
			continue
		}
		values.push(value.slice(start, index))
		if (values.length > maximumItems) {
			return undefined
		}
		start = index + 1
	}
	return values
}

const strictStringList = (
	value: unknown,
	field: string,
	errorCode: 'invalid_work_artifact' | 'invalid_work_manifest',
	limits: { readonly maxBytes: number; readonly maxItems: number },
): WorkResult<readonly string[]> => {
	if (value === undefined || value === '') {
		return { ok: true, value: [] }
	}
	let values: readonly unknown[] | undefined
	if (Array.isArray(value)) {
		values = value
	} else if (typeof value === 'string') {
		values = splitBounded(value, limits.maxItems)
	}
	if (
		values === undefined ||
		values.length > limits.maxItems ||
		values.some(
			(entry) =>
				typeof entry !== 'string' ||
				entry.trim().length === 0 ||
				containsControlCharacter(entry) ||
				Buffer.byteLength(entry.trim(), 'utf8') > limits.maxBytes,
		)
	) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: errorCode,
				message: `${field} exceeds its string-list contract.`,
			},
		}
	}
	return { ok: true, value: values.map((entry) => String(entry).trim()) }
}

const strictOptionalString = (value: unknown, field: string): WorkResult<string | undefined> => {
	if (value === undefined || value === '') {
		return { ok: true, value: undefined }
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		return { ok: true, value: value.trim() }
	}
	return {
		ok: false,
		error: {
			type: 'work_contract_error',
			code: 'invalid_work_artifact',
			message: `${field} must be a non-empty string when provided.`,
		},
	}
}

const normalizeKey = (value: string): string =>
	value
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '_')
		.replaceAll(/^_|_$/g, '')

const parsePositivePolicy = (
	value: unknown,
	fallback: number,
	field: string,
	maximum: number,
): WorkResult<number> => {
	if (value === undefined) {
		return { ok: true, value: fallback }
	}
	let parsed = Number.NaN
	if (typeof value === 'number') {
		parsed = value
	} else if (typeof value === 'string' && /^\d+$/.test(value)) {
		parsed = Number(value)
	}
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
		? { ok: true, value: parsed }
		: manifestError(`${field} must be a positive integer no greater than ${maximum}.`)
}

const deliveryPresets: Readonly<Record<WorkDeliveryPolicy['profile'], WorkDeliveryPolicy>> = {
	'evidence-only': EVIDENCE_ONLY_DELIVERY_POLICY,
	'local-direct': {
		profile: 'local-direct',
		isolation: 'worktree',
		integration: 'local',
		terminal: 'landed',
		targetRef: 'refs/heads/main',
		requiredGates: ['validation', 'landing'],
	},
	'protected-pr': {
		profile: 'protected-pr',
		isolation: 'worktree',
		integration: 'pull-request',
		terminal: 'merged',
		targetRef: 'refs/heads/main',
		protectedRefs: ['refs/heads/main'],
		requiredGates: ['validation', 'pull-request', 'review', 'ci', 'merge'],
	},
}

const parseDeliveryPolicy = (
	value:
		| {
				readonly profile: WorkDeliveryPolicy['profile']
				readonly isolation?: WorkDeliveryPolicy['isolation'] | undefined
				readonly integration?: WorkDeliveryPolicy['integration'] | undefined
				readonly terminal?: WorkDeliveryPolicy['terminal'] | undefined
				readonly targetRef?: string | undefined
				readonly protectedRefs?: readonly string[] | undefined
				readonly requiredGates?: readonly WorkDeliveryGate[] | undefined
		  }
		| undefined,
): WorkResult<WorkDeliveryPolicy> => {
	if (value === undefined) {
		return { ok: true, value: EVIDENCE_ONLY_DELIVERY_POLICY }
	}
	const preset = deliveryPresets[value.profile]
	const policy: WorkDeliveryPolicy = {
		...preset,
		...(value.isolation === undefined ? {} : { isolation: value.isolation }),
		...(value.integration === undefined ? {} : { integration: value.integration }),
		...(value.terminal === undefined ? {} : { terminal: value.terminal }),
		...(value.targetRef === undefined ? {} : { targetRef: value.targetRef.trim() }),
		...(value.protectedRefs === undefined ? {} : { protectedRefs: value.protectedRefs }),
		...(value.requiredGates === undefined ? {} : { requiredGates: value.requiredGates }),
	}
	const refs = [policy.targetRef, ...(policy.protectedRefs ?? [])].filter(
		(candidate): candidate is string => candidate !== undefined,
	)
	if (
		refs.some(
			(ref) =>
				!/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(ref) ||
				ref.includes('..') ||
				ref.endsWith('/') ||
				Buffer.byteLength(ref, 'utf8') > 256,
		) ||
		new Set(policy.requiredGates).size !== policy.requiredGates.length ||
		(policy.integration === 'evidence' &&
			policy.terminal !== 'evidence' &&
			policy.terminal !== 'candidate') ||
		(policy.integration === 'local' &&
			policy.terminal !== 'candidate' &&
			policy.terminal !== 'landed') ||
		(policy.integration === 'pull-request' &&
			!['candidate', 'merged', 'deployed'].includes(policy.terminal)) ||
		(policy.terminal === 'landed' && !policy.requiredGates.includes('landing')) ||
		(policy.terminal === 'merged' && !policy.requiredGates.includes('merge')) ||
		(policy.terminal === 'deployed' && !policy.requiredGates.includes('deployment'))
	) {
		return manifestError('Delivery policy contains an incompatible or unsafe combination.')
	}
	return { ok: true, value: policy }
}

const isCustomArtifactKind = (value: string): value is `custom:${string}` =>
	/^custom:[a-z][a-z0-9-]*$/.test(value)

const parseArtifactKind = (value: string): WorkArtifactKind | undefined => {
	if (
		value === 'initiative' ||
		value === 'prd' ||
		value === 'issue' ||
		value === 'task' ||
		value === 'eval'
	) {
		return value
	}
	return isCustomArtifactKind(value) ? value : undefined
}

const parseEvidenceKinds = (values: readonly string[]): WorkResult<readonly EvidenceKind[]> => {
	const kinds: EvidenceKind[] = []
	for (const value of values) {
		if (
			value === 'test' ||
			value === 'review' ||
			value === 'build' ||
			value === 'ci' ||
			value === 'security' ||
			value === 'artifact'
		) {
			kinds.push(value)
			continue
		}
		if (isCustomArtifactKind(value)) {
			kinds.push(value)
			continue
		}
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_evidence_kind',
				message: 'Evidence kind is unsupported.',
			},
		}
	}
	return { ok: true, value: kinds }
}

const manifestError = (message: string, details?: readonly string[]): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code: 'invalid_work_manifest',
		message,
		...(details === undefined ? {} : { details }),
	},
})

/** @description Loads and validates one repository-contained version-one work manifest. */
export const loadWorkManifest = async (input: {
	readonly root: string
	readonly path?: string
}): Promise<WorkResult<WorkManifest>> => {
	const requestedPath = input.path ?? 'work.yaml'
	if (isAbsolute(requestedPath) || requestedPath.startsWith('..')) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'unsafe_work_manifest',
				message: 'Work manifest must be repository-relative.',
			},
		}
	}
	const boundedManifest = await readBoundedContainedUtf8({
		root: input.root,
		reference: requestedPath,
		maxBytes: INPUT_LIMITS.manifestBytes,
		unsafeCode: 'unsafe_work_manifest',
		unavailableCode: 'invalid_work_manifest',
		tooLargeCode: 'work_manifest_too_large',
		label: 'Work manifest',
		unsafeMessage: 'Work manifest resolves outside the repository.',
	})
	if (!boundedManifest.ok) {
		return boundedManifest
	}
	const source = boundedManifest.value

	let document: unknown
	try {
		document = parseYaml(source)
	} catch {
		return manifestError('Unable to parse the work manifest.')
	}

	const parsed = safeParse(WorkManifestInputSchema, document)
	if (!parsed.success) {
		return manifestError('Work manifest schema validation failed.')
	}

	const sourceConfigs: WorkSourceConfig[] = []
	const projectId = parsed.output.project.id.trim()
	if (
		projectId.length === 0 ||
		containsControlCharacter(projectId) ||
		Buffer.byteLength(projectId, 'utf8') > WORK_DEFINITION_LIMITS.projectIdBytes
	) {
		return manifestError('Project ID exceeds its scalar contract.')
	}
	const projectUid = parsed.output.project.uid?.trim()
	if (projectUid !== undefined && !PROJECT_UID_PATTERN.test(projectUid)) {
		return manifestError('Project UID must be a lowercase UUID version 4.')
	}
	if (parsed.output.sources.length > WORK_DEFINITION_LIMITS.manifestSources) {
		return manifestError('Work manifest contains too many source configurations.')
	}
	for (const sourceConfig of parsed.output.sources) {
		const kind = parseArtifactKind(sourceConfig.kind)
		if (kind === undefined) {
			return manifestError('Work manifest contains an unsupported artifact kind.')
		}
		const includes =
			typeof sourceConfig.include === 'string' ? [sourceConfig.include] : sourceConfig.include
		if (
			includes.length === 0 ||
			includes.length > WORK_DEFINITION_LIMITS.manifestPatterns ||
			includes.some(
				(pattern) =>
					pattern.trim().length === 0 ||
					containsControlCharacter(pattern) ||
					Buffer.byteLength(pattern, 'utf8') > WORK_DEFINITION_LIMITS.sourcePathBytes ||
					isAbsolute(pattern) ||
					isWindowsAbsolute(pattern) ||
					pattern.split(/[\\/]/u).includes('..'),
			)
		) {
			return manifestError(
				'Work source include patterns must be non-empty repository-relative globs.',
			)
		}
		const parentFields = strictStringList(
			sourceConfig.parentFields ?? ['parent'],
			'parentFields',
			'invalid_work_manifest',
			{
				maxBytes: WORK_DEFINITION_LIMITS.identityBytes,
				maxItems: WORK_DEFINITION_LIMITS.manifestFieldNames,
			},
		)
		if (!parentFields.ok) {
			return parentFields
		}
		const dependencyFields = strictStringList(
			sourceConfig.dependencyFields ?? ['depends_on', 'dependencies'],
			'dependencyFields',
			'invalid_work_manifest',
			{
				maxBytes: WORK_DEFINITION_LIMITS.identityBytes,
				maxItems: WORK_DEFINITION_LIMITS.manifestFieldNames,
			},
		)
		if (!dependencyFields.ok) {
			return dependencyFields
		}
		sourceConfigs.push({
			kind,
			include: [...includes],
			parentFields: parentFields.value,
			dependencyFields: dependencyFields.value,
		})
	}

	const policies = isRecord(document) && isRecord(document.policies) ? document.policies : {}
	const contextMaxBytes = parsePositivePolicy(
		policies.contextMaxBytes,
		12_000,
		'contextMaxBytes',
		1_000_000,
	)
	if (!contextMaxBytes.ok) {
		return contextMaxBytes
	}
	const staleClaimMinutes = parsePositivePolicy(
		policies.staleClaimMinutes,
		90,
		'staleClaimMinutes',
		525_600,
	)
	if (!staleClaimMinutes.ok) {
		return staleClaimMinutes
	}
	const terminalValues = strictStringList(
		policies.terminalEvidence,
		'terminalEvidence',
		'invalid_work_manifest',
		{
			maxBytes: WORK_DEFINITION_LIMITS.identityBytes,
			maxItems: WORK_DEFINITION_LIMITS.evidenceRequirements,
		},
	)
	if (!terminalValues.ok) {
		return terminalValues
	}
	const terminalEvidence = parseEvidenceKinds(terminalValues.value)
	if (!terminalEvidence.ok) {
		return manifestError(terminalEvidence.error.message)
	}
	const delivery = parseDeliveryPolicy(parsed.output.policies?.delivery)
	if (!delivery.ok) {
		return delivery
	}
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			projectId,
			...(projectUid === undefined ? {} : { projectUid }),
			...(parsed.output.completionLedger === true ? { completionLedger: true } : {}),
			sources: sourceConfigs,
			policies: {
				contextMaxBytes: contextMaxBytes.value,
				staleClaimMinutes: staleClaimMinutes.value,
				terminalEvidence: terminalEvidence.value,
				delivery: delivery.value,
			},
		},
	}
}

interface ParsedMarkdown {
	readonly body: string
	readonly fields: Readonly<Record<string, unknown>>
}

const parseMarkdown = (source: string): WorkResult<ParsedMarkdown> => {
	const fields: Record<string, unknown> = {}
	let body = source
	if (source.startsWith('---\n') || source.startsWith('---\r\n')) {
		const lineBreak = source.startsWith('---\r\n') ? '\r\n' : '\n'
		const delimiter = `${lineBreak}---${lineBreak}`
		const end = source.indexOf(delimiter, 4)
		if (end === -1) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_frontmatter',
					message: 'Markdown frontmatter is not closed.',
				},
			}
		}
		const frontmatterSource = source.slice(4, end)
		let parsed: unknown
		try {
			parsed = parseYaml(frontmatterSource)
		} catch {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_frontmatter',
					message: 'Markdown frontmatter cannot be parsed.',
				},
			}
		}
		if (!isRecord(parsed)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_frontmatter',
					message: 'Frontmatter must be a mapping.',
				},
			}
		}
		for (const [key, value] of Object.entries(parsed)) {
			fields[normalizeKey(key)] = value
		}
		body = source.slice(end + delimiter.length)
	}

	for (const match of body.matchAll(/^\*\*([^*]+):\*\*\s*(.+)$/gm)) {
		const key = match[1]
		const value = match[2]
		if (key !== undefined && value !== undefined && fields[normalizeKey(key)] === undefined) {
			fields[normalizeKey(key)] = value.trim()
		}
	}
	return { ok: true, value: { body, fields } }
}

const extractHeading = (body: string): { readonly id?: string; readonly title?: string } => {
	const match = /^#\s+([A-Z][A-Z0-9]*-[A-Z0-9][A-Z0-9-]{0,63})\s*:?[ \t]*(.*)$/im.exec(body)
	if (match === null) {
		return {}
	}
	const id = match[1]?.toUpperCase()
	const title = match[2]?.trim()
	return {
		...(id === undefined ? {} : { id }),
		...(title === undefined || title.length === 0 ? {} : { title }),
	}
}

const extractFilenameId = (path: string): string | undefined => {
	const numeric = /(?:^|\/)([A-Za-z][A-Za-z0-9]*-\d+)/.exec(path)?.[1]
	if (numeric !== undefined) {
		return numeric.toUpperCase()
	}
	const uppercase = /(?:^|\/)([A-Z][A-Z0-9]*-[A-Z0-9]+(?:-[A-Z0-9]+)*)/.exec(path)?.[1]
	if (uppercase !== undefined) {
		return uppercase
	}
	return /(?:^|\/)([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)\.md$/i.exec(path)?.[1]?.toUpperCase()
}

const extractAcceptance = (body: string): WorkResult<readonly string[]> => {
	const heading = /^##\s+Acceptance Criteria\s*$/im.exec(body)
	if (heading === null) {
		return { ok: true, value: [] }
	}
	const start = heading.index + heading[0].length
	const remaining = body.slice(start)
	const nextHeading = /^##\s/m.exec(remaining)
	const section = nextHeading === null ? remaining : remaining.slice(0, nextHeading.index)
	const acceptance: string[] = []
	let aggregateBytes = 0
	const matcher = /^\s*[-*]\s+(.+)$/gm
	for (let match = matcher.exec(section); match !== null; match = matcher.exec(section)) {
		const value = match[1]?.trim()
		if (value === undefined) {
			continue
		}
		aggregateBytes += Buffer.byteLength(value, 'utf8') + (acceptance.length === 0 ? 0 : 1)
		acceptance.push(value)
		if (
			acceptance.length > WORK_DEFINITION_LIMITS.acceptanceItems ||
			aggregateBytes > WORK_DEFINITION_LIMITS.acceptanceBytes
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_work_artifact',
					message: 'Acceptance exceeds its bounded collection contract.',
				},
			}
		}
	}
	return { ok: true, value: acceptance }
}

const findField = (
	fields: Readonly<Record<string, unknown>>,
	names: readonly string[],
): unknown => {
	for (const name of names) {
		const value = fields[normalizeKey(name)]
		if (value !== undefined) {
			return value
		}
	}
	return undefined
}

const resolveSafeSource = async (root: string, path: string): Promise<WorkResult<string>> => {
	try {
		const [rootPath, sourcePath] = await Promise.all([
			realpath(root),
			realpath(resolve(root, path)),
		])
		const relativePath = relative(rootPath, sourcePath)
		if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'unsafe_source_path',
					message: 'Work source path escapes the repository.',
				},
			}
		}
		return { ok: true, value: relativePath.replaceAll('\\', '/') }
	} catch (error: unknown) {
		const details = safeSystemErrorDetails(error)
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'source_read_failed',
				message: 'Unable to resolve the work source path.',
				...(details === undefined ? {} : { details }),
			},
		}
	}
}

interface CompiledArtifact {
	readonly artifact: WorkArtifact
	readonly sourceBytes: number
}

const parseWorkExecution = (value: unknown): WorkResult<WorkExecution> => {
	if (value === undefined) {
		return { ok: true, value: 'task' }
	}
	if (value === 'task' || value === 'aggregate') {
		return { ok: true, value }
	}
	return {
		ok: false,
		error: {
			type: 'work_contract_error',
			code: 'invalid_work_artifact',
			message: 'Execution must be task or aggregate.',
		},
	}
}

const parseArtifactIdentity = (input: {
	readonly fields: Readonly<Record<string, unknown>>
	readonly body: string
	readonly path: string
}): WorkResult<{ readonly id: string; readonly title: string }> => {
	const heading = extractHeading(input.body)
	const filenameId = extractFilenameId(input.path)
	const id = asString(findField(input.fields, ['id']))?.toUpperCase() ?? heading.id ?? filenameId
	const title = asString(findField(input.fields, ['title'])) ?? heading.title
	if (id === undefined || title === undefined) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_artifact',
				message: 'Work artifact requires an ID and title.',
			},
		}
	}
	if (!isWorkId(id)) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_artifact',
				message: 'Work artifact ID must use the uppercase PREFIX-SUFFIX form.',
			},
		}
	}
	if (
		containsControlCharacter(title) ||
		Buffer.byteLength(title, 'utf8') > WORK_DEFINITION_LIMITS.titleBytes
	) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_artifact',
				message: 'Work artifact title exceeds its scalar contract.',
			},
		}
	}
	return { ok: true, value: { id, title } }
}

const compileArtifact = async (input: {
	readonly root: string
	readonly path: string
	readonly sourceConfig: WorkSourceConfig
	readonly defaultEvidence: readonly EvidenceKind[]
}): Promise<WorkResult<CompiledArtifact>> => {
	const safePath = await resolveSafeSource(input.root, input.path)
	if (!safePath.ok) {
		return safePath
	}
	const boundedSource = await readBoundedContainedUtf8({
		root: input.root,
		reference: safePath.value,
		maxBytes: INPUT_LIMITS.sourceBytes,
		unsafeCode: 'unsafe_source_path',
		unavailableCode: 'source_read_failed',
		tooLargeCode: 'source_too_large',
		label: 'Work source file',
		unsafeMessage: 'Work source path escapes the repository.',
	})
	if (!boundedSource.ok) {
		return boundedSource
	}
	const markdown = boundedSource.value

	const parsed = parseMarkdown(markdown)
	if (!parsed.ok) {
		return parsed
	}
	const identity = parseArtifactIdentity({
		fields: parsed.value.fields,
		body: parsed.value.body,
		path: safePath.value,
	})
	if (!identity.ok) {
		return identity
	}
	const { id, title } = identity.value
	if (Buffer.byteLength(safePath.value, 'utf8') > WORK_DEFINITION_LIMITS.sourcePathBytes) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_artifact',
				message: 'Work artifact source path exceeds its scalar contract.',
			},
		}
	}

	const parent = strictOptionalString(
		findField(parsed.value.fields, input.sourceConfig.parentFields),
		'parent',
	)
	if (!parent.ok) {
		return parent
	}
	const parentId = parent.value?.toUpperCase()
	if (parentId !== undefined && !isWorkId(parentId)) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_artifact',
				message: 'Parent must use the uppercase PREFIX-SUFFIX form.',
			},
		}
	}
	const execution = parseWorkExecution(findField(parsed.value.fields, ['execution']))
	if (!execution.ok) {
		return execution
	}
	const dependencyValues = strictStringList(
		findField(parsed.value.fields, input.sourceConfig.dependencyFields),
		'dependencies',
		'invalid_work_artifact',
		{
			maxBytes: WORK_DEFINITION_LIMITS.identityBytes,
			maxItems: WORK_DEFINITION_LIMITS.dependencies,
		},
	)
	if (!dependencyValues.ok) {
		return dependencyValues
	}
	const dependencies = dependencyValues.value.map((dependency) => dependency.toUpperCase())
	const invalidDependency = dependencies.find((dependency) => !isWorkId(dependency))
	if (invalidDependency !== undefined) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_artifact',
				message: 'Dependency must use the uppercase PREFIX-SUFFIX form.',
			},
		}
	}
	const evidenceValues = strictStringList(
		findField(parsed.value.fields, ['evidence']),
		'evidence',
		'invalid_work_artifact',
		{
			maxBytes: WORK_DEFINITION_LIMITS.identityBytes,
			maxItems: WORK_DEFINITION_LIMITS.evidenceRequirements,
		},
	)
	if (!evidenceValues.ok) {
		return evidenceValues
	}
	const explicitEvidence = parseEvidenceKinds(evidenceValues.value)
	if (!explicitEvidence.ok) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_artifact',
				message: explicitEvidence.error.message,
			},
		}
	}
	const owners = strictStringList(
		findField(parsed.value.fields, ['owners', 'owner']),
		'owners',
		'invalid_work_artifact',
		{
			maxBytes: WORK_DEFINITION_LIMITS.identityBytes,
			maxItems: WORK_DEFINITION_LIMITS.workIdentities,
		},
	)
	if (!owners.ok) {
		return owners
	}
	const roles = strictStringList(
		findField(parsed.value.fields, ['roles', 'role']),
		'roles',
		'invalid_work_artifact',
		{
			maxBytes: WORK_DEFINITION_LIMITS.identityBytes,
			maxItems: WORK_DEFINITION_LIMITS.workIdentities,
		},
	)
	if (!roles.ok) {
		return roles
	}
	const hash = createHash('sha256').update(markdown).digest('hex')
	const extractedAcceptance = extractAcceptance(parsed.value.body)
	if (!extractedAcceptance.ok) {
		return extractedAcceptance
	}
	const acceptance = strictStringList(
		extractedAcceptance.value,
		'acceptance',
		'invalid_work_artifact',
		{
			maxBytes: WORK_DEFINITION_LIMITS.definitionListEntryBytes,
			maxItems: WORK_DEFINITION_LIMITS.acceptanceItems,
		},
	)
	if (!acceptance.ok) {
		return acceptance
	}
	if (stringListBytes(acceptance.value) > WORK_DEFINITION_LIMITS.acceptanceBytes) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_artifact',
				message: 'Acceptance exceeds its aggregate byte contract.',
			},
		}
	}
	let evidenceRequirements: readonly EvidenceKind[] = explicitEvidence.value
	if (evidenceRequirements.length === 0) {
		evidenceRequirements =
			input.sourceConfig.kind === 'issue' || input.sourceConfig.kind === 'task'
				? input.defaultEvidence
				: []
	}
	return {
		ok: true,
		value: {
			artifact: {
				id,
				kind: input.sourceConfig.kind,
				execution: execution.value,
				title,
				...(parentId === undefined ? {} : { parentId }),
				source: { path: safePath.value, hash },
				dependencies: [...new Set(dependencies)].toSorted(),
				acceptance: acceptance.value,
				owners: owners.value,
				roles: roles.value,
				evidenceRequirements,
				body: parsed.value.body.trim(),
			},
			sourceBytes: Buffer.byteLength(markdown, 'utf8'),
		},
	}
}

const findDependencyCycle = (items: readonly WorkArtifact[]): readonly string[] | undefined => {
	const dependencies = new Map(items.map((item) => [item.id, [...item.dependencies].toSorted()]))
	const visited = new Set<string>()
	for (const start of [...dependencies.keys()].toSorted()) {
		if (visited.has(start)) {
			continue
		}
		const path = [start]
		const positions = new Map([[start, 0]])
		const stack = [{ id: start, next: 0 }]
		while (stack.length > 0) {
			const frame = stack.at(-1)
			if (frame === undefined) {
				break
			}
			const outgoing = dependencies.get(frame.id) ?? []
			if (frame.next >= outgoing.length) {
				stack.pop()
				path.pop()
				positions.delete(frame.id)
				visited.add(frame.id)
				continue
			}
			const dependency = outgoing[frame.next]
			frame.next += 1
			if (dependency === undefined || !dependencies.has(dependency)) {
				continue
			}
			const cycleStart = positions.get(dependency)
			if (cycleStart !== undefined) {
				return [...path.slice(cycleStart), dependency]
			}
			if (!visited.has(dependency)) {
				positions.set(dependency, path.length)
				path.push(dependency)
				stack.push({ id: dependency, next: 0 })
			}
		}
	}
	return undefined
}

const findParentCycle = (items: readonly WorkArtifact[]): readonly string[] | undefined => {
	const parents = new Map(items.map((item) => [item.id, item.parentId]))
	const visited = new Set<string>()
	for (const start of [...parents.keys()].toSorted()) {
		if (visited.has(start)) {
			continue
		}
		const path: string[] = []
		const positions = new Map<string, number>()
		let current: string | undefined = start
		while (current !== undefined && parents.has(current)) {
			const cycleStart = positions.get(current)
			if (cycleStart !== undefined) {
				return [...path.slice(cycleStart), current]
			}
			if (visited.has(current)) {
				break
			}
			positions.set(current, path.length)
			path.push(current)
			current = parents.get(current)
		}
		for (const id of path) {
			visited.add(id)
		}
	}
	return undefined
}

const stableGraphValue = (projectId: string, items: readonly WorkArtifact[]): string =>
	JSON.stringify({ schemaVersion: 1, projectId, items })

const formatCycleDetail = (label: string, cycle: readonly string[]): string => {
	if (cycle.length <= GRAPH_CYCLE_NODE_DETAIL_LIMIT) {
		return `${label}: ${cycle.join(' -> ')}.`
	}
	const visible = cycle.slice(0, GRAPH_CYCLE_NODE_DETAIL_LIMIT)
	return `${label}: ${visible.join(' -> ')} -> … (${cycle.length - visible.length} nodes omitted).`
}

const isMissingPathError = (error: unknown): boolean =>
	typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const isExclusionPattern = (pattern: string): boolean =>
	pattern.startsWith('!') && !pattern.startsWith('!(')

const boundedSourceMatches = async (input: {
	readonly root: string
	readonly patterns: readonly string[]
	readonly maximumMatches: number
	readonly budget: { remainingEntries: number }
}): Promise<WorkResult<readonly string[]>> => {
	const positivePatterns = input.patterns.filter((pattern) => !isExclusionPattern(pattern))
	const negativePatterns = input.patterns
		.filter(isExclusionPattern)
		.map((pattern) => pattern.slice(1))
	const scans = positivePatterns.map((pattern) => ({ pattern, scan: picomatch.scan(pattern) }))
	const included = picomatch(
		scans.flatMap(({ pattern, scan }) =>
			scan.isGlob ? [pattern] : [pattern, `${pattern.replace(/\/$/, '')}/**`],
		),
		{ dot: false, posix: true },
	)
	const excluded = picomatch(
		negativePatterns.flatMap((pattern) => {
			const scan = picomatch.scan(pattern)
			return scan.isGlob ? [pattern] : [pattern, `${pattern.replace(/\/$/, '')}/**`]
		}),
		{ dot: false, posix: true },
	)
	const literalPaths = scans.filter(({ scan }) => !scan.isGlob).map(({ pattern }) => pattern)
	const bases = [
		...new Set(
			scans
				.filter(({ scan }) => scan.isGlob)
				.map(({ scan }) => scan.base.replace(/^\.\//, '') || '.'),
		),
	].filter(
		(base, _, candidates) =>
			!candidates.some(
				(candidate) => candidate !== base && base.startsWith(`${candidate.replace(/\/$/, '')}/`),
			),
	)
	const rootPath = await realpath(input.root)
	const matches = new Set<string>()
	const literalDirectories: string[] = []
	for (const literalPath of literalPaths) {
		try {
			const information = await lstat(resolve(rootPath, literalPath))
			input.budget.remainingEntries -= 1
			if (input.budget.remainingEntries < 0) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'source_item_limit_exceeded',
						message: `Work source discovery exceeds ${INPUT_LIMITS.sourceEntries} directory entries.`,
					},
				}
			}
			if (information.isDirectory()) {
				literalDirectories.push(literalPath)
			} else if (
				(information.isFile() || information.isSymbolicLink()) &&
				included(literalPath) &&
				!excluded(literalPath)
			) {
				matches.add(literalPath)
				if (matches.size > input.maximumMatches) {
					return {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'source_item_limit_exceeded',
							message: `Work source discovery exceeds ${INPUT_LIMITS.sourceItems} files.`,
						},
					}
				}
			}
		} catch (error: unknown) {
			if (!isMissingPathError(error)) {
				throw error
			}
		}
	}
	const crawlBases = [...new Set([...bases, ...literalDirectories])].filter(
		(base, _, candidates) =>
			!candidates.some(
				(candidate) => candidate !== base && base.startsWith(`${candidate.replace(/\/$/, '')}/`),
			),
	)
	for (const base of crawlBases) {
		const requestedBase = resolve(rootPath, base)
		let resolvedBase: string
		try {
			resolvedBase = await realpath(requestedBase)
		} catch (error: unknown) {
			if (isMissingPathError(error)) {
				continue
			}
			throw error
		}
		const localBase = relative(rootPath, resolvedBase)
		if (resolvedBase !== requestedBase || localBase.startsWith('..') || isAbsolute(localBase)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'unsafe_source_path',
					message: 'Work source discovery root must not traverse symbolic links.',
				},
			}
		}
		const directories = [{ absolute: resolvedBase, relative: base === '.' ? '' : base }]
		while (directories.length > 0) {
			const directory = directories.pop()
			if (directory === undefined) {
				break
			}
			const handle = await opendir(directory.absolute)
			for await (const entry of handle) {
				input.budget.remainingEntries -= 1
				if (input.budget.remainingEntries < 0) {
					return {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'source_item_limit_exceeded',
							message: `Work source discovery exceeds ${INPUT_LIMITS.sourceEntries} directory entries.`,
						},
					}
				}
				const relativePath = joinPosix(directory.relative, entry.name)
				if (entry.isDirectory()) {
					directories.push({
						absolute: resolve(directory.absolute, entry.name),
						relative: relativePath,
					})
					continue
				}
				if (
					(entry.isFile() || entry.isSymbolicLink()) &&
					included(relativePath) &&
					!excluded(relativePath)
				) {
					matches.add(relativePath)
					// oxlint-disable-next-line eslint/max-depth -- The sentinel belongs inside the bounded iterative directory scan.
					if (matches.size > input.maximumMatches) {
						return {
							ok: false,
							error: {
								type: 'work_contract_error',
								code: 'source_item_limit_exceeded',
								message: `Work source discovery exceeds ${INPUT_LIMITS.sourceItems} files.`,
							},
						}
					}
				}
			}
		}
	}
	return { ok: true, value: [...matches] }
}

/** @description Compiles all configured sources into a deterministic validated work graph. */
const compileWorkGraphInternal = async (input: {
	readonly root: string
	readonly manifest: WorkManifest
}): Promise<WorkResult<CompiledWorkGraph>> => {
	const discovered: { readonly path: string; readonly sourceConfig: WorkSourceConfig }[] = []
	const discoveryBudget = { remainingEntries: INPUT_LIMITS.sourceEntries }
	for (const sourceConfig of input.manifest.sources) {
		const matches = await boundedSourceMatches({
			root: input.root,
			patterns: sourceConfig.include,
			maximumMatches: INPUT_LIMITS.sourceItems - discovered.length,
			budget: discoveryBudget,
		})
		if (!matches.ok) {
			return matches
		}
		discovered.push(...matches.value.map((path) => ({ path, sourceConfig })))
	}
	discovered.sort((left, right) => left.path.localeCompare(right.path))

	const items: WorkArtifact[] = []
	let aggregateSourceBytes = 0
	for (const source of discovered) {
		const artifact = await compileArtifact({
			root: input.root,
			path: source.path,
			sourceConfig: source.sourceConfig,
			defaultEvidence: input.manifest.policies.terminalEvidence,
		})
		if (!artifact.ok) {
			return artifact
		}
		aggregateSourceBytes += artifact.value.sourceBytes
		if (aggregateSourceBytes > INPUT_LIMITS.sourceAggregateBytes) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'source_too_large',
					message: `Work source corpus exceeds ${INPUT_LIMITS.sourceAggregateBytes} bytes.`,
				},
			}
		}
		items.push(artifact.value.artifact)
	}
	items.sort((left, right) => left.id.localeCompare(right.id))

	const ids = new Set<string>()
	const details: string[] = []
	let detailsTruncated = false
	const addDetail = (detail: string): boolean => {
		if (details.length >= GRAPH_VALIDATION_DETAIL_LIMIT) {
			detailsTruncated = true
			return false
		}
		details.push(detail)
		return true
	}
	for (const item of items) {
		if (ids.has(item.id) && !addDetail(`Duplicate work ID ${item.id}.`)) {
			break
		}
		ids.add(item.id)
	}
	if (!detailsTruncated) {
		for (const item of items) {
			if (
				item.parentId !== undefined &&
				!ids.has(item.parentId) &&
				!addDetail(`${item.id} references missing parent ${item.parentId}.`)
			) {
				break
			}
			for (const dependency of item.dependencies) {
				if (
					!ids.has(dependency) &&
					!addDetail(`${item.id} references missing dependency ${dependency}.`)
				) {
					break
				}
			}
			if (detailsTruncated) {
				break
			}
		}
	}
	if (!detailsTruncated) {
		const aggregateChildCounts = new Map<string, number>()
		for (const item of items) {
			if (item.parentId !== undefined) {
				aggregateChildCounts.set(item.parentId, (aggregateChildCounts.get(item.parentId) ?? 0) + 1)
			}
		}
		for (const item of items) {
			if (
				item.execution === 'aggregate' &&
				(aggregateChildCounts.get(item.id) ?? 0) > WORK_DEFINITION_LIMITS.aggregateChildren &&
				!addDetail(
					`${item.id} exceeds the ${WORK_DEFINITION_LIMITS.aggregateChildren}-child aggregate limit.`,
				)
			) {
				break
			}
		}
	}
	if (!detailsTruncated) {
		const cycle = findDependencyCycle(items)
		if (cycle !== undefined) {
			addDetail(formatCycleDetail('Dependency cycle detected', cycle))
		}
		const parentCycle = findParentCycle(items)
		if (parentCycle !== undefined) {
			addDetail(formatCycleDetail('Parent cycle detected', parentCycle))
		}
	}
	if (detailsTruncated) {
		details.push('Additional graph validation failures omitted.')
	}
	if (details.length > 0) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_graph',
				message: 'Work graph validation failed.',
				details,
			},
		}
	}

	const stable = stableGraphValue(input.manifest.projectId, items)
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			projectId: input.manifest.projectId,
			fingerprint: createHash('sha256').update(stable).digest('hex'),
			items,
		},
	}
}

/** @description Compiles a work graph without rejecting its declared recoverable Result contract. */
export const compileWorkGraph = async (input: {
	readonly root: string
	readonly manifest: WorkManifest
}): Promise<WorkResult<CompiledWorkGraph>> => {
	try {
		return await measureCommandPhase('definition_compile', async () =>
			compileWorkGraphInternal(input),
		)
	} catch (error: unknown) {
		const details = safeSystemErrorDetails(error)
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_graph',
				message: 'Work graph compilation failed.',
				...(details === undefined ? {} : { details }),
			},
		}
	}
}
