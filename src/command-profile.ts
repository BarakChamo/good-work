/**
 * @description Aggregates bounded, command-local performance phases without retaining user data.
 *
 * @module work/command-profile
 * @file Command-profile.ts
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

export const COMMAND_PROFILE_PHASES = [
	'definition_compile',
	'provider_read',
	'provider_mutation',
	'git_observation',
	'recovery_publication',
] as const

export type CommandProfilePhase = (typeof COMMAND_PROFILE_PHASES)[number]

export interface CommandPhaseMeasurement {
	readonly phase: CommandProfilePhase
	readonly count: number
	readonly durationMs: number
}

interface Aggregate {
	count: number
	durationMs: number
}

interface Frame {
	childDurationMs: number
}

interface ProfileState {
	readonly aggregates: Map<CommandProfilePhase, Aggregate>
	readonly now: () => number
}

interface ProfileContext {
	readonly state: ProfileState
	readonly parent?: Frame
}

const maximumDurationMs = 86_400_000
const maximumCount = 10_000
const storage = new AsyncLocalStorage<ProfileContext>()

const record = (state: ProfileState, phase: CommandProfilePhase, durationMs: number): void => {
	const current = state.aggregates.get(phase) ?? { count: 0, durationMs: 0 }
	current.count = Math.min(maximumCount, current.count + 1)
	current.durationMs = Math.min(
		maximumDurationMs,
		current.durationMs + Math.max(0, Number.isFinite(durationMs) ? durationMs : 0),
	)
	state.aggregates.set(phase, current)
}

const finish = (
	context: ProfileContext,
	frame: Frame,
	phase: CommandProfilePhase,
	startedAt: number,
): void => {
	const elapsed = Math.max(0, context.state.now() - startedAt)
	record(context.state, phase, Math.max(0, elapsed - frame.childDurationMs))
	if (context.parent !== undefined) {
		context.parent.childDurationMs += elapsed
	}
}

/** @description Measures one exclusive asynchronous phase inside the active command context. */
export const measureCommandPhase = async <T>(
	phase: CommandProfilePhase,
	operation: () => Promise<T>,
): Promise<T> => {
	const context = storage.getStore()
	if (context === undefined) {
		return operation()
	}
	const frame: Frame = { childDurationMs: 0 }
	const startedAt = context.state.now()
	try {
		return await storage.run({ state: context.state, parent: frame }, operation)
	} finally {
		finish(context, frame, phase, startedAt)
	}
}

/** @description Measures one exclusive synchronous phase inside the active command context. */
export const measureCommandPhaseSync = <T>(phase: CommandProfilePhase, operation: () => T): T => {
	const context = storage.getStore()
	if (context === undefined) {
		return operation()
	}
	const frame: Frame = { childDurationMs: 0 }
	const startedAt = context.state.now()
	try {
		return storage.run({ state: context.state, parent: frame }, operation)
	} finally {
		finish(context, frame, phase, startedAt)
	}
}

/** @description Runs one command with an isolated fixed-vocabulary performance profile. */
export const withCommandPerformanceProfile = async <T>(
	operation: () => Promise<T>,
	options: { readonly now?: () => number } = {},
): Promise<{ readonly value: T; readonly phases: readonly CommandPhaseMeasurement[] }> => {
	const state: ProfileState = {
		aggregates: new Map(),
		now: options.now ?? (() => performance.now()),
	}
	const value = await storage.run({ state }, operation)
	const phases = COMMAND_PROFILE_PHASES.flatMap((phase) => {
		const aggregate = state.aggregates.get(phase)
		return aggregate === undefined
			? []
			: [
					{
						phase,
						count: aggregate.count,
						durationMs: Math.min(maximumDurationMs, Math.max(0, Math.round(aggregate.durationMs))),
					},
				]
	})
	return { value, phases }
}
