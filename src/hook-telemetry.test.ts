/**
 * @description Verifies sanitized persistent telemetry for advisory hook dispatch.
 *
 * @module work/dogfood
 * @file Hook-telemetry.test.ts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { recordHookTelemetry, setCommandTelemetry, showCommandTelemetry } from './dogfood'

describe('hook telemetry', () => {
	it('records only the allowlisted hook envelope', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(resolve(tmpdir(), 'work-hook-telemetry-'))
		try {
			await setCommandTelemetry({ root, enabled: true })
			await expect(
				recordHookTelemetry({
					root,
					event: 'afterEdit',
					entryId: 'check-typescript',
					durationMs: 42,
					outcome: 'skipped',
					outputMode: 'summarize',
					skipReason: 'changed_files',
				}),
			).resolves.toStrictEqual({ ok: true, value: { recorded: true } })
			const shown = await showCommandTelemetry({ root, limit: 1 })
			expect(shown).toMatchObject({
				ok: true,
				value: {
					events: [
						{
							command: 'hooks.dispatch',
							hookEvent: 'afterEdit',
							hookOutcome: 'skipped',
							hookOutputMode: 'summarize',
							hookSkipReason: 'changed_files',
							durationMs: 42,
						},
					],
				},
			})
			const event = shown.ok ? shown.value.events[0] : undefined
			expect(event?.hookEntryCorrelation).toMatch(/^[a-f0-9]{64}$/)
			expect(JSON.stringify(event)).not.toContain('check-typescript')
			expect(JSON.stringify(event)).not.toContain('args')
			expect(JSON.stringify(event)).not.toContain('output')
			expect(JSON.stringify(event)).not.toContain('path')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
