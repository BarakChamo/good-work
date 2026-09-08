/**
 * @description Verifies safe selection of the package-installed native Beads executable.
 *
 * @module work/beads-binary
 * @file Beads-binary.test.ts
 */

import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { selectPackagedBeadsBinary } from './beads-binary'

let root: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-beads-binary-'))
	await mkdir(join(root, 'bin'))
	await writeFile(join(root, 'bin', 'bd.js'), '#!/usr/bin/env node\n')
})

afterEach(async () => {
	await rm(root, { force: true, recursive: true })
})

describe('packaged Beads binary selection', () => {
	it.each([
		['darwin', 'bd'],
		['linux', 'bd'],
		['win32', 'bd.exe'],
	] as const)(
		'selects the regular platform-native executable on %s',
		async (platformName, name) => {
			expect.assertions(1)
			const launcher = join(root, 'bin', 'bd.js')
			const native = join(root, 'bin', name)
			await writeFile(native, 'native')
			await chmod(native, 0o755)

			const canonicalNative = await realpath(native)
			expect(selectPackagedBeadsBinary({ launcher, platform: platformName })).toBe(canonicalNative)
		},
	)

	it('falls back to the launcher for missing, non-executable, and symlinked artifacts', async () => {
		expect.assertions(3)
		const launcher = join(root, 'bin', 'bd.js')
		expect(selectPackagedBeadsBinary({ launcher, platform: 'darwin' })).toBe(launcher)

		const native = join(root, 'bin', 'bd')
		await writeFile(native, 'not executable')
		await chmod(native, 0o644)
		expect(selectPackagedBeadsBinary({ launcher, platform: 'darwin' })).toBe(launcher)

		await rm(native)
		const outside = join(root, 'outside-bd')
		await writeFile(outside, 'native')
		await chmod(outside, 0o755)
		await symlink(outside, native)
		expect(selectPackagedBeadsBinary({ launcher, platform: 'darwin' })).toBe(launcher)
	})

	it('falls back to the launcher on unsupported platforms', async () => {
		expect.assertions(1)
		const launcher = join(root, 'bin', 'bd.js')
		const native = join(root, 'bin', 'bd')
		await writeFile(native, 'native')
		await chmod(native, 0o755)

		expect(selectPackagedBeadsBinary({ launcher, platform: 'aix' })).toBe(launcher)
	})
})
