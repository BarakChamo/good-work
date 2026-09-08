/**
 * @description Verifies output-path safety failures never echo untrusted path content.
 *
 * @module work/paths
 * @file Paths.test.ts
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { prepareSafeOutputPath } from './paths'

const PRIVATE_CANARY = 'PRIVATE_PATH_CANARY_Users_operator_secret'
let root: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-paths-'))
})

afterEach(async () => {
	await rm(root, { force: true, recursive: true })
})

describe('safe output paths', () => {
	it('does not echo traversing or non-file target paths', async () => {
		expect.hasAssertions()
		const traversal = await prepareSafeOutputPath({
			root,
			path: `../${PRIVATE_CANARY}`,
			errorCode: 'unsafe_work_manifest',
		})
		await mkdir(join(root, PRIVATE_CANARY))
		const nonFile = await prepareSafeOutputPath({
			root,
			path: PRIVATE_CANARY,
			errorCode: 'unsafe_work_manifest',
		})

		expect(traversal).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsafe_work_manifest' },
		})
		expect(nonFile).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsafe_work_manifest' },
		})
		expect(JSON.stringify([traversal, nonFile])).not.toContain(PRIVATE_CANARY)
	})
})
