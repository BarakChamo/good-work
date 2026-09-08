/**
 * @description Verifies bounded item-scoped repository completion records.
 *
 * @module work/completion-ledger.test
 * @file Completion-ledger.test.ts
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import { loadCompletionLedger, writeCompletionRecord } from './completion-ledger'

const roots: string[] = []
afterEach(async () =>
	Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))),
)

test('writes and reloads one item-scoped completion record', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-completion-ledger-'))
	roots.push(root)
	const record = {
		version: 1 as const,
		workId: 'ISSUE-1',
		state: 'closed' as const,
		implementation: 'a'.repeat(40),
		completedAt: '2026-09-06T00:00:00.000Z',
		actor: 'codex',
		role: 'coder',
		session: 'session-1',
		evidence: [{ kind: 'test' as const, reference: 'reports/test.md', digest: 'b'.repeat(64) }],
	}
	const written = await writeCompletionRecord({ root, record })
	expect(written).toMatchObject({ ok: true, value: { path: 'docs/work/ledger/ISSUE-1.yaml' } })
	await expect(readFile(join(root, 'docs/work/ledger/ISSUE-1.yaml'), 'utf8')).resolves.toContain(
		'work_id: ISSUE-1',
	)
	await expect(loadCompletionLedger({ root })).resolves.toStrictEqual({
		ok: true,
		value: [record],
	})
})

test('preserves valid historical records outside the active work graph', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-completion-ledger-'))
	roots.push(root)
	await writeCompletionRecord({
		root,
		record: {
			version: 1,
			workId: 'ISSUE-2',
			state: 'closed',
			completedAt: '2026-09-06T00:00:00.000Z',
			actor: 'codex',
			evidence: [],
		},
	})
	await expect(loadCompletionLedger({ root })).resolves.toMatchObject({
		ok: true,
		value: [{ workId: 'ISSUE-2' }],
	})
})

test('represents reopening in the same item-scoped file', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-completion-ledger-'))
	roots.push(root)
	const written = await writeCompletionRecord({
		root,
		record: {
			version: 1,
			workId: 'ISSUE-1',
			state: 'open',
			reopenedAt: '2026-09-06T01:00:00.000Z',
			actor: 'operator',
			reason: 'Requirements changed.',
			evidence: [],
		},
	})
	expect(written.ok).toBe(true)
	await expect(loadCompletionLedger({ root })).resolves.toMatchObject({
		ok: true,
		value: [{ workId: 'ISSUE-1', state: 'open', reason: 'Requirements changed.' }],
	})
})

test('retains distinct records written by parallel work streams', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-completion-ledger-'))
	roots.push(root)
	const workIds = ['ISSUE-1', 'ISSUE-2', 'ISSUE-3'] as const
	const writes = await Promise.all(
		workIds.map(async (workId, index) =>
			writeCompletionRecord({
				root,
				record: {
					version: 1,
					workId,
					state: 'closed',
					completedAt: `2026-09-06T01:00:0${index}.000Z`,
					actor: `worker-${index}`,
					evidence: [],
				},
			}),
		),
	)
	expect(writes.every(({ ok }) => ok)).toBe(true)
	await expect(loadCompletionLedger({ root })).resolves.toMatchObject({
		ok: true,
		value: workIds.map((workId, index) => ({ workId, actor: `worker-${index}` })),
	})
})
