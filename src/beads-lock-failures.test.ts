/**
 * @description Verifies multi-item provider lock failures preserve their primary recovery context.
 *
 * @module work/beads-lock-failures
 * @file Beads-lock-failures.test.ts
 */

/* oxlint-disable typescript/consistent-type-imports, vitest/prefer-import-in-mock -- Typed built-in-module interception injects lock acquisition and cleanup failures. */

import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBeadsProvider } from './beads'

const faults = vi.hoisted(() => ({ enabled: false, lockOpenCount: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		open: async (...arguments_: Parameters<typeof actual.open>) => {
			if (
				faults.enabled &&
				typeof arguments_[0] === 'string' &&
				arguments_[0].includes('/.work/beads-') &&
				arguments_[1] === 'wx'
			) {
				faults.lockOpenCount += 1
				if (faults.lockOpenCount === 2) {
					throw Object.assign(new Error('injected second lock acquisition failure'), {
						code: 'EACCES',
					})
				}
			}
			return actual.open(...arguments_)
		},
		rm: async (...arguments_: Parameters<typeof actual.rm>): Promise<void> => {
			if (
				faults.enabled &&
				typeof arguments_[0] === 'string' &&
				arguments_[0].includes('/.work/beads-')
			) {
				throw new Error('injected acquired-lock cleanup failure')
			}
			await actual.rm(...arguments_)
		},
	}
})

let root: string

beforeEach(async () => {
	faults.enabled = false
	faults.lockOpenCount = 0
	root = await mkdtemp(join(tmpdir(), 'work-contract-beads-lock-failure-'))
	await mkdir(join(root, '.work'), { recursive: true })
})

afterEach(async () => {
	faults.enabled = false
	await rm(root, { force: true, recursive: true })
})

describe('provider multi-item lock cleanup', () => {
	it('surfaces an orphaned item lock through reads and doctor', async () => {
		expect.hasAssertions()
		const projectKey = createHash('sha256').update('example').digest('hex')
		const workKey = createHash('sha256').update('ISSUE-1').digest('hex')
		await writeFile(
			join(root, '.work', `beads-${projectKey.slice(0, 12)}-${workKey.slice(0, 12)}.lock`),
			`${JSON.stringify({
				pid: 99_999_999,
				startedAt: '2026-09-01T00:00:00.000Z',
				nonce: '00000000-0000-4000-8000-000000000000',
			})}\n`,
		)
		const binary = join(root, 'fake-bd.mjs')
		await writeFile(
			binary,
			`#!/usr/bin/env node
if (process.argv[2] === 'list') console.log('[]')
else if (process.argv[2] === 'version') console.log('bd version 1.2.2')
else process.exit(9)
`,
		)
		await chmod(binary, 0o755)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		await expect(provider.list()).resolves.toMatchObject({ ok: true, value: [] })
		for (const result of [await provider.inspectCoordinationHealth?.(), await provider.doctor()]) {
			expect(result).toMatchObject({
				ok: false,
				error: {
					code: 'provider_busy',
					details: [
						'lockState=stale',
						'automaticRecovery=false',
						'recovery=confirm no provider mutation is active, then remove the stale lock',
					],
				},
			})
		}
	})

	it('marks a successful provider mutation as applied when its item lock cannot release', async () => {
		expect.hasAssertions()
		const record = {
			id: 'wc-1',
			title: 'Issue',
			status: 'open',
			priority: 2,
			issue_type: 'issue',
			created_at: '2026-09-01T00:00:00.000Z',
			updated_at: '2026-09-01T00:00:00.000Z',
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
					roles: [],
					evidence_requirements: [],
				},
			},
		}
		const archived = {
			...record,
			status: 'closed',
			metadata: {
				...record.metadata,
				work_contract: { ...record.metadata.work_contract, archived: true },
			},
		}
		const marked = { ...archived, status: 'open' }
		const binary = join(root, 'fake-bd.mjs')
		await writeFile(
			binary,
			`#!/usr/bin/env node
const command = process.argv[2]
if (command === 'list') console.log(${JSON.stringify(JSON.stringify([record]))})
else if (command === 'update') console.log(${JSON.stringify(JSON.stringify(marked))})
else if (command === 'close') console.log(${JSON.stringify(JSON.stringify(archived))})
else process.exit(9)
`,
		)
		await chmod(binary, 0o755)
		faults.enabled = true

		const result = await createBeadsProvider({ root, projectId: 'example', binary }).archive(
			'ISSUE-1',
		)

		expect(result).toMatchObject({ ok: false, error: { code: 'provider_lock_release_failed' } })
		if (!result.ok) {
			expect(result.error.details).toContain('stateApplied=true')
			expect(result.error.details).toContain('stateMayHaveChanged=true')
		}
	})

	it('preserves the acquisition error when an earlier lock also fails to release', async () => {
		expect.hasAssertions()
		faults.enabled = true
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary: join(root, 'must-not-run'),
		})

		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			expectedDefinition: {
				schemaVersion: 2,
				title: 'Issue',
				kind: 'issue',
				source: { path: 'docs/ISSUE-1.md', hash: 'a'.repeat(64) },
				parentId: undefined,
				dependencies: ['ISSUE-2'],
				roles: [],
				evidenceRequirements: [],
			},
			expectedDefinitionClosure: [
				{
					workId: 'ISSUE-1',
					schemaVersion: 2,
					title: 'Issue',
					kind: 'issue',
					source: { path: 'docs/ISSUE-1.md', hash: 'a'.repeat(64) },
					parentId: undefined,
					dependencies: ['ISSUE-2'],
					roles: [],
					evidenceRequirements: [],
				},
			],
			expectedDependencies: [
				{
					workId: 'ISSUE-2',
					schemaVersion: 2,
					title: 'Dependency',
					kind: 'issue',
					source: { path: 'docs/ISSUE-2.md', hash: 'c'.repeat(64) },
					parentId: undefined,
					dependencies: [],
					roles: [],
					evidenceRequirements: [],
				},
			],
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_busy',
				details: [
					'cleanupFailure=provider_lock_release_failed',
					'recovery=preserve the primary acquisition error and inspect the provider mutation lock manually',
				],
			},
		})
	})
})
