#!/usr/bin/env bun
/** @description Creates the exact npm tarball, checksum, and CycloneDX release evidence. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = process.env.RELEASE_VERSION
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
	throw new Error('RELEASE_VERSION must be one exact semantic version.')
}
const packageDocument: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (
	typeof packageDocument !== 'object' ||
	packageDocument === null ||
	Array.isArray(packageDocument) ||
	!('name' in packageDocument) ||
	typeof packageDocument.name !== 'string' ||
	!('version' in packageDocument) ||
	packageDocument.version !== version
) {
	throw new Error('Release package identity does not match RELEASE_VERSION.')
}
const output = join(root, 'dist')
await rm(output, { force: true, recursive: true })
await mkdir(output, { recursive: true })
const packed = spawnSync('bun', ['pm', 'pack', '--destination', output, '--quiet'], {
	cwd: root,
	encoding: 'utf8',
})
if (packed.status !== 0) {
	throw new Error(packed.stderr.trim() || 'Could not pack the release archive.')
}
const generatedName = `${packageDocument.name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
const destination = join(output, `work-${version}.tgz`)
await rename(join(output, generatedName), destination)
const digest = createHash('sha256')
	.update(await readFile(destination))
	.digest('hex')
await writeFile(`${destination}.sha256`, `${digest}  ${basename(destination)}\n`)
const sbom = spawnSync(
	'node',
	[
		resolve(root, 'node_modules/@cyclonedx/cyclonedx-npm/bin/cyclonedx-npm-cli.js'),
		'--ignore-npm-errors',
		'--omit',
		'dev',
		'--output-file',
		join(output, `work-${version}.cdx.json`),
		join(root, 'package.json'),
	],
	{
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, npm_execpath: undefined, npm_node_execpath: undefined },
	},
)
if (sbom.status !== 0) {
	throw new Error(sbom.stderr.trim() || 'Could not generate the CycloneDX SBOM.')
}
process.stdout.write(`Created ${basename(destination)}, checksum, and CycloneDX SBOM.\n`)
