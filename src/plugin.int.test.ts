/**
 * @description Verifies the Work plugin bridge at its native process boundary.
 *
 * @module work/plugin
 * @file Plugin.int.test.ts
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const pluginRoot = resolve(import.meta.dirname, '../plugins/work')

describe('work plugin process bridge', () => {
	it('stays non-blocking without executing repository scripts when the CLI is unavailable', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(resolve(tmpdir(), 'work-plugin-missing-cli-'))
		try {
			await writeFile(
				resolve(root, 'package.json'),
				JSON.stringify({ scripts: { work: 'touch repository-script-ran' } }),
			)
			const result = spawnSync(resolve(pluginRoot, 'bin/work-hook'), [], {
				cwd: root,
				encoding: 'utf8',
				env: { PATH: '/nonexistent' },
				input: '{}',
			})
			expect(result.status).toBe(0)
			expect(result.stderr).toContain('work CLI is unavailable')
			expect(result.stderr).not.toContain('bun')
			await expect(readFile(resolve(root, 'repository-script-ran'), 'utf8')).rejects.toThrow(
				'ENOENT',
			)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})
})
