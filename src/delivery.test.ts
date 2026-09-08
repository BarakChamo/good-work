/**
 * @description Verifies exact candidate and gate evaluation against disposable Git repositories.
 *
 * @module work/delivery
 * @file Delivery.test.ts
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { evaluateDeliveryCompletion, loadDeliveryReceipts } from './delivery'
import type { LedgerCandidate, LedgerItem } from './provider'
import { executeFile } from './subprocess'

const execute = executeFile
const roots: string[] = []
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })))
})

describe('delivery completion evaluation', () => {
	it('rejects traversal, symlink, and malformed receipt inputs without exposing content', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-receipts-'))
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-receipts-outside-'))
		roots.push(root, outside)
		await writeFile(join(outside, 'secret.json'), '{"secret":"do-not-echo"}\n')
		await symlink(join(outside, 'secret.json'), join(root, 'linked.json'))
		await writeFile(join(root, 'malformed.json'), '{"secret":"do-not-echo"}\n')

		for (const reference of ['../outside.json', 'linked.json', 'malformed.json']) {
			const result = await loadDeliveryReceipts({ root, references: [reference] })
			expect(result).toMatchObject({ ok: false, error: { code: 'invalid_delivery_receipt' } })
			expect(JSON.stringify(result)).not.toContain('do-not-echo')
		}
	})

	it('requires the submitted commit to be contained by the configured local target', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-delivery-'))
		roots.push(root)
		await execute('git', ['init', '-b', 'feature'], { cwd: root })
		await execute('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await execute('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await writeFile(join(root, 'source.ts'), 'export const value = 1\n')
		await execute('git', ['add', 'source.ts'], { cwd: root })
		await execute('git', ['commit', '-m', 'candidate'], { cwd: root })
		const headResult = await execute('git', ['rev-parse', 'HEAD'], { cwd: root })
		const treeResult = await execute('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root })
		const head = headResult.stdout.trim()
		const tree = treeResult.stdout.trim()
		const candidate: LedgerCandidate = {
			schemaVersion: 1,
			generation: 1,
			projectId: 'example',
			workId: 'ISSUE-1',
			graphFingerprint: digest('graph'),
			repositoryId: digest(
				await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
					cwd: root,
				}).then(({ stdout }) => stdout.trim()),
			),
			headSha: head,
			treeSha: tree,
			ref: 'refs/heads/feature',
			isolation: 'main',
			submittedAt: '2026-09-01T00:00:00.000Z',
			actor: 'agent-a',
			evidence: [],
		}
		const item: LedgerItem = {
			definitionSchemaVersion: 2,
			providerId: 'provider-issue-1',
			projectId: 'example',
			workId: 'ISSUE-1',
			title: 'Issue',
			kind: 'issue',
			status: 'in_progress',
			parentId: undefined,
			dependencies: [],
			roles: [],
			evidenceRequirements: [],
			source: { path: 'docs/ISSUE-1.md', hash: digest('source') },
			graphFingerprint: candidate.graphFingerprint,
			assignee: 'agent-a',
			activity: undefined,
			handoff: undefined,
			evidence: [],
			candidate,
			gates: [],
			blockReason: undefined,
			updatedAt: '2026-09-01T00:00:00.000Z',
		}
		const policy = {
			profile: 'local-direct' as const,
			isolation: 'none' as const,
			integration: 'local' as const,
			terminal: 'landed' as const,
			targetRef: 'refs/heads/main',
			requiredGates: ['validation', 'landing'] as const,
		}

		await expect(
			evaluateDeliveryCompletion({
				root,
				graphFingerprint: candidate.graphFingerprint,
				item,
				policy,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'delivery_gates_incomplete' } })

		await execute('git', ['branch', 'main', head], { cwd: root })
		const accepted = await evaluateDeliveryCompletion({
			root,
			graphFingerprint: candidate.graphFingerprint,
			item: {
				...item,
				gates: [
					{
						schemaVersion: 1,
						gate: 'validation',
						result: 'passed',
						candidateGeneration: 1,
						projectId: 'example',
						workId: 'ISSUE-1',
						graphFingerprint: candidate.graphFingerprint,
						repositoryId: candidate.repositoryId,
						headSha: head,
						treeSha: tree,
						issuer: { kind: 'self', id: 'work-contract:evidence' },
						reference: 'work-contract:evidence',
						digest: digest('evidence'),
						observedAt: '2026-09-01T00:00:00.000Z',
					},
				],
			},
			policy,
		})
		expect(accepted).toMatchObject({
			ok: true,
			value: { gates: [{ gate: 'validation' }, { gate: 'landing', issuer: { kind: 'adapter' } }] },
		})
		await expect(
			evaluateDeliveryCompletion({
				root,
				graphFingerprint: digest('graph-after-unrelated-definition-change'),
				item: {
					...item,
					definitionSchemaVersion: 3,
					graphFingerprint: candidate.graphFingerprint,
					definitionRevision: {
						targetRef: 'refs/heads/main',
						targetSha: head,
						graphFingerprint: candidate.graphFingerprint,
					},
					gates: accepted.ok
						? accepted.value.gates.filter(({ gate }) => gate === 'validation')
						: [],
				},
				policy,
			}),
		).resolves.toMatchObject({ ok: true })
		if (!accepted.ok) {
			return
		}
		const validation = accepted.value.gates[0]
		if (validation === undefined) {
			throw new Error('Missing validation fixture receipt')
		}
		for (const result of ['failed', 'unavailable', 'stale', 'waived'] as const) {
			await expect(
				evaluateDeliveryCompletion({
					root,
					graphFingerprint: candidate.graphFingerprint,
					item,
					policy: { ...policy, integration: 'evidence', requiredGates: ['validation'] },
					receipts: [{ ...validation, result }],
				}),
			).resolves.toMatchObject({
				ok: false,
				error: {
					code: 'delivery_gates_incomplete',
					details: [`validation=${result}`],
				},
			})
		}
		await expect(
			evaluateDeliveryCompletion({
				root,
				graphFingerprint: candidate.graphFingerprint,
				item,
				policy: {
					...policy,
					integration: 'pull-request',
					terminal: 'merged',
					requiredGates: ['ci'],
				},
				receipts: [{ ...validation, gate: 'ci', issuer: { kind: 'self', id: 'agent' } }],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'invalid_delivery_receipt' } })

		const adapterReceipt = (gate: 'pull-request' | 'review' | 'ci' | 'merge') => ({
			...validation,
			gate,
			issuer: { kind: 'adapter' as const, id: `fixture:${gate}` },
			reference: `fixture:${gate}:passed`,
			digest: digest(gate),
		})
		await expect(
			evaluateDeliveryCompletion({
				root,
				graphFingerprint: candidate.graphFingerprint,
				item,
				policy: {
					profile: 'protected-pr',
					isolation: 'worktree',
					integration: 'pull-request',
					terminal: 'merged',
					targetRef: 'refs/heads/main',
					protectedRefs: ['refs/heads/main'],
					requiredGates: ['pull-request', 'review', 'ci', 'merge'],
				},
				receipts: [
					adapterReceipt('pull-request'),
					adapterReceipt('review'),
					adapterReceipt('ci'),
					adapterReceipt('merge'),
				],
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				gates: [{ gate: 'pull-request' }, { gate: 'review' }, { gate: 'ci' }, { gate: 'merge' }],
			},
		})
		await expect(
			evaluateDeliveryCompletion({
				root,
				graphFingerprint: candidate.graphFingerprint,
				item,
				policy: {
					profile: 'protected-pr',
					isolation: 'worktree',
					integration: 'pull-request',
					terminal: 'merged',
					requiredGates: ['ci'],
				},
				receipts: [{ ...adapterReceipt('ci'), candidateGeneration: 2 }],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'invalid_delivery_receipt' } })
	})
})
