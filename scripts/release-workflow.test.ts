/** @description Verifies the event-driven, protected npm release contract. */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('release workflow', () => {
	it('starts automatically from a versioned main commit and has no periodic trigger', async () => {
		const workflow = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8')

		expect(workflow).toContain('push:')
		expect(workflow).toContain('branches: [main]')
		expect(workflow).toContain('- package.json')
		expect(workflow).toContain('workflow_dispatch:')
		expect(workflow).not.toContain('schedule:')
		expect(workflow).not.toContain('inputs:')
	})

	it('uses one protected direct-publish job and completes the GitHub release in the same run', async () => {
		const workflow = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8')
		const runbook = await readFile(resolve(root, 'docs/releasing.md'), 'utf8')

		expect(workflow).toContain('environment: npm-release')
		expect(workflow).toContain('id-token: write')
		expect(workflow).toContain(
			'npm publish "./dist/work-${RELEASE_VERSION}.tgz" --access public --tag latest',
		)
		expect(workflow).toContain('npm audit signatures --json --include-attestations')
		expect(workflow).toContain('gh release edit "v${RELEASE_VERSION}" --draft=false --latest')
		expect(workflow).not.toContain('npm stage')
		expect(runbook).toContain('Merge the Changesets release pull request.')
		expect(runbook).toContain('Approve the protected `npm-release` deployment in GitHub.')
	})

	it('retains only a manual recovery entrypoint instead of a second finalizer workflow', async () => {
		const workflow = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8')

		expect(workflow).toContain("github.event_name == 'workflow_dispatch'")
		await expect(
			readFile(resolve(root, '.github/workflows/finalize-release.yml'), 'utf8'),
		).rejects.toThrow(/ENOENT/u)
	})
})
