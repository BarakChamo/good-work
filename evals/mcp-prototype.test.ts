/**
 * @description Verifies the non-shipped read-only MCP prototype against the repository CLI contract.
 *
 * @module work/evals/mcp-prototype
 * @file Mcp-prototype.test.ts
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { env as processEnvironment } from 'node:process'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { describe, expect, it } from 'vitest'

/* oxlint-disable eslint/no-restricted-imports -- The non-shipped eval compares the CLI subprocess boundary directly. */
import { executeFile } from '../src/subprocess'

const packageRoot = resolve(import.meta.dirname, '..')
const workBinary = resolve(packageRoot, 'bin/work.ts')
const prototype = resolve(import.meta.dirname, 'mcp-prototype.ts')

const parseToolResult = (value: Awaited<ReturnType<Client['callTool']>>): unknown => {
	const text = value.content.find(
		(entry): entry is Extract<(typeof value.content)[number], { readonly type: 'text' }> =>
			entry.type === 'text',
	)?.text
	if (text === undefined) {
		throw new Error('MCP result omitted its JSON text contract.')
	}
	return JSON.parse(text)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null

const recommendedWorkId = (value: unknown): string | undefined => {
	if (!isRecord(value) || !isRecord(value.value)) {
		return undefined
	}
	const recommended = value.value.recommended
	return isRecord(recommended) && typeof recommended.id === 'string' ? recommended.id : undefined
}

describe('work read-only MCP evaluation prototype', () => {
	it('exposes only the four read tools and matches CLI read contracts', async () => {
		expect.hasAssertions()
		const fixtureRoot = await mkdtemp(join(tmpdir(), 'work-mcp-fixture-'))
		const stateRoot = await mkdtemp(join(tmpdir(), 'work-mcp-state-'))
		await cp(resolve(packageRoot, 'examples/basic'), fixtureRoot, { recursive: true })
		for (const [command, args] of [
			['git', ['init', '--initial-branch=main']],
			['git', ['config', 'user.email', 'mcp-eval@example.invalid']],
			['git', ['config', 'user.name', 'Work MCP evaluation']],
			['git', ['add', '.']],
			['git', ['commit', '-m', 'initialize MCP fixture']],
		] as const) {
			await executeFile(command, args, {
				cwd: fixtureRoot,
				timeout: 30_000,
				maxBuffer: 1024 * 1024,
			})
		}
		const environment = {
			...Object.fromEntries(
				Object.entries(processEnvironment).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
			WORK_CONTRACT_STATE_HOME: stateRoot,
		}
		await executeFile('bun', [workBinary, '--root', fixtureRoot, 'sync', '--apply', '--json'], {
			cwd: fixtureRoot,
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
			env: environment,
		})
		const transport = new StdioClientTransport({
			command: 'bun',
			args: [prototype],
			cwd: fixtureRoot,
			env: {
				...environment,
				WORK_MCP_ROOT: fixtureRoot,
			},
			stderr: 'pipe',
		})
		const client = new Client({ name: 'work-mcp-evaluation-test', version: '0.0.0' })
		const startedAt = performance.now()
		try {
			await client.connect(transport)
			const startupMs = performance.now() - startedAt
			expect(startupMs).toBeLessThan(5000)
			const listed = await client.listTools()
			expect(listed.tools.map(({ name }) => name).toSorted()).toStrictEqual([
				'work_active',
				'work_overview',
				'work_prepare',
				'work_show',
			])

			const cli = await executeFile(
				'bun',
				[workBinary, '--root', fixtureRoot, 'overview', '--json'],
				{
					cwd: fixtureRoot,
					timeout: 30_000,
					maxBuffer: 1024 * 1024,
					env: environment,
				},
			)
			const cliEnvelope: unknown = JSON.parse(cli.stdout)
			const mcpOverview = parseToolResult(
				await client.callTool({ name: 'work_overview', arguments: {} }),
			)
			expect(mcpOverview).toStrictEqual(cliEnvelope)

			const workId = recommendedWorkId(mcpOverview)
			expect(workId).toBeTypeOf('string')
			if (workId === undefined) {
				throw new Error('CLI and MCP overview omitted ready work.')
			}
			for (const [name, arguments_, route] of [
				['work_show', { workId }, ['show', workId]],
				['work_prepare', { reference: workId }, ['prepare', workId]],
				['work_active', {}, ['active']],
			] as const) {
				const mcpResult = parseToolResult(await client.callTool({ name, arguments: arguments_ }))
				const cliResult = await executeFile(
					'bun',
					[workBinary, '--root', fixtureRoot, ...route, '--json'],
					{
						cwd: fixtureRoot,
						timeout: 30_000,
						maxBuffer: 1024 * 1024,
						env: environment,
					},
				)
				expect(mcpResult).toStrictEqual(JSON.parse(cliResult.stdout))
			}
		} finally {
			await client.close()
			await Promise.all([
				rm(fixtureRoot, { force: true, recursive: true }),
				rm(stateRoot, { force: true, recursive: true }),
			])
		}
	})
})
