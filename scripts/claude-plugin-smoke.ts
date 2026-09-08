#!/usr/bin/env bun
/** @description Runs Claude's strict validator over both marketplace and plugin roots. */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
for (const path of [root, resolve(root, 'plugins/work')]) {
	const result = spawnSync('claude', ['plugin', 'validate', path, '--strict'], {
		cwd: root,
		encoding: 'utf8',
	})
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || 'Claude validation failed.')
	}
}
process.stdout.write('Claude strict validation passed for the marketplace and Work plugin.\n')
