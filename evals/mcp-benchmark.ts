#!/usr/bin/env bun
/**
 * @description Measures non-shipped Work MCP startup and read-route overhead.
 *
 * @module work/evals/mcp-benchmark
 * @file Mcp-benchmark.ts
 */

import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { env as processEnvironment } from 'node:process'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

/* oxlint-disable eslint/no-restricted-imports -- This non-shipped benchmark compares the same subprocess boundary as the CLI. */
import { executeFile } from '../src/subprocess'

const median = (values: readonly number[]): number => {
	const ordered = values.toSorted((left, right) => left - right)
	return ordered[Math.floor(ordered.length / 2)] ?? 0
}

const main = async (): Promise<void> => {
	const repositoryRoot = resolve(import.meta.dirname, '../../..')
	const prototype = resolve(import.meta.dirname, 'mcp-prototype.ts')
	const repetitions = 5

	const startupMs: number[] = []
	const overviewMs: number[] = []
	const cliOverviewMs: number[] = []

	for (let index = 0; index < repetitions; index += 1) {
		const transport = new StdioClientTransport({
			command: 'bun',
			args: [prototype],
			cwd: repositoryRoot,
			env: {
				...Object.fromEntries(
					Object.entries(processEnvironment).filter(
						(entry): entry is [string, string] => entry[1] !== undefined,
					),
				),
				WORK_MCP_ROOT: repositoryRoot,
			},
			stderr: 'pipe',
		})
		const client = new Client({ name: 'work-mcp-evaluation-benchmark', version: '0.0.0' })
		const startedAt = performance.now()
		try {
			await client.connect(transport)
			await client.listTools()
			startupMs.push(performance.now() - startedAt)
			const overviewStartedAt = performance.now()
			await client.callTool({ name: 'work_overview', arguments: {} })
			overviewMs.push(performance.now() - overviewStartedAt)
		} finally {
			await client.close()
		}
		const cliStartedAt = performance.now()
		await executeFile('bun', ['run', '--silent', 'work', 'overview', '--json'], {
			cwd: repositoryRoot,
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		})
		cliOverviewMs.push(performance.now() - cliStartedAt)
	}

	process.stdout.write(
		`${JSON.stringify({
			repetitions,
			startupMs: startupMs.map((value) => Math.round(value)),
			startupMedianMs: Math.round(median(startupMs)),
			overviewMs: overviewMs.map((value) => Math.round(value)),
			overviewMedianMs: Math.round(median(overviewMs)),
			cliOverviewMs: cliOverviewMs.map((value) => Math.round(value)),
			cliOverviewMedianMs: Math.round(median(cliOverviewMs)),
		})}\n`,
	)
}

void main()
