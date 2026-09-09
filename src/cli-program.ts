/**
 * @description Defines the typed Stricli command tree and adapts parsed commands to work-contract operations.
 *
 * @module work/cli-program
 * @file Cli-program.ts
 */

import { realpath, stat } from 'node:fs/promises'
import { dirname, parse, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { env as processEnvironment } from 'node:process'

import { buildApplication, buildCommand, buildRouteMap, help, run, text_en } from '@stricli/core'
import type { CommandContext, StricliProcess } from '@stricli/core'

import type { CliIo } from './cli'
import { resolveDefaultBeadsBinary } from './beads'

/** @description Parsed operation request passed from Stricli to the domain-oriented CLI executor. */
export interface WorkContractInvocation {
	readonly root: string
	readonly manifestPath: string
	readonly binary: string
	readonly json: boolean
	readonly command: string
	readonly positionals: readonly string[]
	readonly options: Readonly<Record<string, readonly string[]>>
}

type InvocationExecutor = (invocation: WorkContractInvocation, io: CliIo) => Promise<number>

interface WorkCliContext extends CommandContext {
	readonly process: StricliProcess
	readonly io: CliIo
	readonly execute: InvocationExecutor
	readonly execution: { started: boolean; route?: string }
}

interface CommonFlags {
	readonly root?: string
	readonly manifest?: string
	readonly bd?: string
	readonly json?: boolean
}

const parseText = (value: string): string => value

const commonFlags = {
	root: {
		kind: 'parsed',
		parse: (value: string): string => resolve(value),
		optional: true,
		brief: 'Repository root (defaults to the nearest work.yaml)',
		placeholder: 'path',
	},
	manifest: {
		kind: 'parsed',
		parse: parseText,
		optional: true,
		brief: 'Repository-relative work manifest path',
		placeholder: 'path',
	},
	bd: {
		kind: 'parsed',
		parse: parseText,
		optional: true,
		brief: 'Beads executable override',
		placeholder: 'path',
	},
	json: {
		kind: 'boolean',
		optional: true,
		brief: 'Emit stable machine-readable result envelopes',
	},
} as const

const noPositionals = { kind: 'tuple', parameters: [] } as const
const workIdPositional = {
	kind: 'tuple',
	parameters: [{ brief: 'Work item ID', placeholder: 'id', parse: parseText }],
} as const
const workReferencePositional = {
	kind: 'tuple',
	parameters: [
		{ brief: 'Work item ID or registered source path', placeholder: 'reference', parse: parseText },
	],
} as const

const options = (
	entries: readonly (readonly [string, string | boolean | readonly string[] | undefined])[],
): Readonly<Record<string, readonly string[]>> => {
	const output: Record<string, readonly string[]> = {}
	for (const [name, value] of entries) {
		if (value === undefined || value === false) {
			continue
		}
		output[name] = Array.isArray(value) ? value : [value === true ? 'true' : value]
	}
	return output
}

const isFile = async (path: string): Promise<boolean> => {
	try {
		const details = await stat(path)
		return details.isFile()
	} catch {
		return false
	}
}

const pathExists = async (path: string): Promise<boolean> => {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

const discoverWorkRoot = async (start: string): Promise<string> => {
	const fallback = resolve(start)
	let current = fallback
	while (true) {
		if (await isFile(resolve(current, 'work.yaml'))) {
			return current
		}
		if (await pathExists(resolve(current, '.git'))) {
			return fallback
		}
		const parent = dirname(current)
		if (parent === current) {
			return fallback
		}
		current = parent
	}
}

const replacePrivateRoots = (value: string, roots: readonly string[]): string => {
	let sanitized = value
	for (const root of roots) {
		sanitized = sanitized.split(root).join('<root>')
	}
	return sanitized.replaceAll(/(['"`])(?:\/(?!\/)|[A-Za-z]:[\\/])[^'"`\r\n]*\1/g, '$1<path>$1')
}

const sanitizeJsonValue = (value: unknown, roots: readonly string[]): unknown => {
	if (typeof value === 'string') {
		return replacePrivateRoots(value, roots)
	}
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeJsonValue(entry, roots))
	}
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, sanitizeJsonValue(entry, roots)]),
		)
	}
	return value
}

const sanitizeErrorOutput = (value: string, roots: readonly string[]): string => {
	try {
		return JSON.stringify(sanitizeJsonValue(JSON.parse(value), roots))
	} catch {
		return replacePrivateRoots(value, roots)
	}
}

const privateRootAliases = async (root: string): Promise<readonly string[]> => {
	const resolved = resolve(root)
	const canonical = await realpath(resolved).catch(() => resolved)
	return [...new Set([canonical, resolved])]
		.filter((candidate) => candidate !== parse(candidate).root)
		.toSorted((left, right) => right.length - left.length)
}

const invoke = async (
	context: WorkCliContext,
	flags: CommonFlags,
	command: string,
	positionals: readonly string[] = [],
	commandOptions: Readonly<Record<string, readonly string[]>> = {},
): Promise<void> => {
	context.execution.started = true
	const root = flags.root ?? (await discoverWorkRoot(process.cwd()))
	const privateRoots = await privateRootAliases(root)
	context.process.exitCode = await context.execute(
		{
			root,
			manifestPath: flags.manifest ?? 'work.yaml',
			binary: flags.bd ?? resolveDefaultBeadsBinary(),
			json: flags.json ?? false,
			command,
			positionals,
			options: commandOptions,
		},
		{
			stdout: context.io.stdout,
			...(context.io.stdin === undefined ? {} : { stdin: context.io.stdin }),
			stderr: (value): void => {
				context.io.stderr(sanitizeErrorOutput(value, privateRoots))
			},
		},
	)
}

const noArgumentCommand = (command: string, brief: string) =>
	buildCommand<CommonFlags, [], WorkCliContext>({
		async func(flags): Promise<void> {
			await invoke(this, flags, command)
		},
		parameters: { flags: commonFlags, positional: noPositionals },
		docs: { brief },
	})

const initCommand = buildCommand<
	CommonFlags & { readonly project: string; readonly force: boolean },
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(
			this,
			flags,
			'init',
			[],
			options([
				['project', flags.project],
				['force', flags.force],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			project: {
				kind: 'parsed',
				parse: parseText,
				brief: 'Project slug and Beads prefix',
				placeholder: 'slug',
			},
			force: { kind: 'boolean', default: false, brief: 'Replace an existing manifest' },
		},
		positional: noPositionals,
	},
	docs: { brief: 'Create a work manifest and initialize the bundled Beads provider' },
})

const syncCommand = buildCommand<
	CommonFlags & {
		readonly check: boolean
		readonly plan: boolean
		readonly apply: boolean
		readonly archiveMissing: boolean
	},
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(
			this,
			flags,
			'sync',
			[],
			options([
				['check', flags.check],
				['plan', flags.plan],
				['apply', flags.apply],
				['archive-missing', flags.archiveMissing],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			check: { kind: 'boolean', default: false, brief: 'Exit 2 when actionable drift exists' },
			plan: { kind: 'boolean', default: false, brief: 'Print the deterministic sync plan' },
			apply: {
				kind: 'boolean',
				default: false,
				brief: 'Apply the committed canonical-target sync plan',
			},
			archiveMissing: {
				kind: 'boolean',
				default: false,
				brief: 'Archive ledger items missing from source files',
			},
		},
		positional: noPositionals,
	},
	docs: { brief: 'Reconcile committed canonical definitions with Beads operational state' },
})

const driftCommand = buildCommand<
	CommonFlags & { readonly archiveMissing: boolean },
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(this, flags, 'drift', [], options([['archive-missing', flags.archiveMissing]]))
	},
	parameters: {
		flags: {
			...commonFlags,
			archiveMissing: {
				kind: 'boolean',
				default: false,
				brief: 'Include missing-source archive actions in drift',
			},
		},
		positional: noPositionals,
	},
	docs: { brief: 'Check definition drift using the default non-mutating mode' },
})

const graphCommand = buildCommand<
	CommonFlags & { readonly depth?: string },
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(this, flags, 'graph', [id], options([['depth', flags.depth]]))
	},
	parameters: {
		flags: {
			...commonFlags,
			depth: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Maximum descendant depth',
				placeholder: 'number',
			},
		},
		positional: workIdPositional,
	},
	docs: { brief: 'Project a bounded work hierarchy from one item' },
})

const readyCommand = buildCommand<
	CommonFlags & { readonly role?: string; readonly limit?: string },
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(
			this,
			flags,
			'ready',
			[],
			options([
				['role', flags.role],
				['limit', flags.limit],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			role: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Filter by allowed role',
			},
			limit: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Maximum returned items',
				placeholder: 'number',
			},
		},
		positional: noPositionals,
	},
	docs: { brief: 'List dependency-ready, role-compatible work' },
})

const showCommand = buildCommand<CommonFlags, [string], WorkCliContext>({
	async func(flags, id): Promise<void> {
		await invoke(this, flags, 'show', [id])
	},
	parameters: { flags: commonFlags, positional: workIdPositional },
	docs: { brief: 'Inspect one definition, operation, and aggregate child progress' },
})

const statusCommand = buildCommand<CommonFlags, [string], WorkCliContext>({
	async func(flags, id): Promise<void> {
		await invoke(this, flags, 'status', [id])
	},
	parameters: { flags: commonFlags, positional: workIdPositional },
	docs: { brief: 'Inspect task state or aggregate direct-child readiness' },
})

const prepareCommand = buildCommand<CommonFlags, [string], WorkCliContext>({
	async func(flags, reference): Promise<void> {
		await invoke(this, flags, 'prepare', [reference])
	},
	parameters: { flags: commonFlags, positional: workReferencePositional },
	docs: { brief: 'Validate and load a bounded launch packet without claiming work' },
})

const startCommand = buildCommand<
	CommonFlags & { readonly actor: string; readonly role?: string; readonly session?: string },
	[string],
	WorkCliContext
>({
	async func(flags, reference): Promise<void> {
		await invoke(
			this,
			flags,
			'start',
			[reference],
			options([
				['actor', flags.actor],
				['role', flags.role],
				['session', flags.session],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Stable worker identity' },
			role: { kind: 'parsed', parse: parseText, optional: true, brief: 'Assigned role' },
			session: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Session correlation ID',
			},
		},
		positional: workReferencePositional,
	},
	docs: { brief: 'Prepare, validate workspace admission, and atomically claim work' },
})

const contextCommand = buildCommand<
	CommonFlags & { readonly maxBytes?: string },
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(this, flags, 'context', [id], options([['max-bytes', flags.maxBytes]]))
	},
	parameters: {
		flags: {
			...commonFlags,
			maxBytes: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Maximum UTF-8 context size',
				placeholder: 'bytes',
			},
		},
		positional: workIdPositional,
	},
	docs: { brief: 'Build a bounded work packet for a human or agent session' },
})

const rollupCommand = buildCommand<CommonFlags, [string], WorkCliContext>({
	async func(flags, id): Promise<void> {
		await invoke(this, flags, 'rollup', [id])
	},
	parameters: { flags: commonFlags, positional: workIdPositional },
	docs: { brief: 'Aggregate descendant progress, blocks, and evidence' },
})

const claimCommand = buildCommand<
	CommonFlags & {
		readonly actor: string
		readonly role?: string
		readonly session?: string
	},
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(
			this,
			flags,
			'claim',
			[id],
			options([
				['actor', flags.actor],
				['role', flags.role],
				['session', flags.session],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Stable worker identity' },
			role: { kind: 'parsed', parse: parseText, optional: true, brief: 'Assigned role' },
			session: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Session correlation ID',
			},
		},
		positional: workIdPositional,
	},
	docs: { brief: 'Atomically claim ready work for one actor' },
})

const roleAssertionFlag = {
	kind: 'parsed',
	parse: parseText,
	optional: true,
	brief: 'Assert the active claim role',
} as const

const sessionAssertionFlag = {
	kind: 'parsed',
	parse: parseText,
	optional: true,
	brief: 'Assert the active claim session',
} as const

const reviewerSessionFlag = {
	kind: 'parsed',
	parse: parseText,
	optional: true,
	brief: 'Reviewer session identity for audit',
} as const

const touchCommand = buildCommand<
	CommonFlags & { readonly actor: string; readonly role?: string; readonly session?: string },
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(
			this,
			flags,
			'touch',
			[id],
			options([
				['actor', flags.actor],
				['role', flags.role],
				['session', flags.session],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Stable worker identity' },
			role: roleAssertionFlag,
			session: sessionAssertionFlag,
		},
		positional: workIdPositional,
	},
	docs: { brief: 'Record meaningful progress on actor-owned work' },
})

const resumeCommand = buildCommand<
	CommonFlags & { readonly actor: string; readonly role?: string; readonly session?: string },
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(
			this,
			flags,
			'resume',
			[id],
			options([
				['actor', flags.actor],
				['role', flags.role],
				['session', flags.session],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Stable worker identity' },
			role: roleAssertionFlag,
			session: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'New session correlation ID',
			},
		},
		positional: workIdPositional,
	},
	docs: { brief: 'Resume a compatible actor-owned session' },
})

const handoffCommand = buildCommand<
	CommonFlags & {
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly summaryFile: string
		readonly remaining?: readonly string[]
		readonly reference?: readonly string[]
		readonly toActor?: string
		readonly release: boolean
	},
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(
			this,
			flags,
			'handoff',
			[id],
			options([
				['actor', flags.actor],
				['role', flags.role],
				['session', flags.session],
				['summary-file', flags.summaryFile],
				['remaining', flags.remaining],
				['reference', flags.reference],
				['to-actor', flags.toActor],
				['release', flags.release],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Current owner identity' },
			role: roleAssertionFlag,
			session: sessionAssertionFlag,
			summaryFile: {
				kind: 'parsed',
				parse: parseText,
				brief: 'Repository-relative handoff summary file',
				placeholder: 'path',
			},
			remaining: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				variadic: true,
				brief: 'Remaining work item (repeatable)',
			},
			reference: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				variadic: true,
				brief: 'Durable reference (repeatable)',
			},
			toActor: { kind: 'parsed', parse: parseText, optional: true, brief: 'Intended next actor' },
			release: { kind: 'boolean', default: false, brief: 'Release ownership after handoff' },
		},
		positional: workIdPositional,
	},
	docs: { brief: 'Persist bounded cross-session continuation context' },
})

const reasonCommand = (command: 'block' | 'release' | 'reopen', brief: string) =>
	buildCommand<
		CommonFlags & {
			readonly actor: string
			readonly role?: string
			readonly session?: string
			readonly reason: string
		},
		[string],
		WorkCliContext
	>({
		async func(flags, id): Promise<void> {
			await invoke(
				this,
				flags,
				command,
				[id],
				options([
					['actor', flags.actor],
					['role', flags.role],
					['session', flags.session],
					['reason', flags.reason],
				]),
			)
		},
		parameters: {
			flags: {
				...commonFlags,
				actor: { kind: 'parsed', parse: parseText, brief: 'Current owner identity' },
				role: roleAssertionFlag,
				session: sessionAssertionFlag,
				reason: { kind: 'parsed', parse: parseText, brief: 'Auditable transition reason' },
			},
			positional: workIdPositional,
		},
		docs: { brief },
	})

const terminalCommand = (command: 'complete' | 'reconcile', brief: string) =>
	buildCommand<
		CommonFlags & {
			readonly actor: string
			readonly role?: string
			readonly session?: string
			readonly evidence?: readonly string[]
			readonly evidenceDigest?: readonly string[]
			readonly receipt?: readonly string[]
		},
		[string],
		WorkCliContext
	>({
		async func(flags, id): Promise<void> {
			await invoke(
				this,
				flags,
				command,
				[id],
				options([
					['actor', flags.actor],
					['role', flags.role],
					['session', flags.session],
					['evidence', flags.evidence],
					['evidence-digest', flags.evidenceDigest],
					['receipt', flags.receipt],
				]),
			)
		},
		parameters: {
			flags: {
				...commonFlags,
				actor: { kind: 'parsed', parse: parseText, brief: 'Current owner identity' },
				role: roleAssertionFlag,
				session: sessionAssertionFlag,
				evidence: {
					kind: 'parsed',
					parse: parseText,
					optional: true,
					variadic: true,
					brief: 'Verified kind=reference evidence (repeatable)',
				},
				evidenceDigest: {
					kind: 'parsed',
					parse: parseText,
					optional: true,
					variadic: true,
					brief: 'External kind=sha256 digest (repeatable)',
				},
				receipt: {
					kind: 'parsed',
					parse: parseText,
					optional: true,
					variadic: true,
					brief: 'Candidate-bound delivery receipt JSON file (repeatable)',
				},
			},
			positional: workIdPositional,
		},
		docs: { brief },
	})

const completeCommand = terminalCommand(
	'complete',
	'Complete owned task work or evidence-ready aggregate work',
)
const reconcileCommand = terminalCommand(
	'reconcile',
	'Observe landed state and idempotently complete actor-owned work',
)

const finalizeCommand = buildCommand<
	CommonFlags & {
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly evidence?: readonly string[]
		readonly evidenceDigest?: readonly string[]
	},
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(
			this,
			flags,
			'finalize',
			[id],
			options([
				['actor', flags.actor],
				['role', flags.role],
				['session', flags.session],
				['evidence', flags.evidence],
				['evidence-digest', flags.evidenceDigest],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Current owner identity' },
			role: roleAssertionFlag,
			session: sessionAssertionFlag,
			evidence: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				variadic: true,
				brief: 'Verified kind=reference evidence (repeatable)',
			},
			evidenceDigest: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				variadic: true,
				brief: 'Optional kind=sha256 assertion (repeatable)',
			},
		},
		positional: workIdPositional,
	},
	docs: { brief: 'Write the selected item completion record for review and landing' },
})

const submitCommand = buildCommand<
	CommonFlags & {
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly evidence?: readonly string[]
		readonly evidenceDigest?: readonly string[]
	},
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(
			this,
			flags,
			'submit',
			[id],
			options([
				['actor', flags.actor],
				['role', flags.role],
				['session', flags.session],
				['evidence', flags.evidence],
				['evidence-digest', flags.evidenceDigest],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Current owner identity' },
			role: roleAssertionFlag,
			session: sessionAssertionFlag,
			evidence: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				variadic: true,
				brief: 'Verified kind=reference evidence (repeatable)',
			},
			evidenceDigest: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				variadic: true,
				brief: 'External kind=sha256 digest (repeatable)',
			},
		},
		positional: workIdPositional,
	},
	docs: { brief: 'Record an exact candidate and candidate-bound validation evidence' },
})

const proposalIdPositional = {
	kind: 'tuple',
	parameters: [{ brief: 'Planning proposal ID', placeholder: 'id', parse: parseText }],
} as const

const allowDeleteFlag = {
	kind: 'boolean',
	default: false,
	brief: 'Authorize explicit source deletions',
} as const

const proposalValidateCommand = buildCommand<
	CommonFlags & { readonly allowDelete: boolean },
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(
			this,
			flags,
			'proposal',
			['validate', id],
			options([['allow-delete', flags.allowDelete]]),
		)
	},
	parameters: {
		flags: { ...commonFlags, allowDelete: allowDeleteFlag },
		positional: proposalIdPositional,
	},
	docs: { brief: 'Validate a revision-bound planning proposal' },
})

const proposalApplyCommand = buildCommand<
	CommonFlags & { readonly allowDelete: boolean; readonly approve: string },
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(
			this,
			flags,
			'proposal',
			['apply', id],
			options([
				['allow-delete', flags.allowDelete],
				['approve', flags.approve],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			allowDelete: allowDeleteFlag,
			approve: {
				kind: 'parsed',
				parse: parseText,
				brief: 'Exact validated proposal fingerprint',
			},
		},
		positional: proposalIdPositional,
	},
	docs: { brief: 'Apply an exactly approved planning proposal' },
})

const skillInstallCommand = buildCommand<
	CommonFlags & { readonly force: boolean },
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(this, flags, 'skill', ['install'], options([['force', flags.force]]))
	},
	parameters: {
		flags: {
			...commonFlags,
			force: { kind: 'boolean', default: false, brief: 'Replace a locally modified skill' },
		},
		positional: noPositionals,
	},
	docs: { brief: 'Install the packaged agent-neutral skill into this repository' },
})

const feedbackCommand = buildCommand<
	CommonFlags & {
		readonly kind: string
		readonly message: string
		readonly workId?: string
		readonly actor?: string
		readonly session?: string
	},
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(
			this,
			flags,
			'feedback',
			[],
			options([
				['kind', flags.kind],
				['message', flags.message],
				['work-id', flags.workId],
				['actor', flags.actor],
				['session', flags.session],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			kind: {
				kind: 'parsed',
				parse: parseText,
				brief: 'Feedback kind: bug, friction, idea, docs, or other',
			},
			message: { kind: 'parsed', parse: parseText, brief: 'Bounded feedback summary' },
			workId: { kind: 'parsed', parse: parseText, optional: true, brief: 'Related work ID' },
			actor: { kind: 'parsed', parse: parseText, optional: true, brief: 'Reporting actor' },
			session: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Related agent or human session ID',
			},
		},
		positional: noPositionals,
	},
	docs: { brief: 'Capture bounded local dogfood feedback for later triage' },
})

const telemetryToggleCommand = (action: 'enable' | 'disable', brief: string) =>
	buildCommand<CommonFlags, [], WorkCliContext>({
		async func(flags): Promise<void> {
			await invoke(this, flags, 'telemetry', [action])
		},
		parameters: { flags: commonFlags, positional: noPositionals },
		docs: { brief },
	})

const telemetryShowCommand = buildCommand<
	CommonFlags & {
		readonly limit?: string
		readonly sessionId?: string
		readonly sessionCorrelation?: string
		readonly workId?: string
	},
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(
			this,
			flags,
			'telemetry',
			['show'],
			options([
				['limit', flags.limit],
				['session-id', flags.sessionId],
				['session-correlation', flags.sessionCorrelation],
				['work-id', flags.workId],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			limit: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Maximum newest events to return',
				placeholder: 'number',
			},
			sessionId: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Filter using a known local session ID',
				placeholder: 'id',
			},
			sessionCorrelation: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Filter using a correlation from telemetry sessions',
				placeholder: 'digest',
			},
			workId: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Filter using a known repository work ID',
				placeholder: 'id',
			},
		},
		positional: noPositionals,
	},
	docs: { brief: 'Review bounded sanitized local command telemetry' },
})

const telemetrySessionsCommand = buildCommand<
	CommonFlags & { readonly limit?: string },
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(this, flags, 'telemetry', ['sessions'], options([['limit', flags.limit]]))
	},
	parameters: {
		flags: {
			...commonFlags,
			limit: {
				kind: 'parsed',
				parse: parseText,
				optional: true,
				brief: 'Maximum newest session summaries to return',
				placeholder: 'number',
			},
		},
		positional: noPositionals,
	},
	docs: { brief: 'Index privacy-preserving local command sessions' },
})

const proposalRoutes = buildRouteMap({
	routes: {
		validate: proposalValidateCommand,
		apply: proposalApplyCommand,
	},
	docs: { brief: 'Validate and apply reviewable file-definition proposals' },
})

const skillRoutes = buildRouteMap({
	routes: { install: skillInstallCommand },
	docs: { brief: 'Install optional agent integration assets' },
})

const providerRoutes = buildRouteMap({
	routes: {
		install: buildCommand<CommonFlags, [], WorkCliContext>({
			async func(flags): Promise<void> {
				await invoke(this, flags, 'provider', ['install'])
			},
			parameters: { flags: commonFlags, positional: noPositionals },
			docs: { brief: 'Download and verify the pinned native Beads executable' },
		}),
	},
	docs: { brief: 'Install and inspect the local work-state provider' },
})

const telemetryRoutes = buildRouteMap({
	routes: {
		enable: telemetryToggleCommand('enable', 'Re-enable local sanitized command telemetry'),
		disable: telemetryToggleCommand('disable', 'Persistently disable local command telemetry'),
		show: telemetryShowCommand,
		sessions: telemetrySessionsCommand,
	},
	docs: { brief: 'Control and inspect default-on local command telemetry' },
})

const hookActionCommand = (
	action: 'init' | 'inspect' | 'trust' | 'untrust' | 'status',
	brief: string,
) =>
	buildCommand<CommonFlags, [], WorkCliContext>({
		async func(flags): Promise<void> {
			await invoke(this, flags, 'hooks', [action])
		},
		parameters: { flags: commonFlags, positional: noPositionals },
		docs: { brief },
	})

const hookDispatchCommand = buildCommand<
	CommonFlags & { readonly runtime: 'auto' | 'codex' | 'claude' },
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(this, flags, 'hooks', ['dispatch'], options([['runtime', flags.runtime]]))
	},
	parameters: {
		flags: {
			...commonFlags,
			runtime: {
				kind: 'parsed',
				parse: (value: string): 'auto' | 'codex' | 'claude' => {
					if (value !== 'auto' && value !== 'codex' && value !== 'claude') {
						throw new Error('Runtime must be auto, codex, or claude.')
					}
					return value
				},
				default: 'auto',
				brief: 'Native hook runtime (auto detects Claude, otherwise Codex)',
			},
		},
		positional: noPositionals,
	},
	docs: { brief: 'Dispatch one trusted native hook event from standard input' },
})

const hookRoutes = buildRouteMap({
	routes: {
		init: hookActionCommand('init', 'Create a minimal repository-root work.json'),
		inspect: hookActionCommand('inspect', 'Validate and inspect work.json without execution'),
		trust: hookActionCommand('trust', 'Trust the reviewed committed work.json digest'),
		untrust: hookActionCommand('untrust', 'Remove local trust for work.json'),
		status: hookActionCommand('status', 'Report hook configuration, plugin, CLI, and trust health'),
		dispatch: hookDispatchCommand,
	},
	docs: { brief: 'Configure and dispatch trusted advisory engineering hooks' },
})

const integrationAcquireCommand = buildCommand<
	CommonFlags & { readonly actor: string; readonly session?: string },
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(
			this,
			flags,
			'integration',
			['acquire'],
			options([
				['actor', flags.actor],
				['session', flags.session],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Integration worker identity' },
			session: sessionAssertionFlag,
		},
		positional: noPositionals,
	},
	docs: { brief: 'Acquire the local integration mutex' },
})

const integrationReleaseCommand = buildCommand<
	CommonFlags & { readonly actor: string; readonly session?: string; readonly nonce: string },
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(
			this,
			flags,
			'integration',
			['release'],
			options([
				['actor', flags.actor],
				['session', flags.session],
				['nonce', flags.nonce],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Integration worker identity' },
			session: sessionAssertionFlag,
			nonce: {
				kind: 'parsed',
				parse: parseText,
				brief: 'Exact nonce returned by integration acquire',
			},
		},
		positional: noPositionals,
	},
	docs: { brief: 'Release the exact owned local integration mutex' },
})

const integrationRecoverCommand = buildCommand<
	CommonFlags & { readonly actor: string; readonly session?: string; readonly reason: string },
	[],
	WorkCliContext
>({
	async func(flags): Promise<void> {
		await invoke(
			this,
			flags,
			'integration',
			['recover'],
			options([
				['actor', flags.actor],
				['session', flags.session],
				['reason', flags.reason],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'New integration worker identity' },
			session: sessionAssertionFlag,
			reason: { kind: 'parsed', parse: parseText, brief: 'Auditable recovery reason' },
		},
		positional: noPositionals,
	},
	docs: { brief: 'Explicitly replace a stale integration mutex after inspection' },
})

const integrationRoutes = buildRouteMap({
	routes: {
		status: buildCommand<CommonFlags, [], WorkCliContext>({
			async func(flags): Promise<void> {
				await invoke(this, flags, 'integration', ['status'])
			},
			parameters: { flags: commonFlags, positional: noPositionals },
			docs: { brief: 'Show the local integration mutex' },
		}),
		acquire: integrationAcquireCommand,
		release: integrationReleaseCommand,
		recover: integrationRecoverCommand,
	},
	docs: { brief: 'Coordinate one local external integration at a time' },
})

const reviewStatusCommand = buildCommand<CommonFlags, [string], WorkCliContext>({
	async func(flags, id): Promise<void> {
		await invoke(this, flags, 'review', ['status', id])
	},
	parameters: { flags: commonFlags, positional: workIdPositional },
	docs: { brief: 'Show the current independent-review decision and freshness' },
})

const reviewPrepareCommand = buildCommand<
	CommonFlags & { readonly actor: string; readonly role?: string; readonly session?: string },
	[string],
	WorkCliContext
>({
	async func(flags, id): Promise<void> {
		await invoke(
			this,
			flags,
			'review',
			['prepare', id],
			options([
				['actor', flags.actor],
				['role', flags.role],
				['session', flags.session],
			]),
		)
	},
	parameters: {
		flags: {
			...commonFlags,
			actor: { kind: 'parsed', parse: parseText, brief: 'Current implementation owner' },
			role: roleAssertionFlag,
			session: sessionAssertionFlag,
		},
		positional: workIdPositional,
	},
	docs: { brief: 'Prepare the exact clean implementation for a distinct reviewer' },
})

const reviewDecisionCommand = (action: 'approve' | 'request-changes', brief: string) =>
	buildCommand<
		CommonFlags & {
			readonly actor: string
			readonly session?: string
			readonly evaluator: 'agent' | 'human'
			readonly report: string
			readonly head: string
		},
		[string],
		WorkCliContext
	>({
		async func(flags, id): Promise<void> {
			await invoke(
				this,
				flags,
				'review',
				[action, id],
				options([
					['actor', flags.actor],
					['session', flags.session],
					['evaluator', flags.evaluator],
					['report', flags.report],
					['head', flags.head],
				]),
			)
		},
		parameters: {
			flags: {
				...commonFlags,
				actor: { kind: 'parsed', parse: parseText, brief: 'Distinct reviewer identity' },
				session: reviewerSessionFlag,
				evaluator: {
					kind: 'parsed',
					parse: (value: string): 'agent' | 'human' => {
						if (value !== 'agent' && value !== 'human') {
							throw new Error('Evaluator must be agent or human.')
						}
						return value
					},
					brief: 'Reviewer kind',
				},
				report: { kind: 'parsed', parse: parseText, brief: 'Repository-relative review report' },
				head: { kind: 'parsed', parse: parseText, brief: 'Exact head returned by review prepare' },
			},
			positional: workIdPositional,
		},
		docs: { brief },
	})

const reviewRoutes = buildRouteMap({
	routes: {
		status: reviewStatusCommand,
		prepare: reviewPrepareCommand,
		approve: reviewDecisionCommand('approve', 'Approve the exact implementation under review'),
		'request-changes': reviewDecisionCommand(
			'request-changes',
			'Request changes without closing or reopening the work item',
		),
	},
	docs: { brief: 'Prepare and record independent review without running an agent' },
})

const rootRoutes = buildRouteMap({
	routes: {
		init: initCommand,
		doctor: noArgumentCommand('doctor', 'Verify manifest compilation and Beads compatibility'),
		compile: noArgumentCommand('compile', 'Compile and print the deterministic work graph'),
		dashboard: noArgumentCommand('dashboard', 'Show a compact ready and active work inbox'),
		overview: noArgumentCommand('overview', 'Show agent actions with ready and active work'),
		snapshot: noArgumentCommand('snapshot', 'Refresh the replaceable operational snapshot'),
		sync: syncCommand,
		drift: driftCommand,
		graph: graphCommand,
		ready: readyCommand,
		active: noArgumentCommand('active', 'List currently claimed or blocked work'),
		export: noArgumentCommand('export', 'Refresh the ignored shared-state recovery export'),
		show: showCommand,
		status: statusCommand,
		prepare: prepareCommand,
		start: startCommand,
		context: contextCommand,
		rollup: rollupCommand,
		claim: claimCommand,
		touch: touchCommand,
		resume: resumeCommand,
		handoff: handoffCommand,
		block: reasonCommand('block', 'Block actor-owned in-progress work'),
		release: reasonCommand('release', 'Release actor-owned work for reassignment'),
		reopen: reasonCommand('reopen', 'Reopen blocked or completed work'),
		finalize: finalizeCommand,
		complete: completeCommand,
		reconcile: reconcileCommand,
		submit: submitCommand,
		feedback: feedbackCommand,
		proposal: proposalRoutes,
		skill: skillRoutes,
		provider: providerRoutes,
		telemetry: telemetryRoutes,
		hooks: hookRoutes,
		integration: integrationRoutes,
		review: reviewRoutes,
	},
	docs: {
		brief: 'Git-native work contracts on Beads',
		fullDescription:
			'Compile file-owned plans, coordinate mutable work through Beads, and hand bounded context across humans and agents.',
	},
})

const helpFormatting = {
	caseStyle: 'convert-camel-to-kebab',
	onlyRequiredInUsageLine: false,
	useAliasInUsageLine: false,
} as const

const application = buildApplication(
	rootRoutes,
	{
		name: 'work',
		determineExitCode: () => 2,
		scanner: { caseStyle: 'allow-kebab-for-camel' },
	},
	{
		help: help({
			brief: 'Print help information and exit',
			defaultForRouteMap: true,
			formatting: helpFormatting,
		}),
		lifecycle: {
			hooks: {
				'command:start'({ result }): void {
					const route = result.prefix.filter((part) => part !== 'work').join(' ')
					if (route.length > 0) {
						this.execution.route = route
					}
				},
			},
		},
	},
)

/** @description Generates complete command reference text from the Stricli command tree. */
export const renderWorkContractHelp = (): string =>
	rootRoutes.formatHelp({
		prefix: ['work'],
		config: helpFormatting,
		ansiColor: false,
		text: text_en,
		additionalFlags: [
			{
				name: 'help',
				brief: 'Print help information and exit',
				aliases: ['h'],
			},
		],
		includeArgumentEscapeSequenceFlag: false,
		includeHidden: false,
	})

const normalizeGlobalFlags = (args: readonly string[]): readonly string[] => {
	const routeAndCommand: string[] = []
	const common: { root?: string; manifest?: string; bd?: string; json?: boolean } = {}
	const setCommonValue = (name: string, value: string): void => {
		if (name === 'root' || name === 'manifest' || name === 'bd') {
			common[name] = value
		}
	}
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index]
		if (value === '--') {
			routeAndCommand.push(...args.slice(index))
			break
		}
		if (value === '--json' || value === '--json=true') {
			common.json = true
			continue
		}
		if (value === '--no-json' || value === '--json=false') {
			common.json = false
			continue
		}
		if (value === '--root' || value === '--manifest' || value === '--bd') {
			const argument = args[index + 1]
			if (argument === undefined || argument.startsWith('--')) {
				return args
			}
			setCommonValue(value.slice(2), argument)
			index += 1
			continue
		}
		const assigned = /^--(root|manifest|bd)=(.*)$/s.exec(value ?? '')
		if (assigned !== null) {
			setCommonValue(assigned[1] ?? '', assigned[2] ?? '')
			continue
		}
		if (value !== undefined) {
			routeAndCommand.push(value)
		}
	}
	const globalFlags: string[] = []
	for (const name of ['root', 'manifest', 'bd'] as const) {
		const value = common[name]
		if (value !== undefined) {
			globalFlags.push(`--${name}`, value)
		}
	}
	if (common.json !== undefined) {
		globalFlags.push(common.json ? '--json' : '--no-json')
	}
	return [...routeAndCommand, ...globalFlags]
}

/** @description Runs the Stricli grammar while preserving the public CLI output and exit-code contract. */
export const runWorkContractProgram = async (input: {
	readonly args: readonly string[]
	readonly io: CliIo
	readonly execute: InvocationExecutor
	readonly onInvalidInvocation?: (failure: {
		readonly root: string
		readonly manifestPath: string
		readonly command: string
		readonly failureStage: 'routing' | 'arguments'
		readonly exitCode: number
		readonly durationMs: number
	}) => Promise<void>
}): Promise<number> => {
	const startedAt = performance.now()
	const stdout: string[] = []
	const stderr: string[] = []
	const processBoundary: StricliProcess = {
		stdout: { write: (value): void => void stdout.push(value) },
		stderr: { write: (value): void => void stderr.push(value) },
		env: { ...processEnvironment, STRICLI_NO_COLOR: '1' },
		exitCode: null,
	}
	const execution: { started: boolean; route?: string } = { started: false }
	const normalized = normalizeGlobalFlags(input.args)
	const defaulted =
		normalized.length === 0 ||
		(normalized[0]?.startsWith('--') === true && !normalized.includes('--help'))
			? ['overview', ...normalized]
			: normalized
	const args = defaulted[0] === 'help' ? ['--help'] : defaulted
	await run(application, args, {
		process: processBoundary,
		io: input.io,
		execute: input.execute,
		execution,
	})
	const exitCode = Number(processBoundary.exitCode ?? 0)
	if (!execution.started && exitCode !== 0 && input.onInvalidInvocation !== undefined) {
		const rootIndex = normalized.lastIndexOf('--root')
		const rootValue = rootIndex === -1 ? undefined : normalized[rootIndex + 1]
		const manifestIndex = normalized.lastIndexOf('--manifest')
		const manifestValue = manifestIndex === -1 ? undefined : normalized[manifestIndex + 1]
		await input.onInvalidInvocation({
			root: rootValue === undefined ? await discoverWorkRoot(process.cwd()) : resolve(rootValue),
			manifestPath:
				manifestValue === undefined || manifestValue.startsWith('--') ? 'work.yaml' : manifestValue,
			command: execution.route ?? 'cli',
			failureStage: execution.route === undefined ? 'routing' : 'arguments',
			exitCode: exitCode < 0 ? 2 : exitCode,
			durationMs: performance.now() - startedAt,
		})
	}
	if (stdout.length > 0) {
		input.io.stdout(stdout.join('').trimEnd())
	}
	if (stderr.length > 0) {
		const message =
			execution.route === undefined
				? 'Unknown work command; run work --help'
				: `Invalid arguments for work ${execution.route}; run work ${execution.route} --help`
		input.io.stderr(
			!execution.started && args.includes('--json')
				? JSON.stringify({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'invalid_cli_invocation',
							message,
						},
					})
				: message,
		)
	}
	return exitCode < 0 ? 2 : exitCode
}
