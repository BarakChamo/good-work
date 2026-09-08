/**
 * @description Verifies the dependency-free dual-runtime Work plugin artifact and generated skill parity.
 *
 * @module work/plugin
 * @file Plugin.test.ts
 */

import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const pluginRoot = resolve(import.meta.dirname, '../plugins/work')
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null

describe('work plugin artifact', () => {
	it('contains valid lockstep Codex and Claude manifests with contained paths', async () => {
		expect.hasAssertions()
		const packageDocument: unknown = JSON.parse(
			await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
		)
		const packageVersion =
			typeof packageDocument === 'object' &&
			packageDocument !== null &&
			'version' in packageDocument
				? packageDocument.version
				: undefined
		for (const path of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
			const manifest: unknown = JSON.parse(await readFile(resolve(pluginRoot, path), 'utf8'))
			expect(manifest).toMatchObject({
				name: 'work',
				version: packageVersion,
				skills: './skills/',
			})
			expect(JSON.stringify(manifest)).not.toContain('../')
		}
	})

	it('uses the canonical skill verbatim and has an executable dependency-free bridge', async () => {
		expect.hasAssertions()
		for (const path of ['SKILL.md', 'references/commands.md']) {
			await expect(readFile(resolve(pluginRoot, 'skills/work', path), 'utf8')).resolves.toBe(
				await readFile(resolve(import.meta.dirname, '../skills/work', path), 'utf8'),
			)
		}
		const bridge = resolve(pluginRoot, 'bin/work-hook')
		await expect(access(bridge)).resolves.toBeUndefined()
		await expect(access(bridge, constants.X_OK)).resolves.toBeUndefined()
		const source = await readFile(bridge, 'utf8')
		expect(source).toContain('work hooks dispatch')
		expect(source).not.toContain('bun run')
		expect(source).not.toContain('npm install')
		expect(source).not.toContain('bun install')
		await expect(access(resolve(pluginRoot, 'package.json'))).rejects.toThrow('ENOENT')
	})

	it('registers only portable native hook events through the immutable bridge', async () => {
		expect.hasAssertions()
		const source = await readFile(resolve(pluginRoot, 'hooks/hooks.json'), 'utf8')
		const hooks: unknown = JSON.parse(source)
		if (!isRecord(hooks) || !isRecord(hooks.hooks)) {
			throw new Error('Invalid hook manifest.')
		}
		for (const event of ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd']) {
			expect(Array.isArray(hooks.hooks[event])).toBe(true)
		}
		expect(JSON.stringify(hooks.hooks.SessionEnd)).toContain('"timeout":3')
		expect(source).toContain('CLAUDE_PLUGIN_ROOT')
		expect(source).toContain('/bin/work-hook')
	})
})
