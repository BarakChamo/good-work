/**
 * @description Verifies proposal validation binds source bytes to repository-contained handles.
 *
 * @module work/proposals
 * @file Proposals-toctou.test.ts
 */

/* oxlint-disable typescript/consistent-type-imports, vitest/prefer-import-in-mock -- Typed built-in interception creates a deterministic directory-swap race. */

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compileWorkGraph } from './compiler'
import type { WorkManifest } from './contracts'
import { validatePlanningProposal } from './proposals'

const race = vi.hoisted(() => ({ armed: false, sourcePath: '', sourceDirectory: '', outside: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		open: async (...arguments_: Parameters<typeof actual.open>) => {
			if (race.armed && arguments_[0] === race.sourcePath) {
				race.armed = false
				await actual.rename(race.sourceDirectory, `${race.sourceDirectory}-original`)
				await actual.symlink(race.outside, race.sourceDirectory)
			}
			return actual.open(...arguments_)
		},
	}
})

const roots: string[] = []
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

const manifest: WorkManifest = {
	schemaVersion: 1,
	projectId: 'example',
	sources: [
		{
			kind: 'issue',
			include: ['docs/issues/*.md'],
			parentFields: ['parent'],
			dependencyFields: ['dependencies'],
		},
	],
	policies: { contextMaxBytes: 12_000, staleClaimMinutes: 90, terminalEvidence: [] },
}

beforeEach(() => {
	race.armed = false
})

afterEach(async () => {
	race.armed = false
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })))
})

describe('proposal source containment', () => {
	it('rejects an intermediate directory replacement before source validation', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-proposal-race-'))
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-proposal-outside-'))
		roots.push(root, outside)
		const sourceDirectory = join(root, 'docs', 'issues')
		const sourcePath = join(sourceDirectory, 'ISSUE-1.md')
		const inside = '# ISSUE-1 Inside\n'
		const outsideSource = '# ISSUE-1 Outside canary\n'
		await mkdir(sourceDirectory, { recursive: true })
		await writeFile(sourcePath, inside)
		await writeFile(join(outside, 'ISSUE-1.md'), outsideSource)
		await writeFile(
			join(root, 'work.yaml'),
			JSON.stringify({
				version: 1,
				project: { id: 'example' },
				sources: manifest.sources,
				policies: manifest.policies,
			}),
		)
		const graph = await compileWorkGraph({ root, manifest })
		if (!graph.ok) {
			throw new Error(graph.error.message)
		}
		Object.assign(race, { armed: true, sourcePath, sourceDirectory, outside })

		const result = await validatePlanningProposal({
			root,
			graph: graph.value,
			manifest,
			manifestPath: 'work.yaml',
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.value.fingerprint,
				changes: [
					{
						type: 'update',
						path: 'docs/issues/ISSUE-1.md',
						expectedHash: digest(outsideSource),
						content: '# ISSUE-1 Updated\n',
					},
				],
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsafe_proposal_path' },
		})
		expect(JSON.stringify(result)).not.toContain('Outside canary')
	})
})
