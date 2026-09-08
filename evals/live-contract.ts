/**
 * @description Pure contracts for the non-shipped work-contract live evaluation driver.
 *
 * @module work/evals/live-contract
 * @file Live-contract.ts
 */

import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export type RuntimeName = 'claude' | 'codex'
export type EvaluationMode = 'native' | 'work'
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** @description Returns the bounded Claude tool policy for one isolated evaluation mode. */
export const claudeAllowedTools = (mode: EvaluationMode): string =>
	mode === 'work'
		? 'Bash(work *),Bash(bun run work *),Bash(bun test*),Bash(tee /workspace/evidence/*),Read,Write,Edit,Glob,Grep'
		: 'Bash(bun test*),Read,Write,Edit,Glob,Grep'

const boundedCredentialString = (value: unknown, maximumBytes: number): value is string =>
	typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximumBytes

/** @description Selects only the Claude account credential fields required by an isolated Linux runtime. */
export const isolatedClaudeCredentials = (
	value: unknown,
): Readonly<Record<string, unknown>> | undefined => {
	if (!isRecord(value) || !isRecord(value.claudeAiOauth)) {
		return undefined
	}
	const source = value.claudeAiOauth
	if (
		!boundedCredentialString(source.accessToken, 16_384) ||
		!boundedCredentialString(source.refreshToken, 16_384)
	) {
		return undefined
	}
	const oauth: Record<string, unknown> = {
		accessToken: source.accessToken,
		refreshToken: source.refreshToken,
	}
	for (const name of ['expiresAt', 'refreshTokenExpiresAt'] as const) {
		const field = source[name]
		if (field !== undefined) {
			if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) {
				return undefined
			}
			oauth[name] = field
		}
	}
	for (const name of ['rateLimitTier', 'subscriptionType'] as const) {
		const field = source[name]
		if (field !== undefined) {
			if (!boundedCredentialString(field, 128)) {
				return undefined
			}
			oauth[name] = field
		}
	}
	if (source.scopes !== undefined) {
		if (
			!Array.isArray(source.scopes) ||
			source.scopes.length > 32 ||
			!source.scopes.every((scope) => boundedCredentialString(scope, 256))
		) {
			return undefined
		}
		oauth.scopes = source.scopes
	}
	const selected: Record<string, unknown> = { claudeAiOauth: oauth }
	if (value.organizationUuid !== undefined) {
		if (!boundedCredentialString(value.organizationUuid, 256)) {
			return undefined
		}
		selected.organizationUuid = value.organizationUuid
	}
	return selected
}

/** @description Extracts verified assertion fields only from an active work claim. */
export const activeClaimAssertions = (
	value: unknown,
): Readonly<{ actor: string; role: string; session: string }> | undefined => {
	if (!isRecord(value) || !isRecord(value.operation) || value.operation.status !== 'in_progress') {
		return undefined
	}
	const activity = value.operation.activity
	if (
		!isRecord(activity) ||
		!boundedCredentialString(activity.actor, 512) ||
		!boundedCredentialString(activity.role, 512) ||
		!boundedCredentialString(activity.session, 512)
	) {
		return undefined
	}
	return { actor: activity.actor, role: activity.role, session: activity.session }
}

export interface LiveIsolationBackend {
	readonly kind: 'container' | 'unavailable'
	readonly verified: boolean
}

/** @description Reports the driver implementation's currently available OS isolation boundary. */
export const currentLiveIsolationBackend = (input: {
	readonly dockerExecutable?: string
	readonly dockerDaemonReady: boolean
}): LiveIsolationBackend =>
	input.dockerExecutable !== undefined && input.dockerDaemonReady
		? { kind: 'container', verified: false }
		: { kind: 'unavailable', verified: false }

/** @description Refuses paid agent execution unless an OS isolation backend was actively verified. */
export const assertVerifiedLiveIsolation = (backend: LiveIsolationBackend): void => {
	if (backend.kind === 'unavailable' || !backend.verified) {
		throw new Error('Paid evaluation requires a verified OS isolation backend.')
	}
}

/** @description Accepts live readiness only when runtime auth and enforced isolation both pass. */
export const livePreflightAccepted = (input: {
	readonly authentication: Readonly<Record<RuntimeName, boolean>>
	readonly isolation: LiveIsolationBackend
}): boolean =>
	isolatedAuthenticationAccepted(input.authentication) &&
	input.isolation.kind !== 'unavailable' &&
	input.isolation.verified

export interface BoundedReadableHandle {
	readonly read: (
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: null,
	) => Promise<{ readonly bytesRead: number }>
	readonly stat: () => Promise<{ readonly isFile: () => boolean; readonly size: number }>
}

/** @description Bounded incremental UTF-8 collector used for one agent runtime stream. */
export interface BoundedLineCollector {
	readonly append: (chunk: Uint8Array) => {
		readonly lines: readonly string[]
		readonly overflowed: boolean
	}
	readonly finish: () => { readonly content: string; readonly pendingLine: string }
}

/** @description Reads a regular UTF-8 file through an already-open handle with a growth sentinel. */
export const readBoundedUtf8Handle = async (
	handle: BoundedReadableHandle,
	maxBytes: number,
): Promise<string | undefined> => {
	try {
		const information = await handle.stat()
		if (!information.isFile() || information.size > maxBytes) {
			return undefined
		}
		const chunks: Uint8Array[] = []
		let total = 0
		let reachedEnd = false
		while (total <= maxBytes) {
			const buffer = new Uint8Array(Math.min(64 * 1024, maxBytes + 1 - total))
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
			if (bytesRead === 0) {
				reachedEnd = true
				break
			}
			chunks.push(buffer.subarray(0, bytesRead))
			total += bytesRead
		}
		return reachedEnd
			? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))
			: undefined
	} catch {
		return undefined
	}
}

/** @description Retains and line-decodes no more than one configured runtime stream budget. */
export const createBoundedLineCollector = (maxBytes: number): BoundedLineCollector => {
	const decoder = new StringDecoder('utf8')
	const chunks: Buffer[] = []
	let retainedBytes = 0
	let remainder = ''
	let overflowed = false
	let finished = false
	return {
		append: (
			chunk: Uint8Array,
		): { readonly lines: readonly string[]; readonly overflowed: boolean } => {
			if (finished || overflowed) {
				return { lines: [], overflowed }
			}
			const remaining = maxBytes - retainedBytes
			const retained = Buffer.from(chunk.subarray(0, Math.max(0, remaining)))
			if (retained.byteLength > 0) {
				chunks.push(retained)
				retainedBytes += retained.byteLength
				remainder += decoder.write(retained)
			}
			overflowed = chunk.byteLength > retained.byteLength
			const lines = remainder.split('\n')
			remainder = lines.pop() ?? ''
			return { lines, overflowed }
		},
		finish: (): { readonly content: string; readonly pendingLine: string } => {
			if (!finished) {
				remainder += decoder.end()
				finished = true
			}
			return {
				content: Buffer.concat(chunks, retainedBytes).toString('utf8'),
				pendingLine: remainder,
			}
		},
	}
}

/** @description Applies the process tool-call ceiling to the final unterminated event line. */
export const finalizeToolCount = (input: {
	readonly observed: number
	readonly pendingLine: string
	readonly maximum: number
	readonly countLine: (line: string) => number
}): { readonly toolCalls: number; readonly exceeded: boolean } => {
	const toolCalls =
		input.observed + (input.pendingLine.length === 0 ? 0 : input.countLine(input.pendingLine))
	return { toolCalls, exceeded: toolCalls > input.maximum }
}

/** @description Persistable runtime preflight fields that deliberately exclude executable paths. */
export interface SerializablePreflightSummary {
	readonly bun: string
	readonly git: string
	readonly codex: string
	readonly claude: string
	readonly authentication: Readonly<Record<RuntimeName, boolean>>
	readonly isolatedAuthentication?: Readonly<Record<RuntimeName, boolean>>
	readonly liveIsolation?: LiveIsolationBackend
}

/** @description Removes internal executable handles before preflight or report persistence. */
export const serializablePreflightSummary = (
	input: SerializablePreflightSummary & {
		readonly executables?: Readonly<Record<string, string>>
	},
): SerializablePreflightSummary => ({
	bun: input.bun,
	git: input.git,
	codex: input.codex,
	claude: input.claude,
	authentication: input.authentication,
	...(input.isolatedAuthentication === undefined
		? {}
		: { isolatedAuthentication: input.isolatedAuthentication }),
	...(input.liveIsolation === undefined ? {} : { liveIsolation: input.liveIsolation }),
})

const COMMON_RUNTIME_ENVIRONMENT = [
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'TMPDIR',
	'TMP',
	'TEMP',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'TERM',
	'COLORTERM',
	'NO_COLOR',
	'XDG_CONFIG_HOME',
	'XDG_CACHE_HOME',
	'XDG_DATA_HOME',
] as const

const CONTROLLER_LOCALE_ENVIRONMENT = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM'] as const

const RUNTIME_AUTH_ENVIRONMENT = {
	codex: ['CODEX_HOME'],
	claude: ['CLAUDE_CONFIG_DIR'],
} as const

/** @description Names every host variable eligible to cross into one live runtime. */
export const runtimeEnvironmentAllowlist = (runtime: RuntimeName): readonly string[] => [
	...COMMON_RUNTIME_ENVIRONMENT,
	...RUNTIME_AUTH_ENVIRONMENT[runtime],
	'PATH',
	'DO_NOT_TRACK',
	'WORK_CONTRACT_RUN_ID',
]

/** @description Selects only host fields required for one isolated live-runtime invocation. */
export const sanitizedRuntimeEnvironment = (input: {
	readonly runtime: RuntimeName
	readonly source: Readonly<Record<string, string | undefined>>
	readonly path: string
	readonly runId: string
}): Readonly<Record<string, string>> => {
	const selected: Record<string, string> = {}
	for (const name of [...COMMON_RUNTIME_ENVIRONMENT, ...RUNTIME_AUTH_ENVIRONMENT[input.runtime]]) {
		const value = input.source[name]
		if (value !== undefined) {
			selected[name] = value
		}
	}
	return {
		...selected,
		PATH: input.path,
		DO_NOT_TRACK: '1',
		WORK_CONTRACT_RUN_ID: input.runId,
	}
}

/** @description Builds a non-authenticated environment for trusted controller verification. */
export const sanitizedControllerEnvironment = (input: {
	readonly source: Readonly<Record<string, string | undefined>>
	readonly home: string
	readonly path: string
	readonly temporaryDirectory: string
}): Readonly<Record<string, string>> => {
	const locale: Record<string, string> = {}
	for (const name of CONTROLLER_LOCALE_ENVIRONMENT) {
		const value = input.source[name]
		if (value !== undefined) {
			locale[name] = value
		}
	}
	return {
		HOME: input.home,
		USER: 'work-contract-eval-controller',
		LOGNAME: 'work-contract-eval-controller',
		...locale,
		PATH: input.path,
		TMPDIR: input.temporaryDirectory,
		TMP: input.temporaryDirectory,
		TEMP: input.temporaryDirectory,
		NO_COLOR: '1',
	}
}

/** @description Requires both paid runtimes to authenticate from their isolated homes. */
export const isolatedAuthenticationAccepted = (
	authentication: Readonly<Record<RuntimeName, boolean>>,
): boolean => authentication.codex && authentication.claude

export interface LiveEvalOptions {
	readonly confirmLive: boolean
	readonly preflightOnly: boolean
	readonly repetitions: number
	readonly claudeBudgetUsd: number
	readonly codexModel: string
	readonly claudeModel: string
	readonly effort: ReasoningEffort
}

const DEFAULTS = {
	repetitions: 3,
	claudeBudgetUsd: 10,
	codexModel: 'gpt-5.6-sol',
	claudeModel: 'sonnet',
	effort: 'medium' as const,
}

const requireValue = (arguments_: readonly string[], index: number, option: string): string => {
	const value = arguments_[index + 1]
	if (value === undefined || value.startsWith('--')) {
		throw new TypeError(`${option} requires a value.`)
	}
	return value
}

const positiveNumber = (value: string, option: string, maximum: number): number => {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
		throw new TypeError(`${option} must be greater than zero and at most ${maximum}.`)
	}
	return parsed
}

const positiveInteger = (value: string, option: string, maximum: number): number => {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
		throw new TypeError(`${option} must be a positive integer at most ${maximum}.`)
	}
	return parsed
}

const boundedName = (value: string, option: string): string => {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
		throw new TypeError(`${option} must be a bounded model identifier.`)
	}
	return value
}

export const parseLiveEvalArguments = (arguments_: readonly string[]): LiveEvalOptions => {
	let confirmed = false
	let preflightOnly = false
	let repetitions = DEFAULTS.repetitions
	let claudeBudgetUsd = DEFAULTS.claudeBudgetUsd
	let codexModel = DEFAULTS.codexModel
	let claudeModel = DEFAULTS.claudeModel
	let effort: ReasoningEffort = DEFAULTS.effort

	for (let index = 0; index < arguments_.length; index += 1) {
		const option = arguments_[index]
		if (option === undefined) {
			throw new TypeError('Evaluation option is missing.')
		}
		switch (option) {
			case '--confirm-live': {
				confirmed = true
				break
			}
			case '--preflight-only': {
				preflightOnly = true
				break
			}
			case '--repetitions': {
				repetitions = positiveInteger(requireValue(arguments_, index, option), 'repetitions', 10)
				index += 1
				break
			}
			case '--claude-budget-usd': {
				claudeBudgetUsd = positiveNumber(
					requireValue(arguments_, index, option),
					'claude-budget-usd',
					100,
				)
				index += 1
				break
			}
			case '--codex-model': {
				codexModel = boundedName(requireValue(arguments_, index, option), 'codex-model')
				index += 1
				break
			}
			case '--claude-model': {
				claudeModel = boundedName(requireValue(arguments_, index, option), 'claude-model')
				index += 1
				break
			}
			case '--effort': {
				const value = requireValue(arguments_, index, option)
				switch (value) {
					case 'low':
					case 'medium':
					case 'high':
					case 'xhigh':
					case 'max': {
						effort = value
						break
					}
					default: {
						throw new TypeError('effort must be low, medium, high, xhigh, or max.')
					}
				}
				index += 1
				break
			}
			default: {
				throw new TypeError(`Unknown option: ${option}`)
			}
		}
	}

	if (confirmed && preflightOnly) {
		throw new TypeError('--confirm-live and --preflight-only are mutually exclusive.')
	}
	if (!confirmed && !preflightOnly) {
		throw new TypeError(
			'Use --preflight-only for a zero-cost check or --confirm-live to invoke paid runtimes.',
		)
	}

	return {
		confirmLive: confirmed,
		preflightOnly,
		repetitions,
		claudeBudgetUsd,
		codexModel,
		claudeModel,
		effort,
	}
}

export const runtimeOrder = (
	runtime: RuntimeName,
	repetitions: number,
): readonly (readonly [EvaluationMode, EvaluationMode])[] => {
	const startsWithWork = runtime === 'codex'
	return Array.from({ length: repetitions }, (_, index) => {
		const workFirst = index % 2 === 0 ? startsWithWork : !startsWithWork
		return workFirst ? (['work', 'native'] as const) : (['native', 'work'] as const)
	})
}

/** @description Accepts a complete campaign independently from the product outcomes it measures. */
export const campaignAccepted = (input: {
	readonly hierarchyAccepted: boolean
	readonly trials: readonly {
		readonly mode: EvaluationMode
		readonly accepted: boolean
		readonly classification: string
	}[]
}): boolean => {
	const workTrials = input.trials.filter((trial) => trial.mode === 'work')
	const nativeTrials = input.trials.filter((trial) => trial.mode === 'native')
	return (
		input.hierarchyAccepted &&
		workTrials.length > 0 &&
		nativeTrials.length > 0 &&
		input.trials.every((trial) => trial.classification !== 'infrastructure_failure')
	)
}

export interface RawRuntimeResult {
	readonly exitCode: number | null
	readonly timedOut: boolean
	readonly budgetExhausted: boolean
	readonly oracleAccepted: boolean
	readonly ledgerAccepted: boolean
	readonly durableEffects: boolean
}

export interface ClassifiedRuntimeResult {
	readonly accepted: boolean
	readonly classification:
		| 'accepted'
		| 'infrastructure_failure'
		| 'product_failure'
		| 'runtime_warning'
	readonly replacementAllowed: boolean
}

export const classifyRuntimeResult = (result: RawRuntimeResult): ClassifiedRuntimeResult => {
	const accepted = result.oracleAccepted && result.ledgerAccepted
	if (accepted && (result.exitCode !== 0 || result.timedOut || result.budgetExhausted)) {
		return { accepted, classification: 'runtime_warning', replacementAllowed: false }
	}
	if (accepted) {
		return { accepted, classification: 'accepted', replacementAllowed: false }
	}
	if ((result.exitCode === null || result.timedOut) && !result.durableEffects) {
		return { accepted, classification: 'infrastructure_failure', replacementAllowed: true }
	}
	return { accepted, classification: 'product_failure', replacementAllowed: false }
}

export const reserveClaudeBudget = (input: {
	readonly spentUsd: number
	readonly budgetUsd: number
	readonly invocationCapUsd: number
}): number => {
	if (!Number.isFinite(input.spentUsd) || input.spentUsd < 0) {
		throw new RangeError('Claude spent budget must be finite non-negative USD.')
	}
	if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) {
		throw new RangeError('Claude aggregate budget must be finite positive USD.')
	}
	if (!Number.isFinite(input.invocationCapUsd) || input.invocationCapUsd <= 0) {
		throw new RangeError('Claude invocation cap must be finite positive USD.')
	}
	const reserved = input.spentUsd + input.invocationCapUsd
	if (reserved > input.budgetUsd) {
		throw new RangeError('Claude aggregate budget cannot cover another reserved invocation.')
	}
	return reserved
}

/** @description Returns the maximum Claude exposure for hierarchy, paired trials, and one replacement. */
export const maximumClaudeReservedUsd = (repetitions: number, invocationCapUsd: number): number => {
	if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
		throw new RangeError('Claude campaign repetitions must be a positive integer.')
	}
	if (!Number.isFinite(invocationCapUsd) || invocationCapUsd <= 0) {
		throw new RangeError('Claude invocation cap must be finite positive USD.')
	}
	return (2 + repetitions * 2) * invocationCapUsd
}

/** @description Fails before live scheduling when the aggregate budget cannot cover the campaign. */
export const assertClaudeCampaignBudget = (input: {
	readonly repetitions: number
	readonly budgetUsd: number
	readonly invocationCapUsd: number
}): number => {
	const maximum = maximumClaudeReservedUsd(input.repetitions, input.invocationCapUsd)
	if (!Number.isFinite(input.budgetUsd) || input.budgetUsd < maximum) {
		throw new RangeError(
			`Claude aggregate budget cannot cover the maximum reserved exposure of USD ${maximum}.`,
		)
	}
	return maximum
}

/** @description Validates that disabled commands stay silent and re-enable records only itself. */
export const telemetryProbeAccepted = (input: {
	readonly afterDisable: number
	readonly afterDoctor: number
	readonly afterEnable: number
}): boolean =>
	input.afterDoctor === input.afterDisable && input.afterEnable === input.afterDisable + 1

/** @description Accepts only finite non-negative runtime metrics for accounting. */
export const nonNegativeMetric = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** @description Proves that a persisted evidence receipt names and hashes the actual file. */
export const evidenceReceiptAccepted = (input: {
	readonly receipt: unknown
	readonly expectedReference: string
	readonly actualSource: string
}): boolean => {
	if (!isRecord(input.receipt)) {
		return false
	}
	const expectedDigest = createHash('sha256').update(input.actualSource).digest('hex')
	return (
		input.receipt.kind === 'test' &&
		input.receipt.reference === input.expectedReference &&
		input.receipt.digest === expectedDigest
	)
}

/** @description Accepts only the controller CLI's typed ownership-conflict result. */
export const ownershipConflictResultAccepted = (input: {
	readonly status: number | null
	readonly stdout: string
	readonly stderr?: string
}): boolean => {
	if (input.status !== 1) {
		return false
	}
	let value: unknown
	try {
		const source = input.stdout.trim().length > 0 ? input.stdout : (input.stderr ?? '')
		value = JSON.parse(source)
	} catch {
		return false
	}
	if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) {
		return false
	}
	return value.error.type === 'work_contract_error' && value.error.code === 'ownership_conflict'
}

/** @description Normalizes runtimes that report total input versus uncached input directly. */
export const inputTokenMetrics = (input: {
	readonly runtime: RuntimeName
	readonly reportedInput: number | null
	readonly cachedInput: number | null
}): { readonly uncachedInput: number | null; readonly cachedInput: number | null } => ({
	uncachedInput:
		input.runtime === 'codex' && input.reportedInput !== null && input.cachedInput !== null
			? Math.max(0, input.reportedInput - input.cachedInput)
			: input.reportedInput,
	cachedInput: input.cachedInput,
})
