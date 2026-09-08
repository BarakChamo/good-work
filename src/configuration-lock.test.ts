/**
 * @description Verifies configuration-mutation cleanup preserves authoritative primary failures.
 *
 * @module work/configuration-lock
 * @file Configuration-lock.test.ts
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { finalizeConfigurationMutation, removeOwnedConfigurationLock } from './configuration-lock'

describe('configuration mutation cleanup', () => {
	it('does not unlink a replacement generation created after initial validation', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-configuration-release-'))
		const path = join(root, 'lock')
		const original = 'original generation\n'
		const replacement = 'replacement generation\n'
		await writeFile(path, original)
		try {
			await expect(
				removeOwnedConfigurationLock(path, original, async () => {
					await rm(path)
					await writeFile(path, replacement)
				}),
			).resolves.toBe(false)
			await expect(readFile(path, 'utf8')).resolves.toBe(replacement)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('preserves a manifest read failure when replaced-lock cleanup also fails', async () => {
		expect.hasAssertions()
		await expect(
			finalizeConfigurationMutation({
				result: {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'work_manifest_too_large',
						message: 'Existing work manifest exceeds its bound.',
					},
				},
				lock: {
					release: async () => ({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'configuration_lock_release_failed',
							message: 'Configuration mutation lock ownership changed before release.',
							details: ['lock=.work/proposal-apply.lock'],
						},
					}),
				},
			}),
		).resolves.toStrictEqual({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'work_manifest_too_large',
				message: 'Existing work manifest exceeds its bound.',
				details: [
					'lockReleaseCode=configuration_lock_release_failed',
					'lock=.work/proposal-apply.lock',
				],
			},
		})
	})

	it('marks a successful mutation as applied and uncertain when lock release fails', async () => {
		expect.hasAssertions()
		const result = await finalizeConfigurationMutation({
			result: { ok: true as const, value: { applied: true } },
			lock: {
				release: async () => ({
					ok: false as const,
					error: {
						type: 'work_contract_error' as const,
						code: 'configuration_lock_release_failed' as const,
						message: 'Lock remained.',
						details: ['lock=.work/proposal-apply.lock'],
					},
				}),
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'configuration_lock_release_failed' },
		})
		if (!result.ok) {
			expect(result.error.details).toContain('stateApplied=true')
			expect(result.error.details).toContain('stateMayHaveChanged=true')
		}
	})
})
