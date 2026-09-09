/** @description Verifies npm registry states accepted by release preparation. */

import { describe, expect, it } from 'vitest'

import { classifyRegistryStatus } from './inspect-release'

describe('release registry state', () => {
	it('publishes only an absent version', () => {
		expect(classifyRegistryStatus(404)).toEqual({ published: false })
	})

	it('allows recovery for an already-public version', () => {
		expect(classifyRegistryStatus(200)).toEqual({ published: true })
	})

	it('fails closed for an ambiguous registry response', () => {
		expect(() => classifyRegistryStatus(503)).toThrow(/status 503/u)
	})
})
