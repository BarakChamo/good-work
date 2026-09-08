/**
 * @description Verifies that documented and automated npm release commands use file paths.
 *
 * @module work/release-workflow-test
 * @file Release-workflow.test.ts
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('release command paths', () => {
	it('passes generated archives to npm and checksum tools as local files', async () => {
		const [workflow, runbook] = await Promise.all([
			readFile(resolve(root, '.github/workflows/stage-release.yml'), 'utf8'),
			readFile(resolve(root, 'docs/releasing.md'), 'utf8'),
		])

		expect(workflow).toContain(
			'npm stage publish "./dist/work-${RELEASE_VERSION}.tgz" --access public --tag latest',
		)
		expect(runbook).toContain('(cd dist && shasum -a 256 -c work-0.0.0.tgz.sha256)')
		expect(runbook).toContain('npm publish ./dist/work-0.0.0.tgz --access public --tag bootstrap')
	})
})
