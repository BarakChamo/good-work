/**
 * @description Verifies the one-time owner identity configuration boundary.
 *
 * @module work/configure-identity-test
 * @file Configure-identity.test.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { configureProjectIdentity } from './configure-identity'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('project identity configuration', () => {
	it('replaces the guarded placeholder once and enables publication metadata', async () => {
		const root = await mkdtemp(join(tmpdir(), 'work-configure-identity-'))
		roots.push(root)
		await Promise.all([
			mkdir(join(root, '.changeset'), { recursive: true }),
			mkdir(join(root, '.github'), { recursive: true }),
			mkdir(join(root, 'plugins/work'), { recursive: true }),
		])
		await writeFile(
			join(root, 'package.json'),
			`${JSON.stringify(
				{
					name: '@replace-with-org/work',
					private: true,
					repository: {
						type: 'git',
						url: 'git+https://github.com/BarakChamo/good-work.git',
					},
					bugs: { url: 'https://github.com/BarakChamo/good-work/issues' },
					homepage: 'https://github.com/BarakChamo/good-work#readme',
				},
				null,
				2,
			)}\n`,
		)
		await writeFile(
			join(root, '.changeset/config.json'),
			`${JSON.stringify({ changelog: ['@changesets/changelog-github', { repo: 'BarakChamo/good-work' }] }, null, 2)}\n`,
		)
		await writeFile(
			join(root, '.changeset/initial.md'),
			'---\n"@replace-with-org/work": minor\n---\n',
		)
		await writeFile(join(root, 'README.md'), '@your-org/work\n')
		await writeFile(join(root, 'plugins/work/README.md'), '@your-org/work\n')
		await writeFile(join(root, '.github/CODEOWNERS'), '* @BarakChamo\n')
		await writeFile(
			join(root, 'bun.lock'),
			'{\n  "workspaces": { "": { "name": "@replace-with-org/work" } }\n}\n',
		)

		await configureProjectIdentity({ root, organization: 'acme-tools' })

		const packageDocument = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
		expect(packageDocument).toMatchObject({
			name: '@acme-tools/work',
			private: false,
			repository: { url: 'git+https://github.com/BarakChamo/good-work.git' },
		})
		await expect(readFile(join(root, '.changeset/initial.md'), 'utf8')).resolves.toContain(
			'"@acme-tools/work": minor',
		)
		await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toBe('@acme-tools/work\n')
		await expect(readFile(join(root, 'bun.lock'), 'utf8')).resolves.toContain(
			'"name": "@acme-tools/work"',
		)
		await expect(readFile(join(root, '.github/CODEOWNERS'), 'utf8')).resolves.toBe(
			'* @BarakChamo\n',
		)
		expect(JSON.parse(await readFile(join(root, '.changeset/config.json'), 'utf8'))).toMatchObject({
			changelog: ['@changesets/changelog-github', { repo: 'BarakChamo/good-work' }],
		})
	})

	it('rejects invalid slugs and a second organization identity', async () => {
		const root = await mkdtemp(join(tmpdir(), 'work-configure-identity-reject-'))
		roots.push(root)
		await mkdir(join(root, '.changeset'), { recursive: true })
		await writeFile(join(root, 'package.json'), '{"name":"@acme/work","private":false}\n')
		await writeFile(join(root, '.changeset/config.json'), '{}\n')

		await expect(configureProjectIdentity({ root, organization: '../unsafe' })).rejects.toThrow(
			'valid npm organization slug',
		)
		await expect(configureProjectIdentity({ root, organization: 'other' })).rejects.toThrow(
			'already configured',
		)
	})
})
