#!/usr/bin/env bun
/**
 * @description Non-shipped stdio prototype for comparing read-only Work MCP tools with the CLI.
 *
 * @module work/evals/mcp-prototype
 * @file Mcp-prototype.ts
 */

import { resolve } from 'node:path'
import { env as processEnvironment } from 'node:process'

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

import { createMcpReadService } from './mcp-read-service'

const root = resolve(processEnvironment.WORK_MCP_ROOT ?? process.cwd())
const service = createMcpReadService({
	root,
	...(processEnvironment.WORK_MCP_MANIFEST === undefined
		? {}
		: { manifestPath: processEnvironment.WORK_MCP_MANIFEST }),
	...(processEnvironment.WORK_MCP_BD === undefined
		? {}
		: { binary: processEnvironment.WORK_MCP_BD }),
})

const result = (value: unknown) => ({
	content: [{ type: 'text' as const, text: JSON.stringify(value) }],
	structuredContent: { result: value },
})

serveStdio(() => {
	const server = new McpServer(
		{ name: 'work-read-evaluation', version: '0.0.0' },
		{ capabilities: { tools: {} } },
	)
	server.registerTool(
		'work_overview',
		{
			description: 'Show synchronized ready and active repository work.',
			inputSchema: z.object({}),
		},
		async () => result(await service.overview()),
	)
	server.registerTool(
		'work_show',
		{
			description: 'Show one synchronized work definition and operation.',
			inputSchema: z.object({ workId: z.string().min(1).max(128) }),
		},
		async ({ workId }) => result(await service.show(workId)),
	)
	server.registerTool(
		'work_prepare',
		{
			description: 'Prepare one work item read-only without claiming it.',
			inputSchema: z.object({ reference: z.string().min(1).max(500) }),
		},
		async ({ reference }) => result(await service.prepare(reference)),
	)
	server.registerTool(
		'work_active',
		{ description: 'List currently active or blocked repository work.', inputSchema: z.object({}) },
		async () => result(await service.active()),
	)
	return server
})
