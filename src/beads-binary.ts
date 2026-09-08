/**
 * @description Resolves the verified native executable installed beside the package Beads launcher.
 *
 * @module work/beads-binary
 * @file Beads-binary.ts
 */

import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { platform as currentPlatform } from 'node:process'

const supportedPlatforms = new Set(['darwin', 'linux', 'win32'])

/**
 * @description Selects a regular executable sibling or preserves the trusted package launcher. Test seam for
 * platform-specific package layouts; not exported by the package.
 *
 * @internal
 */
export const selectPackagedBeadsBinary = (input: {
	readonly launcher: string
	readonly platform: string
}): string => {
	if (!supportedPlatforms.has(input.platform)) {
		return input.launcher
	}
	try {
		const launcher = realpathSync(input.launcher)
		const candidate = join(dirname(launcher), input.platform === 'win32' ? 'bd.exe' : 'bd')
		const metadata = lstatSync(candidate)
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			return input.launcher
		}
		if (input.platform !== 'win32') {
			accessSync(candidate, constants.X_OK)
		}
		return realpathSync(candidate)
	} catch {
		return input.launcher
	}
}

/** @description Resolves native packaged Beads, then its launcher, then the documented PATH fallback. */
export const resolveDefaultBeadsBinary = (): string => {
	try {
		const launcher = createRequire(import.meta.url).resolve('@beads/bd/bin/bd.js')
		return selectPackagedBeadsBinary({ launcher, platform: currentPlatform })
	} catch {
		return 'bd'
	}
}
