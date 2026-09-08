/**
 * @description Verifies the root package exposes one narrow schema-owned facade.
 *
 * @module work
 * @file Index.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Public-module discovery must occur before assertions. */

import { describe, expect, it } from 'vitest'
import { safeParse } from 'valibot'

describe('root public API', () => {
	it('does not expose low-level workflow sequencing helpers', async () => {
		const publicApi = await import('./index')
		expect(Object.keys(publicApi).toSorted()).toStrictEqual([
			'CanonicalDefinitionRevisionSchema',
			'LoadWorkProjectInputSchema',
			'WORK_ERROR_CODES',
			'WorkErrorSchema',
			'WorkManifestInputSchema',
			'loadWorkProject',
		])
	})

	it('rejects error codes outside the exported exhaustive contract', async () => {
		const { WorkErrorSchema } = await import('./index')
		expect(
			safeParse(WorkErrorSchema, {
				type: 'work_contract_error',
				code: 'arbitrary_provider_message',
				message: 'untyped',
			}).success,
		).toBe(false)
	})
})
