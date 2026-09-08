#!/usr/bin/env bun
/** @description Verifies a manual staging request before any release effects occur. */

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const requested = process.env.RELEASE_VERSION
if (requested === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(requested)) {
	throw new Error('RELEASE_VERSION must be one exact semantic version.')
}
if (process.env.GITHUB_REF_NAME !== undefined && process.env.GITHUB_REF_NAME !== 'main') {
	throw new Error('Releases may be staged only from main.')
}
const packageDocument: unknown = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (
	typeof packageDocument !== 'object' ||
	packageDocument === null ||
	Array.isArray(packageDocument)
) {
	throw new TypeError('package.json must contain one JSON object.')
}
const name = 'name' in packageDocument ? packageDocument.name : undefined
const version = 'version' in packageDocument ? packageDocument.version : undefined
if (typeof name !== 'string' || version !== requested) {
	throw new Error('Requested release version does not match package.json.')
}
const identity = spawnSync('bun', ['run', 'check:identity'], { cwd: root, encoding: 'utf8' })
if (identity.status !== 0) {
	throw new Error(identity.stderr.trim() || 'Release identity validation failed.')
}
const published = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${requested}`)
if (published.ok) {
	throw new Error(`${name}@${requested} is already public.`)
}
if (published.status !== 404) {
	throw new Error(`npm registry version check failed with status ${published.status}.`)
}
process.stdout.write(`${name}@${requested} is eligible for staged verification.\n`)
