/**
 * @description Verifies proposal interruption markers remain durable, bounded, and privacy-safe.
 *
 * @module work/proposals-crash
 * @file Proposals-crash.test.ts
 */

/* oxlint-disable typescript/consistent-type-imports, vitest/prefer-import-in-mock -- Typed built-in-module interception injects lock-release failure. */

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compileWorkGraph } from './compiler'
import type { WorkManifest } from './contracts'
import { applyPlanningProposal, validatePlanningProposal } from './proposals'

const faults = vi.hoisted(() => ({ lockRelease: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		rm: async (...arguments_: Parameters<typeof actual.rm>): Promise<void> => {
			if (
				faults.lockRelease &&
				typeof arguments_[0] === 'string' &&
				arguments_[0].endsWith('/.work/proposal-apply.lock')
			) {
				throw new Error('injected proposal lock release failure')
			}
			await actual.rm(...arguments_)
		},
	}
})

const manifest: WorkManifest = {
	schemaVersion: 1,
	projectId: 'example',
	sources: [
		{
			kind: 'issue',
			include: ['docs/issues/*.md'],
			parentFields: ['parent'],
			dependencyFields: ['dependencies'],
		},
	],
	policies: { contextMaxBytes: 12_000, staleClaimMinutes: 90, terminalEvidence: [] },
}

const manifestFile = JSON.stringify({
	version: 1,
	project: { id: 'example' },
	sources: manifest.sources,
	policies: manifest.policies,
})

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

let root: string

beforeEach(async () => {
	faults.lockRelease = false
	root = await mkdtemp(join(tmpdir(), 'work-contract-proposal-crash-'))
	await mkdir(join(root, '.work'), { recursive: true })
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(join(root, 'work.yaml'), manifestFile)
})

afterEach(async () => {
	faults.lockRelease = false
	await rm(root, { force: true, recursive: true })
})

describe('planning proposal interruption marker', () => {
	it('persists a private recovery intent and never echoes it in collision diagnostics', async () => {
		expect.hasAssertions()
		const original = '# ISSUE-1 Old\n'
		const target = join(root, 'docs', 'issues', 'ISSUE-1.md')
		await writeFile(target, original)
		const graph = await compileWorkGraph({ root, manifest })
		if (!graph.ok) {
			throw new Error(graph.error.message)
		}
		const plan = await validatePlanningProposal({
			root,
			graph: graph.value,
			manifest,
			manifestPath: 'work.yaml',
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.value.fingerprint,
				changes: [
					{
						type: 'update',
						path: 'docs/issues/ISSUE-1.md',
						expectedHash: hash(original),
						content: '# ISSUE-1 New\n',
					},
				],
			},
		})
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		faults.lockRelease = true

		const applied = await applyPlanningProposal({
			root,
			plan: plan.value,
			approvedFingerprint: plan.value.fingerprint,
		})
		expect(applied).toMatchObject({
			ok: false,
			error: { code: 'proposal_lock_release_failed' },
		})
		if (!applied.ok) {
			expect(applied.error.details).toContain('stateApplied=true')
			expect(applied.error.details).toContain('stateMayHaveChanged=true')
			expect(applied.error.details).toContain(
				'recovery=inspect the configuration-mutation lock intent, repository sources, provider definitions, and .work/lock.json before manual removal',
			)
		}
		const lockPath = join(root, '.work', 'proposal-apply.lock')
		const intent: unknown = JSON.parse(await readFile(lockPath, 'utf8'))
		expect(intent).toStrictEqual({
			schemaVersion: 1,
			kind: 'work_contract_proposal_apply',
			pid: process.pid,
			proposalId: 'PROPOSAL-1',
			fingerprint: plan.value.fingerprint,
			paths: ['docs/issues/ISSUE-1.md'],
		})
		const lockInformation = await stat(lockPath)
		expect(lockInformation.mode.toString(8).slice(-3)).toBe('600')

		const collision = await applyPlanningProposal({
			root,
			plan: plan.value,
			approvedFingerprint: plan.value.fingerprint,
		})
		expect(collision).toMatchObject({
			ok: false,
			error: {
				code: 'proposal_apply_locked',
				details: [
					'lock=.work/proposal-apply.lock',
					'recovery=inspect the configuration-mutation lock intent, repository sources, provider definitions, and .work/lock.json before manual removal',
				],
			},
		})
		const diagnostic = JSON.stringify(collision)
		expect(diagnostic).not.toContain('PROPOSAL-1')
		expect(diagnostic).not.toContain(plan.value.fingerprint)
		expect(diagnostic).not.toContain('docs/issues/ISSUE-1.md')
	})
})
