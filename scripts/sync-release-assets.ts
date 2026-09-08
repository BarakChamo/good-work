#!/usr/bin/env bun
/**
 * @description CLI entrypoint for deterministic release-asset generation and drift checks.
 *
 * @module work/sync-release-assets
 * @file Sync-release-assets.ts
 */

import { resolve } from 'node:path'

import { synchronizeReleaseAssets } from './release-assets'

const main = async (): Promise<void> => {
	const check = process.argv.slice(2).includes('--check')
	const result = await synchronizeReleaseAssets({
		root: resolve(import.meta.dirname, '..'),
		check,
	})
	process.stdout.write(
		result.changedPaths.length === 0
			? 'Release assets are synchronized.\n'
			: `Synchronized ${result.changedPaths.join(', ')}.\n`,
	)
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : 'Release asset sync failed.'}\n`)
	process.exitCode = 1
})
