/**
 * @description Verifies generated plugin, marketplace, skill, and runtime identity assets.
 *
 * @module work/release-assets-test
 * @file Release-assets.test.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { synchronizeReleaseAssets } from './release-assets'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const writeJson = async (path: string, value: unknown): Promise<void> => {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe('release asset synchronization', () => {
	it('binds generated assets to the package version and canonical skill', async () => {
		const root = await mkdtemp(join(tmpdir(), 'work-release-assets-'))
		roots.push(root)
		await Promise.all([
			mkdir(join(root, 'skills/work/references'), { recursive: true }),
			mkdir(join(root, 'plugins/work/.codex-plugin'), { recursive: true }),
			mkdir(join(root, 'plugins/work/.claude-plugin'), { recursive: true }),
			mkdir(join(root, 'plugins/work/skills/work/references'), { recursive: true }),
			mkdir(join(root, '.agents/plugins'), { recursive: true }),
			mkdir(join(root, '.claude-plugin'), { recursive: true }),
			mkdir(join(root, 'examples/basic'), { recursive: true }),
			mkdir(join(root, 'src'), { recursive: true }),
			mkdir(join(root, 'schemas'), { recursive: true }),
		])
		await writeJson(join(root, 'package.json'), {
			name: '@npm-acme/work',
			version: '1.2.3',
			repository: {
				type: 'git',
				url: 'git+https://github.com/BarakChamo/good-work.git',
			},
		})
		await writeFile(join(root, 'skills/work/SKILL.md'), 'canonical skill\n')
		await writeFile(join(root, 'skills/work/references/commands.md'), 'canonical commands\n')
		for (const path of [
			'plugins/work/.codex-plugin/plugin.json',
			'plugins/work/.claude-plugin/plugin.json',
		]) {
			await writeJson(join(root, path), {
				name: 'work',
				version: '0.0.0',
				interface: { developerName: 'Old owner' },
			})
		}
		await writeJson(join(root, '.agents/plugins/marketplace.json'), {
			name: 'work',
			plugins: [{ name: 'work', source: { source: 'local', path: './plugins/work' } }],
		})
		await writeJson(join(root, '.claude-plugin/marketplace.json'), {
			name: 'work',
			owner: { name: 'Work contributors' },
			plugins: [{ name: 'work', source: './plugins/work', version: '0.0.0' }],
		})
		await writeJson(join(root, 'examples/basic/work.json'), {
			$schema: 'https://invalid.example/schema.json',
			version: 1,
			hooks: {},
		})
		await writeJson(join(root, 'schemas/work.schema.json'), {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
		})

		const result = await synchronizeReleaseAssets({ root, check: false })

		expect(result.changedPaths).toContain('src/release-identity.ts')
		await expect(readFile(join(root, 'plugins/work/skills/work/SKILL.md'), 'utf8')).resolves.toBe(
			'canonical skill\n',
		)
		for (const path of [
			'plugins/work/.codex-plugin/plugin.json',
			'plugins/work/.claude-plugin/plugin.json',
		]) {
			expect(JSON.parse(await readFile(join(root, path), 'utf8'))).toMatchObject({
				name: 'work',
				version: '1.2.3',
				author: { name: 'Work contributors' },
				interface: { developerName: 'Work contributors' },
			})
		}
		expect(
			JSON.parse(await readFile(join(root, '.claude-plugin/marketplace.json'), 'utf8')),
		).toMatchObject({ version: '1.2.3', plugins: [{ name: 'work', version: '1.2.3' }] })
		expect(await readFile(join(root, 'src/release-identity.ts'), 'utf8')).toContain(
			"export const WORK_REPOSITORY = 'BarakChamo/good-work'",
		)
		expect(
			JSON.parse(await readFile(join(root, 'examples/basic/work.json'), 'utf8')),
		).toMatchObject({
			$schema:
				'https://raw.githubusercontent.com/BarakChamo/good-work/v1.2.3/schemas/work.schema.json',
			version: 1,
		})
		expect(
			JSON.parse(await readFile(join(root, 'schemas/work.schema.json'), 'utf8')),
		).toMatchObject({
			$id: 'https://raw.githubusercontent.com/BarakChamo/good-work/v1.2.3/schemas/work.schema.json',
		})
		await expect(synchronizeReleaseAssets({ root, check: true })).resolves.toEqual({
			changedPaths: [],
		})
	})

	it('reports drift without modifying generated files in check mode', async () => {
		const root = await mkdtemp(join(tmpdir(), 'work-release-assets-check-'))
		roots.push(root)
		await Promise.all([
			mkdir(join(root, 'skills/work/references'), { recursive: true }),
			mkdir(join(root, 'plugins/work/.codex-plugin'), { recursive: true }),
			mkdir(join(root, 'plugins/work/.claude-plugin'), { recursive: true }),
			mkdir(join(root, '.claude-plugin'), { recursive: true }),
			mkdir(join(root, 'examples/basic'), { recursive: true }),
			mkdir(join(root, 'schemas'), { recursive: true }),
		])
		await writeJson(join(root, 'package.json'), {
			name: '@acme/work',
			version: '1.0.0',
			repository: { type: 'git', url: 'git+https://github.com/acme/work.git' },
		})
		await writeFile(join(root, 'skills/work/SKILL.md'), 'canonical skill\n')
		await writeFile(join(root, 'skills/work/references/commands.md'), 'canonical commands\n')
		await writeJson(join(root, 'plugins/work/.codex-plugin/plugin.json'), {
			name: 'work',
			version: '0.0.0',
		})
		await writeJson(join(root, 'plugins/work/.claude-plugin/plugin.json'), {
			name: 'work',
			version: '0.0.0',
		})
		await writeJson(join(root, '.claude-plugin/marketplace.json'), {
			name: 'work',
			plugins: [{ name: 'work', source: './plugins/work', version: '0.0.0' }],
		})
		await writeJson(join(root, 'examples/basic/work.json'), {
			$schema: 'https://invalid.example/schema.json',
			version: 1,
			hooks: {},
		})
		await writeJson(join(root, 'schemas/work.schema.json'), {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
		})

		await expect(synchronizeReleaseAssets({ root, check: true })).rejects.toThrow(
			'Release assets are not synchronized',
		)
		await expect(readFile(join(root, 'src/release-identity.ts'), 'utf8')).rejects.toThrow('ENOENT')
	})
})
