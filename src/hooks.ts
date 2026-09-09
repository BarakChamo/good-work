/**
 * @description Owns trusted repository-root engineering hook configuration and bounded dispatch.
 *
 * @module work/hooks
 * @file Hooks.ts
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { env as processEnvironment } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import picomatch from 'picomatch'
import {
	array,
	boolean,
	literal,
	maxLength,
	maxValue,
	minLength,
	minValue,
	number,
	object,
	optional,
	picklist,
	pipe,
	safeInteger,
	safeParse,
	strictObject,
	string,
} from 'valibot'
import type { InferOutput } from 'valibot'

import { WORK_SCHEMA_URL } from './release-identity'

import type { WorkResult } from './contracts'
import { acquireConfigurationLock, finalizeConfigurationMutation } from './configuration-lock'
import { readBoundedUtf8, writeUtf8NoFollow } from './files'
import { prepareSafeOutputPath } from './paths'
import { executeFile } from './subprocess'

/* oxlint-disable unicorn/max-nested-calls -- Valibot schemas are clearest as declarative compositions. */

const WORK_HOOK_EVENTS = ['sessionStart', 'afterEdit', 'beforeStop', 'sessionEnd'] as const
const WORK_HOOK_RUNTIMES = ['codex', 'claude'] as const

const CONFIG_PATH = 'work.json'
const TRUST_PATH = 'hooks/trust.json'
const CONFIG_MAX_BYTES = 256 * 1024
const NATIVE_INPUT_MAX_BYTES = 256 * 1024
const OUTPUT_MAX_BYTES = 64 * 1024
const ENTRY_MAX = 32
const ARGUMENT_MAX = 64
const GLOB_MAX = 32
const TEXT_MAX = 4096
const TRUST_DIGEST_MAX = 8
const TRUST_LOCK_WAIT_MS = 1000
const TRUST_LOCK_RETRY_MS = 10
const DISPATCH_MAX_MS = 300_000
const SESSION_END_BUDGET_MS = { claude: 1000, codex: 2500 } as const

const BoundedTextSchema = pipe(string(), minLength(1), maxLength(TEXT_MAX))
const GlobListSchema = pipe(
	array(pipe(string(), minLength(1), maxLength(512))),
	maxLength(GLOB_MAX),
)
const OutputSchema = strictObject({
	mode: picklist(['silent', 'passthrough', 'summarize']),
	when: picklist(['always', 'failure']),
	instruction: optional(pipe(string(), minLength(1), maxLength(2000))),
})
const ChangedFilesSchema = strictObject({
	source: picklist(['event', 'workingTree', 'staged']),
	include: optional(GlobListSchema),
	exclude: optional(GlobListSchema),
})
const WhenSchema = strictObject({
	runtime: optional(pipe(array(picklist(WORK_HOOK_RUNTIMES)), minLength(1), maxLength(2))),
	sessionSource: optional(
		pipe(array(picklist(['startup', 'resume', 'clear', 'compact'])), minLength(1), maxLength(4)),
	),
	changedFiles: optional(ChangedFilesSchema),
})
const EntrySchema = strictObject({
	id: pipe(string(), minLength(1), maxLength(128)),
	command: BoundedTextSchema,
	args: optional(pipe(array(pipe(string(), maxLength(TEXT_MAX))), maxLength(ARGUMENT_MAX))),
	timeoutMs: optional(pipe(number(), safeInteger(), minValue(1), maxValue(300_000))),
	when: optional(WhenSchema),
	output: OutputSchema,
	blockOnFailure: optional(boolean()),
})
const HooksSchema = strictObject({
	sessionStart: optional(pipe(array(EntrySchema), maxLength(ENTRY_MAX))),
	afterEdit: optional(pipe(array(EntrySchema), maxLength(ENTRY_MAX))),
	beforeStop: optional(pipe(array(EntrySchema), maxLength(ENTRY_MAX))),
	sessionEnd: optional(pipe(array(EntrySchema), maxLength(ENTRY_MAX))),
})
const ConfigSchema = strictObject({
	$schema: optional(string()),
	version: literal(1),
	hooks: HooksSchema,
})
const TrustSchema = strictObject({
	schemaVersion: literal(1),
	digests: pipe(array(pipe(string(), maxLength(64))), maxLength(TRUST_DIGEST_MAX)),
})
const NativeInputSchema = object({
	hook_event_name: string(),
	cwd: optional(pipe(string(), minLength(1), maxLength(TEXT_MAX))),
	source: optional(string()),
	tool_name: optional(string()),
	tool_input: optional(
		object({
			file_path: optional(string()),
			path: optional(string()),
			notebook_path: optional(string()),
			command: optional(string()),
		}),
	),
	stop_hook_active: optional(boolean()),
})

type HookConfig = InferOutput<typeof ConfigSchema>
type HookEntry = InferOutput<typeof EntrySchema>
type HookEvent = (typeof WORK_HOOK_EVENTS)[number]
type HookRuntime = (typeof WORK_HOOK_RUNTIMES)[number]
type NativeHookInput = InferOutput<typeof NativeInputSchema>

export interface HookExecution {
	readonly id: string
	readonly outcome: 'success' | 'failure' | 'timeout' | 'skipped'
	readonly durationMs: number
	readonly outputMode: 'silent' | 'passthrough' | 'summarize'
	readonly skipReason?: 'runtime' | 'session_source' | 'changed_files' | 'unrecognized_edit'
	readonly exitCode?: number
}

interface HookInspection {
	readonly path: 'work.json'
	readonly digest: string
	readonly committed: boolean
	readonly entries: ReturnType<typeof inspectEntries>
}

interface HookTrustResult {
	readonly trusted: boolean
	readonly digest?: string
}

interface HookStatus {
	readonly present: boolean
	readonly valid: boolean
	readonly committed: boolean
	readonly trusted: boolean
	readonly digest?: string
	readonly entries?: number
}

interface HookTelemetryInput extends HookExecution {
	readonly event: HookEvent
	readonly maxWaitMs?: number
}

type HookTelemetryRecorder = (input: HookTelemetryInput) => Promise<void>

interface CommandResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	readonly timedOut: boolean
}

type RunCommand = (input: {
	readonly command: string
	readonly args: readonly string[]
	readonly cwd: string
	readonly stdin: string
	readonly timeoutMs: number
	readonly environment: Readonly<Record<string, string | undefined>>
}) => Promise<CommandResult>

type ExecuteGit = (root: string, args: readonly string[]) => Promise<string>

const failure = <T>(
	code:
		| 'hooks_config_exists'
		| 'hooks_config_unavailable'
		| 'hooks_config_too_large'
		| 'invalid_hooks_config'
		| 'hooks_config_uncommitted'
		| 'hooks_trust_failed'
		| 'invalid_hook_input'
		| 'unsafe_hooks_path',
	message: string,
): WorkResult<T> => ({
	ok: false,
	error: { type: 'work_contract_error', code, message },
})

const isMissing = (error: unknown): boolean =>
	error instanceof Error && 'code' in error && error.code === 'ENOENT'

const remainingTimeout = (deadline: number | undefined): number => {
	if (deadline === undefined) {
		return 10_000
	}
	const remaining = Math.floor(deadline - performance.now())
	if (remaining <= 0) {
		throw new Error('Hook dispatch deadline expired.')
	}
	return Math.min(10_000, remaining)
}

const git = async (root: string, args: readonly string[], deadline?: number): Promise<string> => {
	const result = await executeFile('git', args, {
		cwd: root,
		timeout: remainingTimeout(deadline),
		maxBuffer: 1024 * 1024,
	})
	return result.stdout
}

/** @description Resolves the exact Git worktree root for a native hook working directory. */
const resolveHookRepositoryRoot = async (input: {
	readonly cwd: string
	readonly deadline?: number
	/** @internal */
	readonly executeGit?: ExecuteGit
}): Promise<WorkResult<string>> => {
	try {
		const cwd = await realpath(resolve(input.cwd))
		const output =
			input.executeGit === undefined
				? await git(cwd, ['rev-parse', '--show-toplevel'], input.deadline)
				: await input.executeGit(cwd, ['rev-parse', '--show-toplevel'])
		const root = await realpath(output.trim())
		const local = relative(root, cwd)
		return local.startsWith('..') || isAbsolute(local)
			? failure('unsafe_hooks_path', 'Hook working directory is outside its Git worktree.')
			: { ok: true, value: root }
	} catch {
		return failure('hooks_config_unavailable', 'A Git worktree root could not be resolved.')
	}
}

const validatePathLike = (value: string): boolean => {
	if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
		return false
	}
	if (!value.includes('/') && !value.includes('\\')) {
		return true
	}
	const normalized = value.replaceAll('\\', '/')
	return !isAbsolute(value) && !normalized.startsWith('..') && !normalized.includes('/../')
}

const validateGlob = (value: string): boolean => {
	if (!validatePathLike(value)) {
		return false
	}
	try {
		picomatch(value)
		return true
	} catch {
		return false
	}
}

const validateEntry = (event: HookEvent, entry: HookEntry): string | undefined => {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.id)) {
		return 'Hook entry ID is invalid.'
	}
	if (!validatePathLike(entry.command)) {
		return 'Hook command escapes the repository.'
	}
	if (entry.output.mode === 'summarize' && entry.output.instruction === undefined) {
		return 'Summarize output requires an instruction.'
	}
	if (entry.output.mode !== 'summarize' && entry.output.instruction !== undefined) {
		return 'Only summarize output accepts an instruction.'
	}
	if (event === 'sessionEnd' && entry.output.mode !== 'silent') {
		return 'sessionEnd supports only silent output.'
	}
	if (entry.blockOnFailure !== undefined && event !== 'beforeStop') {
		return 'blockOnFailure is valid only for beforeStop.'
	}
	if (entry.when?.sessionSource !== undefined && event !== 'sessionStart') {
		return 'sessionSource is valid only for sessionStart.'
	}
	if (entry.when?.changedFiles !== undefined && event !== 'afterEdit') {
		return 'changedFiles is valid only for afterEdit.'
	}
	const globs = [
		...(entry.when?.changedFiles?.include ?? []),
		...(entry.when?.changedFiles?.exclude ?? []),
	]
	return globs.every((glob) => validateGlob(glob))
		? undefined
		: 'Changed-file glob is invalid or escapes the repository.'
}

const parseConfig = (source: string): WorkResult<HookConfig> => {
	let document: unknown
	try {
		document = JSON.parse(source)
	} catch {
		return failure('invalid_hooks_config', 'work.json is not valid JSON.')
	}
	const parsed = safeParse(ConfigSchema, document)
	if (!parsed.success) {
		return failure('invalid_hooks_config', 'work.json failed schema validation.')
	}
	const seen = new Set<string>()
	for (const event of WORK_HOOK_EVENTS) {
		for (const entry of parsed.output.hooks[event] ?? []) {
			const invalid = validateEntry(event, entry)
			if (invalid !== undefined) {
				return failure('invalid_hooks_config', invalid)
			}
			if (seen.has(entry.id)) {
				return failure('invalid_hooks_config', 'Hook entry IDs must be unique.')
			}
			seen.add(entry.id)
		}
	}
	return { ok: true, value: parsed.output }
}

const loadConfig = async (
	cwd: string,
	deadline?: number,
): Promise<
	WorkResult<{
		readonly root: string
		readonly source: string
		readonly config: HookConfig
		readonly digest: string
		readonly committed: boolean
	}>
> => {
	const resolved = await resolveHookRepositoryRoot({
		cwd,
		...(deadline === undefined ? {} : { deadline }),
	})
	if (!resolved.ok) {
		return resolved
	}
	const path = join(resolved.value, CONFIG_PATH)
	const source = await readBoundedUtf8({
		path,
		maxBytes: CONFIG_MAX_BYTES,
		unavailableCode: 'hooks_config_unavailable',
		tooLargeCode: 'hooks_config_too_large',
		label: 'work.json',
	})
	if (!source.ok) {
		return failure(
			source.error.code === 'hooks_config_too_large'
				? 'hooks_config_too_large'
				: 'hooks_config_unavailable',
			source.error.message,
		)
	}
	const parsed = parseConfig(source.value)
	if (!parsed.ok) {
		return parsed
	}
	let committed = false
	try {
		await git(resolved.value, ['ls-files', '--error-unmatch', '--', CONFIG_PATH], deadline)
		const status = await git(
			resolved.value,
			['status', '--porcelain=v1', '--', CONFIG_PATH],
			deadline,
		)
		committed = status.trim() === ''
	} catch {
		committed = false
	}
	return {
		ok: true,
		value: {
			root: resolved.value,
			source: source.value,
			config: parsed.value,
			digest: createHash('sha256').update(source.value).digest('hex'),
			committed,
		},
	}
}

const inspectEntries = (config: HookConfig) =>
	WORK_HOOK_EVENTS.flatMap((event) =>
		(config.hooks[event] ?? []).map((entry) => ({
			event,
			id: entry.id,
			command: entry.command,
			args: entry.args ?? [],
			timeoutMs: entry.timeoutMs ?? 30_000,
			when: entry.when ?? {},
			output: entry.output,
			blockOnFailure: entry.blockOnFailure ?? false,
		})),
	)

/** @description Creates the minimal root work.json and never replaces an existing path. */
export const initializeWorkHooks = async (input: {
	readonly cwd: string
}): Promise<WorkResult<{ readonly path: 'work.json'; readonly created: true }>> => {
	const root = await resolveHookRepositoryRoot({ cwd: input.cwd })
	if (!root.ok) {
		return root
	}
	const target = await prepareSafeOutputPath({
		root: root.value,
		path: CONFIG_PATH,
		errorCode: 'unsafe_hooks_path',
	})
	if (!target.ok) {
		return target
	}
	try {
		await writeUtf8NoFollow({
			path: target.value,
			content: `${JSON.stringify({ $schema: WORK_SCHEMA_URL, version: 1, hooks: {} }, null, 2)}\n`,
			mode: 'exclusive',
		})
		return { ok: true, value: { path: CONFIG_PATH, created: true } }
	} catch (error: unknown) {
		return isMissing(error)
			? failure('hooks_config_unavailable', 'work.json could not be created.')
			: failure('hooks_config_exists', 'work.json already exists and was not changed.')
	}
}

/** @description Validates root work.json and returns its exact digest without executing commands. */
export const inspectWorkHooks = async (input: {
	readonly cwd: string
}): Promise<WorkResult<HookInspection>> => {
	const loaded = await loadConfig(input.cwd)
	return loaded.ok
		? {
				ok: true as const,
				value: {
					path: CONFIG_PATH,
					digest: loaded.value.digest,
					committed: loaded.value.committed,
					entries: inspectEntries(loaded.value.config),
				},
			}
		: loaded
}

const trustPath = async (coordinationRoot: string): Promise<WorkResult<string>> => {
	const target = await prepareSafeOutputPath({
		root: coordinationRoot,
		path: TRUST_PATH,
		errorCode: 'unsafe_hooks_path',
	})
	return target.ok ? target : failure('unsafe_hooks_path', target.error.message)
}

const readTrust = async (coordinationRoot: string): Promise<WorkResult<readonly string[]>> => {
	const target = await trustPath(coordinationRoot)
	if (!target.ok) {
		return target
	}
	const source = await readBoundedUtf8({
		path: target.value,
		maxBytes: 4096,
		unavailableCode: 'hooks_trust_failed',
		tooLargeCode: 'hooks_trust_failed',
		label: 'Hook trust record',
	})
	if (!source.ok) {
		return source.error.details?.some((detail) => detail.includes('ENOENT'))
			? { ok: true, value: [] }
			: failure('hooks_trust_failed', source.error.message)
	}
	try {
		const parsed = safeParse(TrustSchema, JSON.parse(source.value))
		return parsed.success
			? { ok: true, value: parsed.output.digests }
			: failure('hooks_trust_failed', 'Hook trust record failed schema validation.')
	} catch {
		return failure('hooks_trust_failed', 'Hook trust record is not valid JSON.')
	}
}

const writeTrust = async (coordinationRoot: string, digests: readonly string[]) => {
	const target = await prepareSafeOutputPath({
		root: coordinationRoot,
		path: TRUST_PATH,
		errorCode: 'unsafe_hooks_path',
		createParents: true,
	})
	if (!target.ok) {
		return target
	}
	try {
		await writeUtf8NoFollow({
			path: target.value,
			content: `${JSON.stringify({ schemaVersion: 1, digests }, null, 2)}\n`,
			mode: 'replace',
		})
		return { ok: true as const, value: undefined }
	} catch {
		return failure('hooks_trust_failed', 'Hook trust record could not be written.')
	}
}

const withTrustLock = async <T>(
	coordinationRoot: string,
	operation: () => Promise<WorkResult<T>>,
): Promise<WorkResult<T>> => {
	const deadline = Date.now() + TRUST_LOCK_WAIT_MS
	let lock: Awaited<ReturnType<typeof acquireConfigurationLock>>
	while (true) {
		lock = await acquireConfigurationLock({
			root: coordinationRoot,
			intent: { schemaVersion: 1, kind: 'work_hooks_trust', pid: process.pid },
		})
		if (lock.ok || lock.error.code !== 'configuration_locked' || Date.now() >= deadline) {
			break
		}
		await delay(TRUST_LOCK_RETRY_MS)
	}
	if (!lock.ok) {
		return failure('hooks_trust_failed', 'Another hook trust update requires inspection.')
	}
	const result = await operation()
	const finalized = await finalizeConfigurationMutation({ result, lock: lock.value })
	if (!result.ok) {
		return result
	}
	return finalized.ok
		? finalized
		: failure('hooks_trust_failed', 'Hook trust changed but its mutation lock could not release.')
}

/** @description Trusts the reviewed exact digest of a clean committed work.json. */
export const trustWorkHooks = async (input: {
	readonly cwd: string
	readonly coordinationRoot: string
}): Promise<WorkResult<HookTrustResult>> => {
	const loaded = await loadConfig(input.cwd)
	if (!loaded.ok) {
		return loaded
	}
	if (!loaded.value.committed) {
		return failure('hooks_config_uncommitted', 'Commit work.json unchanged before trusting it.')
	}
	return withTrustLock(input.coordinationRoot, async () => {
		const trust = await readTrust(input.coordinationRoot)
		if (!trust.ok) {
			return trust
		}
		const digests = [
			loaded.value.digest,
			...trust.value.filter((value) => value !== loaded.value.digest),
		].slice(0, TRUST_DIGEST_MAX)
		const written = await writeTrust(input.coordinationRoot, digests)
		return written.ok
			? { ok: true as const, value: { trusted: true, digest: loaded.value.digest } }
			: written
	})
}

/** @description Removes all locally trusted work.json digests for the project. */
export const untrustWorkHooks = async (input: {
	readonly cwd: string
	readonly coordinationRoot: string
}): Promise<WorkResult<HookTrustResult>> => {
	const root = await resolveHookRepositoryRoot({ cwd: input.cwd })
	if (!root.ok) {
		return root
	}
	return withTrustLock(input.coordinationRoot, async () => {
		const written = await writeTrust(input.coordinationRoot, [])
		return written.ok ? { ok: true as const, value: { trusted: false } } : written
	})
}

/** @description Reports root work.json validity and local digest trust without executing commands. */
export const statusWorkHooks = async (input: {
	readonly cwd: string
	readonly coordinationRoot: string
}): Promise<WorkResult<HookStatus>> => {
	const loaded = await loadConfig(input.cwd)
	if (!loaded.ok) {
		return loaded.error.code === 'hooks_config_unavailable'
			? {
					ok: true as const,
					value: { present: false, valid: false, committed: false, trusted: false },
				}
			: loaded
	}
	const trust = await readTrust(input.coordinationRoot)
	if (!trust.ok) {
		return trust
	}
	return {
		ok: true as const,
		value: {
			present: true,
			valid: true,
			committed: loaded.value.committed,
			trusted: loaded.value.committed && trust.value.includes(loaded.value.digest),
			digest: loaded.value.digest,
			entries: inspectEntries(loaded.value.config).length,
		},
	}
}

const defaultRunCommand: RunCommand = async (input) =>
	new Promise((resolveCommand) => {
		const child = spawn(input.command, [...input.args], {
			cwd: input.cwd,
			env: { ...processEnvironment, ...input.environment },
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		let stdout: Buffer = Buffer.alloc(0)
		let stderr: Buffer = Buffer.alloc(0)
		let timedOut = false
		let forceTimer: ReturnType<typeof setTimeout> | undefined
		const append = (current: Buffer, chunk: Buffer): Buffer =>
			current.byteLength >= OUTPUT_MAX_BYTES
				? current
				: Buffer.concat([current, chunk]).subarray(0, OUTPUT_MAX_BYTES)
		child.stdout.on('data', (chunk: Buffer) => {
			stdout = append(stdout, chunk)
		})
		child.stderr.on('data', (chunk: Buffer) => {
			stderr = append(stderr, chunk)
		})
		// Short-lived hooks may close stdin before end(); their process exit remains authoritative.
		child.stdin.on('error', () => {
			// The close listener below reports the process outcome.
		})
		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGTERM')
			forceTimer = setTimeout(() => {
				child.kill('SIGKILL')
			}, 250)
		}, input.timeoutMs)
		child.on('error', () => {
			clearTimeout(timer)
			if (forceTimer !== undefined) {
				clearTimeout(forceTimer)
			}
			resolveCommand({
				exitCode: 127,
				stdout: '',
				stderr: 'Executable unavailable.',
				timedOut: false,
			})
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			if (forceTimer !== undefined) {
				clearTimeout(forceTimer)
			}
			resolveCommand({
				exitCode: timedOut ? 124 : (code ?? 1),
				stdout: stdout.toString('utf8'),
				stderr: stderr.toString('utf8'),
				timedOut,
			})
		})
		child.stdin.end(input.stdin)
	})

const nativeEvent = (value: string): HookEvent | undefined => {
	switch (value) {
		case 'SessionStart': {
			return 'sessionStart'
		}
		case 'PostToolUse': {
			return 'afterEdit'
		}
		case 'Stop': {
			return 'beforeStop'
		}
		case 'SessionEnd': {
			return 'sessionEnd'
		}
		default: {
			return undefined
		}
	}
}

const isRecognizedEdit = (runtime: HookRuntime, tool: string | undefined): boolean =>
	runtime === 'claude'
		? ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool ?? '')
		: ['apply_patch', 'write_file', 'edit_file'].includes(tool ?? '')

const containedEventPaths = async (
	root: string,
	base: string,
	values: readonly (string | undefined)[],
): Promise<readonly string[]> => {
	const paths: string[] = []
	for (const value of values) {
		if (value === undefined) {
			continue
		}
		const candidate = resolve(base, value)
		const absolute = await realpath(candidate).catch(() => candidate)
		const local = relative(root, absolute).split('\\').join('/')
		if (!local.startsWith('..') && !isAbsolute(local) && local.length > 0) {
			paths.push(local)
		}
	}
	return paths
}

const containedNativeCwd = async (
	root: string,
	nativeCwd: string | undefined,
	fallbackCwd: string,
): Promise<WorkResult<string>> => {
	try {
		const base = await realpath(resolve(nativeCwd ?? fallbackCwd))
		const local = relative(root, base)
		return local.startsWith('..') || isAbsolute(local)
			? failure('invalid_hook_input', 'Native hook working directory escapes the Git worktree.')
			: { ok: true, value: base }
	} catch {
		return failure('invalid_hook_input', 'Native hook working directory is unavailable.')
	}
}

const patchPaths = (command: string | undefined): readonly string[] => {
	if (command === undefined) {
		return []
	}
	const paths: string[] = []
	for (const line of command.split(/\r?\n/u)) {
		const workPatch = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/u.exec(line)?.[1]
		const unifiedPatch = /^\+\+\+ b\/(.+)$/u.exec(line)?.[1]
		const path = workPatch ?? unifiedPatch
		if (path !== undefined) {
			paths.push(path)
		}
	}
	return [...new Set(paths)].slice(0, 1000)
}

const gitChangedFiles = async (
	root: string,
	source: 'workingTree' | 'staged',
): Promise<readonly string[]> => {
	const commands =
		source === 'staged'
			? [['diff', '--cached', '--name-only', '-z']]
			: [
					['diff', '--name-only', '-z', 'HEAD'],
					['diff', '--cached', '--name-only', '-z'],
					['ls-files', '--others', '--exclude-standard', '-z'],
				]
	const outputs = await Promise.all(commands.map(async (args) => git(root, args)))
	return [...new Set(outputs.flatMap((output) => output.split('\0').filter(Boolean)))]
		.filter((path) => validatePathLike(path) && Buffer.byteLength(path, 'utf8') <= 4096)
		.slice(0, 10_000)
}

const isSafeExecutable = async (root: string, command: string): Promise<boolean> => {
	if (!command.includes('/') && !command.includes('\\')) {
		return true
	}
	try {
		const candidate = resolve(root, command)
		const information = await lstat(candidate)
		if (information.isSymbolicLink() || !information.isFile()) {
			return false
		}
		const canonical = await realpath(candidate)
		const local = relative(root, canonical)
		return !local.startsWith('..') && !isAbsolute(local)
	} catch {
		return true
	}
}

const matchFiles = (
	files: readonly string[],
	changed: InferOutput<typeof ChangedFilesSchema>,
): boolean => {
	const included = changed.include ?? ['**/*']
	const excluded = changed.exclude ?? []
	const include = picomatch(included, { dot: true })
	const exclude = excluded.length === 0 ? (): boolean => false : picomatch(excluded, { dot: true })
	return files.some((path) => include(path) && !exclude(path))
}

const renderContext = (entry: HookEntry, result: CommandResult): string | undefined => {
	const failed = result.exitCode !== 0
	if (entry.output.mode === 'silent' || (entry.output.when === 'failure' && !failed)) {
		return undefined
	}
	const output = [result.stdout.trim(), result.stderr.trim()]
		.filter(Boolean)
		.join('\n')
		.slice(0, OUTPUT_MAX_BYTES)
	if (entry.output.mode === 'passthrough') {
		return `[work hook ${entry.id}]\n${output}`
	}
	return `[work hook ${entry.id}]\nInstruction: ${entry.output.instruction}\nCommand output:\n${output}`
}

const nativeOutput = (
	event: HookEvent,
	contexts: readonly string[],
	shouldBlock: boolean,
): string | undefined => {
	if (event === 'sessionEnd') {
		return undefined
	}
	if (event === 'beforeStop' && shouldBlock) {
		return JSON.stringify({
			decision: 'block',
			reason:
				contexts.length === 0
					? 'A blocking work hook failed. Inspect the configured check before stopping.'
					: contexts.join('\n\n'),
		})
	}
	if (contexts.length === 0) {
		return undefined
	}
	const context = contexts.join('\n\n')
	if (event === 'beforeStop') {
		return JSON.stringify({ systemMessage: context })
	}
	const hookEventName = {
		afterEdit: 'PostToolUse',
		sessionStart: 'SessionStart',
	}[event]
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName,
			additionalContext: context,
		},
	})
}

const unavailableConfigResult = (
	event: HookEvent,
	code: string,
):
	| WorkResult<{
			readonly status: 'review_required' | 'not_configured'
			readonly event: HookEvent
			readonly executions: readonly HookExecution[]
			readonly nativeOutput?: string
	  }>
	| undefined => {
	if (code === 'hooks_config_unavailable') {
		return { ok: true, value: { status: 'not_configured', event, executions: [] } }
	}
	if (code !== 'invalid_hooks_config' && code !== 'hooks_config_too_large') {
		return undefined
	}
	const output = nativeOutput(
		event,
		['work.json is invalid and hooks were not executed; run work hooks inspect.'],
		false,
	)
	return {
		ok: true,
		value: {
			status: 'review_required',
			event,
			executions: [],
			...(output === undefined ? {} : { nativeOutput: output }),
		},
	}
}

const hookOutcome = (result: CommandResult): HookExecution['outcome'] => {
	if (result.timedOut) {
		return 'timeout'
	}
	return result.exitCode === 0 ? 'success' : 'failure'
}

const parseNativeHookInput = (source: string): WorkResult<NativeHookInput> => {
	if (Buffer.byteLength(source, 'utf8') > NATIVE_INPUT_MAX_BYTES) {
		return failure('invalid_hook_input', 'Native hook input exceeds its byte limit.')
	}
	let document: unknown
	try {
		document = JSON.parse(source)
	} catch {
		return failure('invalid_hook_input', 'Native hook input is not valid JSON.')
	}
	const parsed = safeParse(NativeInputSchema, document)
	return parsed.success
		? { ok: true, value: parsed.output }
		: failure('invalid_hook_input', 'Native hook input failed validation.')
}

const executeHookEntry = async (input: {
	readonly root: string
	readonly entry: HookEntry
	readonly event: HookEvent
	readonly runtime: HookRuntime
	readonly sessionSource?: string
	readonly changedFiles?: readonly string[]
	readonly environment: Readonly<Record<string, string | undefined>>
	readonly deadline: number
	readonly runCommand: RunCommand
}): Promise<{ readonly startedAt: number; readonly result: CommandResult }> => {
	const startedAt = performance.now()
	const remainingMs = Math.max(0, Math.floor(input.deadline - startedAt))
	if (remainingMs === 0) {
		return {
			startedAt,
			result: { exitCode: 124, stdout: '', stderr: '', timedOut: true },
		}
	}
	if (!(await isSafeExecutable(input.root, input.entry.command))) {
		return {
			startedAt,
			result: {
				exitCode: 126,
				stdout: '',
				stderr: 'Executable path is unsafe.',
				timedOut: false,
			},
		}
	}
	return {
		startedAt,
		result: await input.runCommand({
			command: input.entry.command,
			args: input.entry.args ?? [],
			cwd: input.root,
			stdin: JSON.stringify({
				event: input.event,
				runtime: input.runtime,
				...(input.event === 'sessionStart' && input.sessionSource !== undefined
					? { sessionSource: input.sessionSource }
					: {}),
				...(input.changedFiles === undefined ? {} : { changedFiles: input.changedFiles }),
			}),
			timeoutMs: Math.min(input.entry.timeoutMs ?? 30_000, remainingMs),
			environment: input.environment,
		}),
	}
}

const recordExecutionTelemetry = async (input: {
	readonly recorder: HookTelemetryRecorder | undefined
	readonly event: HookEvent
	readonly execution: HookExecution
	readonly deadline: number
}): Promise<void> => {
	if (input.recorder === undefined) {
		return
	}
	const remainingMs = Math.floor(input.deadline - performance.now())
	if (remainingMs <= 0) {
		return
	}
	await input.recorder({
		event: input.event,
		...input.execution,
		...(input.event === 'sessionEnd' ? { maxWaitMs: Math.min(100, remainingMs) } : {}),
	})
}

/** @description Dispatches one normalized native event through trusted advisory repository hooks. */
export const dispatchWorkHooks = async (input: {
	readonly cwd: string
	readonly coordinationRoot: string
	readonly runtime: HookRuntime
	readonly nativeInput: string
	readonly environment?: Readonly<Record<string, string | undefined>>
	/** @internal */
	readonly runCommand?: RunCommand
	/** @internal */
	readonly recordTelemetry?: HookTelemetryRecorder
}): Promise<
	WorkResult<{
		readonly status: 'executed' | 'review_required' | 'not_configured'
		readonly event?: HookEvent
		readonly executions: readonly HookExecution[]
		readonly nativeOutput?: string
	}>
> => {
	const dispatchStartedAt = performance.now()
	const native = parseNativeHookInput(input.nativeInput)
	if (!native.ok) {
		return native
	}
	const event = nativeEvent(native.value.hook_event_name)
	if (event === undefined) {
		return failure('invalid_hook_input', 'Native hook event is unsupported.')
	}
	const dispatchBudgetMs =
		event === 'sessionEnd' ? SESSION_END_BUDGET_MS[input.runtime] : DISPATCH_MAX_MS
	const dispatchDeadline = dispatchStartedAt + dispatchBudgetMs
	const loaded = await loadConfig(input.cwd, dispatchDeadline)
	if (!loaded.ok) {
		return unavailableConfigResult(event, loaded.error.code) ?? loaded
	}
	const nativeCwd = await containedNativeCwd(loaded.value.root, native.value.cwd, input.cwd)
	if (!nativeCwd.ok) {
		return nativeCwd
	}
	const trust = await readTrust(input.coordinationRoot)
	if (!trust.ok) {
		return trust
	}
	if (!loaded.value.committed || !trust.value.includes(loaded.value.digest)) {
		const context = 'work.json changed or is not trusted; review it and run work hooks trust.'
		const output = nativeOutput(event, [context], false)
		return {
			ok: true,
			value: {
				status: 'review_required',
				event,
				executions: [],
				...(output === undefined ? {} : { nativeOutput: output }),
			},
		}
	}
	const executions: HookExecution[] = []
	const contexts: string[] = []
	let shouldBlock = false
	for (const entry of loaded.value.config.hooks[event] ?? []) {
		let skipReason: HookExecution['skipReason']
		let changedFiles: readonly string[] | undefined
		if (entry.when?.runtime !== undefined && !entry.when.runtime.includes(input.runtime)) {
			skipReason = 'runtime'
		}
		if (
			skipReason === undefined &&
			entry.when?.sessionSource !== undefined &&
			!entry.when.sessionSource.some((source) => source === native.value.source)
		) {
			skipReason = 'session_source'
		}
		if (skipReason === undefined && event === 'afterEdit') {
			const changed = entry.when?.changedFiles
			if (changed === undefined && !isRecognizedEdit(input.runtime, native.value.tool_name)) {
				skipReason = 'unrecognized_edit'
			}
			if (changed !== undefined) {
				const files =
					changed.source === 'event'
						? await containedEventPaths(loaded.value.root, nativeCwd.value, [
								native.value.tool_input?.file_path,
								native.value.tool_input?.path,
								native.value.tool_input?.notebook_path,
								...patchPaths(native.value.tool_input?.command),
							])
						: await gitChangedFiles(loaded.value.root, changed.source)
				if (matchFiles(files, changed)) {
					changedFiles = files
				} else {
					skipReason = 'changed_files'
				}
			}
		}
		if (skipReason !== undefined) {
			const execution: HookExecution = {
				id: entry.id,
				outcome: 'skipped',
				durationMs: 0,
				outputMode: entry.output.mode,
				skipReason,
			}
			executions.push(execution)
			await recordExecutionTelemetry({
				recorder: input.recordTelemetry,
				event,
				execution,
				deadline: dispatchDeadline,
			})
			continue
		}
		const executed = await executeHookEntry({
			root: loaded.value.root,
			entry,
			event,
			runtime: input.runtime,
			...(native.value.source === undefined ? {} : { sessionSource: native.value.source }),
			...(changedFiles === undefined ? {} : { changedFiles }),
			environment: input.environment ?? {},
			deadline: dispatchDeadline,
			runCommand: input.runCommand ?? defaultRunCommand,
		})
		const { result, startedAt } = executed
		const execution: HookExecution = {
			id: entry.id,
			outcome: hookOutcome(result),
			durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
			outputMode: entry.output.mode,
			exitCode: result.exitCode,
		}
		executions.push(execution)
		await recordExecutionTelemetry({
			recorder: input.recordTelemetry,
			event,
			execution,
			deadline: dispatchDeadline,
		})
		const context = renderContext(entry, result)
		if (context !== undefined) {
			contexts.push(context)
		}
		if (
			event === 'beforeStop' &&
			result.exitCode !== 0 &&
			entry.blockOnFailure === true &&
			native.value.stop_hook_active !== true
		) {
			shouldBlock = true
		}
	}
	const output = nativeOutput(event, contexts, shouldBlock)
	return {
		ok: true,
		value: {
			status: 'executed',
			event,
			executions,
			...(output === undefined ? {} : { nativeOutput: output }),
		},
	}
}
