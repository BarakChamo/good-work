/**
 * @description Verifies compiler source reads remain bound to the repository after path resolution.
 *
 * @module work/compiler
 * @file Compiler-toctou.test.ts
 */

/* oxlint-disable typescript/consistent-type-imports, vitest/prefer-import-in-mock -- Typed built-in interception creates a deterministic directory-swap race. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compileWorkGraph } from './compiler'
import type { WorkManifest } from './contracts'

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

describe('compiler source containment', () => {
	it('rejects an intermediate directory replacement between resolution and open', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-compiler-race-'))
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-compiler-outside-'))
		roots.push(root, outside)
		const sourceDirectory = join(root, 'docs', 'issues')
		const sourcePath = join(sourceDirectory, 'ISSUE-1.md')
		await mkdir(sourceDirectory, { recursive: true })
		await writeFile(sourcePath, '# ISSUE-1 Inside\n')
		await writeFile(join(outside, 'ISSUE-1.md'), '# ISSUE-1 Outside canary\n')
		Object.assign(race, { armed: true, sourcePath, sourceDirectory, outside })

		const result = await compileWorkGraph({ root, manifest })

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsafe_source_path' },
		})
		expect(JSON.stringify(result)).not.toContain('Outside canary')
	})
})
