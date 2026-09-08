/**
 * @description Verifies oversized provider metadata uses a private file and cleanup failures stay typed.
 *
 * @module work/beads-metadata-transport
 * @file Beads-metadata-transport.test.ts
 */

/* oxlint-disable typescript/consistent-type-imports, typescript/no-unsafe-assignment, vitest/prefer-import-in-mock -- Typed built-in interception injects synchronous temporary-file cleanup failures; Vitest matchers are intentionally nested in structural expectations. */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBeadsProvider } from './beads'
import type { LedgerDefinitionExpectation, LedgerHandoffInput } from './provider'

const cleanupFault = vi.hoisted(() => ({ enabled: false }))

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		rmSync: (...arguments_: Parameters<typeof actual.rmSync>): void => {
			const target = String(arguments_[0])
			actual.rmSync(...arguments_)
			if (cleanupFault.enabled && target.includes('work-contract-metadata-')) {
				throw new Error('PRIVATE_METADATA_CLEANUP_/Users/operator/secret')
			}
		},
	}
})

let root: string

const expectedDefinition: LedgerDefinitionExpectation = {
	schemaVersion: 2,
	title: 'Issue',
	kind: 'issue',
	source: { path: 'docs/ISSUE-1.md', hash: 'a'.repeat(64) },
	parentId: undefined,
	dependencies: [],
	roles: ['implementer'],
	evidenceRequirements: [],
}

const activeRecord = {
	id: 'wc-1',
	title: 'Issue',
	status: 'in_progress',
	priority: 2,
	issue_type: 'task',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
	assignee: 'agent-a',
	metadata: {
		work_contract_project_key: createHash('sha256').update('example').digest('hex'),
		work_contract: {
			schema_version: 2,
			project_id: 'example',
			work_id: 'ISSUE-1',
			kind: 'issue',
			source_path: 'docs/ISSUE-1.md',
			source_hash: 'a'.repeat(64),
			graph_fingerprint: 'b'.repeat(64),
			roles: ['implementer'],
			evidence_requirements: [],
			activity: {
				actor: 'agent-a',
				started_at: '2026-09-01T00:00:00.000Z',
				touched_at: '2026-09-01T00:00:00.000Z',
			},
		},
	},
}

const writeFakeBinary = async (failUpdate: boolean): Promise<string> => {
	const binary = join(root, `fake-bd-${String(failUpdate)}.mjs`)
	await writeFile(
		binary,
		`#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args[0]
if (command === 'list') console.log(${JSON.stringify(JSON.stringify([activeRecord]))})
else if (command === 'comment') { readFileSync(0); console.log('{}') }
else if (command === 'update') {
  const raw = args[args.indexOf('--metadata') + 1]
  writeFileSync(${JSON.stringify(join(root, 'transport.txt'))}, raw.startsWith('@') ? 'file' : 'inline')
  if (${String(failUpdate)}) process.exit(9)
  const metadata = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw)
  console.log(JSON.stringify({ ...${JSON.stringify(activeRecord)}, metadata }))
} else process.exit(9)
`,
	)
	await chmod(binary, 0o755)
	return binary
}

const handoffInput = (): LedgerHandoffInput => {
	const escapeHeavy = String.raw`\"`.repeat(30)
	return {
		workId: 'ISSUE-1',
		actor: 'agent-a',
		handoff: {
			actor: 'agent-a',
			summary: 'Large transport boundary.',
			remaining: Array.from({ length: 10 }, () => escapeHeavy),
			references: Array.from({ length: 10 }, () => escapeHeavy),
			createdAt: '2026-09-01T01:00:00.000Z',
		},
		release: false,
		expectedDefinition,
		expectedDefinitionClosure: [{ workId: 'ISSUE-1', ...expectedDefinition }],
	}
}

beforeEach(async () => {
	cleanupFault.enabled = false
	root = await mkdtemp(join(tmpdir(), 'work-contract-metadata-test-'))
})

afterEach(async () => {
	cleanupFault.enabled = false
	await rm(root, { force: true, recursive: true })
})

describe('provider metadata file transport', () => {
	it('reports uncertain state when a successful mutation cannot clean its metadata file', async () => {
		expect.hasAssertions()
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary: await writeFakeBinary(false),
		})
		cleanupFault.enabled = true

		const result = await provider.recordHandoff(handoffInput())

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_mutation_failed',
				details: expect.arrayContaining([
					'stateMayHaveChanged=true',
					'cleanupFailure=temporary_metadata_cleanup_failed',
				]),
			},
		})
		await expect(
			import('node:fs/promises').then(async ({ readFile }) =>
				readFile(join(root, 'transport.txt'), 'utf8'),
			),
		).resolves.toBe('file')
		expect(JSON.stringify(result)).not.toContain('PRIVATE_METADATA_CLEANUP')
	})

	it('preserves mutation uncertainty when command and metadata cleanup both fail', async () => {
		expect.hasAssertions()
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary: await writeFakeBinary(true),
		})
		cleanupFault.enabled = true

		const result = await provider.recordHandoff(handoffInput())

		expect(result).toMatchObject({ ok: false, error: { code: 'provider_mutation_failed' } })
		if (!result.ok) {
			expect(result.error.details).toContain('stateMayHaveChanged=true')
			expect(result.error.details).toContain('cleanupFailure=temporary_metadata_cleanup_failed')
		}
		await expect(
			import('node:fs/promises').then(async ({ readFile }) =>
				readFile(join(root, 'transport.txt'), 'utf8'),
			),
		).resolves.toBe('file')
		expect(JSON.stringify(result)).not.toContain('PRIVATE_METADATA_CLEANUP')
	})
})
