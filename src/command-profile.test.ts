/**
 * @description Verifies command-local, exclusive performance-phase aggregation.
 *
 * @module work/command-profile
 * @file Command-profile.test.ts
 */

import { describe, expect, it } from 'vitest'

import {
	measureCommandPhase,
	measureCommandPhaseSync,
	withCommandPerformanceProfile,
} from './command-profile'

describe('command performance profile', () => {
	it('aggregates nested phases as exclusive bounded command-local measurements', async () => {
		expect.assertions(2)
		const times = [0, 2, 5, 10]
		const profiled = await withCommandPerformanceProfile(
			async () =>
				measureCommandPhase('recovery_publication', async () =>
					measureCommandPhaseSync('provider_read', () => 'complete'),
				),
			{ now: () => times.shift() ?? 10 },
		)

		expect(profiled.value).toBe('complete')
		expect(profiled.phases).toStrictEqual([
			{ phase: 'provider_read', count: 1, durationMs: 3 },
			{ phase: 'recovery_publication', count: 1, durationMs: 7 },
		])
	})

	it('does not carry measurements between command contexts', async () => {
		expect.assertions(2)
		const first = await withCommandPerformanceProfile(async () =>
			measureCommandPhaseSync('provider_mutation', () => 'measured'),
		)
		const second = await withCommandPerformanceProfile(async () => {})

		expect(first.phases).toHaveLength(1)
		expect(second.phases).toStrictEqual([])
	})
})
