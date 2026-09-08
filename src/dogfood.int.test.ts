/**
 * @description Proves telemetry lock recovery across independent local Bun processes.
 *
 * @module work/dogfood
 * @file Dogfood.int.test.ts
 */

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { expect, test } from 'vitest'

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const parseJsonRecord = (source: string): Readonly<Record<string, unknown>> => {
	const parsed: unknown = JSON.parse(source)
	if (!isRecord(parsed)) {
		throw new TypeError('Expected a JSON object.')
	}
	return parsed
}

test('serializes concurrent recovery of one schema-valid dead telemetry lock', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-dead-lock-race-'))
	const invoke = async (message: string) =>
		new Promise<{
			readonly status: number | null
			readonly stdout: string
			readonly stderr: string
		}>((resolveResult, reject) => {
			const child = spawn(
				'bun',
				[
					resolve(import.meta.dirname, '../bin/work.ts'),
					'--root',
					root,
					'--json',
					'feedback',
					'--kind',
					'friction',
					'--message',
					message,
				],
				{ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
			)
			let stdout = ''
			let stderr = ''
			child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
				stdout += chunk
			})
			child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
				stderr += chunk
			})
			child.on('error', reject)
			child.on('close', (status) => {
				resolveResult({ status, stdout, stderr })
			})
		})
	try {
		await mkdir(resolve(root, '.work/telemetry/write.lock'), { recursive: true })
		await writeFile(
			resolve(root, '.work/telemetry/config.json'),
			`${JSON.stringify({
				schemaVersion: 1,
				enabled: true,
				correlationSalt: '2'.repeat(64),
			})}\n`,
		)
		await writeFile(
			resolve(root, '.work/telemetry/write.lock/owner.json'),
			`${JSON.stringify({
				pid: 2_147_483_647,
				startedAt: '2026-09-02T00:00:00.000Z',
				nonce: '00000000-0000-4000-8000-000000000005',
			})}\n`,
		)

		const results = await Promise.all([invoke('first recovery'), invoke('second recovery')])
		expect(
			results.every(({ status }) => status === 0),
			JSON.stringify(results),
		).toBe(true)
		expect(results.map(({ stderr }) => stderr)).toStrictEqual(['', ''])
		expect(results.map(({ stdout }) => parseJsonRecord(stdout))).toMatchObject([
			{ ok: true },
			{ ok: true },
		])
		const eventSource = await readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8')
		const events = eventSource
			.trim()
			.split('\n')
			.map((line) => parseJsonRecord(line))
		expect(events.filter(({ command }) => command === 'feedback')).toHaveLength(2)
		await expect(access(resolve(root, '.work/telemetry/write.lock'))).rejects.toThrow('ENOENT')
	} finally {
		await rm(root, { force: true, recursive: true })
	}
})
