/**
 * @description Verifies repository-owned independent-review receipts and exact-tree freshness.
 *
 * @module work/review
 * @file Review.test.ts
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	loadReviewReceipt,
	prepareReviewSubject,
	validateHistoricalReviewReceipt,
	validateReviewReceipt,
	writeReviewReceipt,
} from './review'
import { executeFile } from './subprocess'

let root: string

const git = async (...args: readonly string[]): Promise<void> => {
	await executeFile('git', args, { cwd: root, timeout: 10_000 })
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-review-'))
	await git('init', '-q')
	await git('config', 'user.email', 'review@example.com')
	await git('config', 'user.name', 'Review Test')
	await mkdir(join(root, 'src'), { recursive: true })
	await writeFile(join(root, 'src', 'feature.ts'), 'export const feature = true\n')
	await git('add', '.')
	await git('commit', '-qm', 'implementation')
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

describe('repository review receipts', () => {
	it('records approval for the exact clean implementation while permitting only the report change', async () => {
		// Given: a clean implementation revision prepared for review
		const subject = await prepareReviewSubject({ root })
		expect(subject.ok).toBe(true)
		if (!subject.ok) return
		await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
		await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Review\n\nNo blockers.\n')

		// When: a distinct reviewer approves and writes the repository receipt
		const written = await writeReviewReceipt({
			root,
			projectId: 'example',
			definitionHash: 'a'.repeat(64),
			workId: 'ISSUE-1',
			implementationActor: 'implementer',
			reviewer: { actor: 'reviewer', session: 'review-session', evaluator: 'agent' },
			disposition: 'approved',
			reportReference: 'docs/work/reviews/ISSUE-1.md',
			subject: subject.value,
			decidedAt: '2026-09-09T00:00:00.000Z',
		})

		// Then: the receipt is readable and remains current with its protocol files dirty
		expect(written).toMatchObject({
			ok: true,
			value: {
				path: 'docs/work/reviews/ISSUE-1.yaml',
				receipt: { disposition: 'approved', workId: 'ISSUE-1' },
			},
		})
		const loaded = await loadReviewReceipt({ root, workId: 'ISSUE-1' })
		expect(loaded).toEqual(written.ok ? { ok: true, value: written.value.receipt } : loaded)
		if (!loaded.ok || loaded.value === undefined) return
		await expect(validateReviewReceipt({ root, receipt: loaded.value })).resolves.toMatchObject({
			ok: true,
			value: { current: true },
		})
	})

	it('marks approval stale when implementation source changes after review', async () => {
		// Given: an approved exact implementation
		const subject = await prepareReviewSubject({ root })
		expect(subject.ok).toBe(true)
		if (!subject.ok) return
		await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
		await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Review\n\nApproved.\n')
		const written = await writeReviewReceipt({
			root,
			projectId: 'example',
			definitionHash: 'a'.repeat(64),
			workId: 'ISSUE-1',
			implementationActor: 'implementer',
			reviewer: { actor: 'reviewer', evaluator: 'human' },
			disposition: 'approved',
			reportReference: 'docs/work/reviews/ISSUE-1.md',
			subject: subject.value,
			decidedAt: '2026-09-09T00:00:00.000Z',
		})
		expect(written.ok).toBe(true)
		if (!written.ok) return
		await git('add', 'docs/work/reviews')
		await git('commit', '-qm', 'record review')

		// When: source changes after approval
		await writeFile(join(root, 'src', 'feature.ts'), 'export const feature = false\n')

		// Then: Work rejects the old approval as stale
		await expect(
			validateReviewReceipt({ root, receipt: written.value.receipt }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: 'review_target_stale' },
		})
	})

	it('rejects a rename that moves implementation content into the allowed report path', async () => {
		// Given: a prepared implementation containing a short tracked path
		await writeFile(join(root, 'app'), 'implementation content\n')
		await git('add', 'app')
		await git('commit', '-qm', 'add short implementation path')
		const subject = await prepareReviewSubject({ root })
		expect(subject.ok).toBe(true)
		if (!subject.ok) return
		await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
		await git('mv', 'app', 'docs/work/reviews/ISSUE-1.md')

		// When: the renamed implementation is presented as the review report
		const written = writeReviewReceipt({
			root,
			projectId: 'example',
			definitionHash: 'a'.repeat(64),
			workId: 'ISSUE-1',
			implementationActor: 'implementer',
			reviewer: { actor: 'reviewer', evaluator: 'agent' },
			disposition: 'approved',
			reportReference: 'docs/work/reviews/ISSUE-1.md',
			subject: subject.value,
			decidedAt: '2026-09-09T00:00:00.000Z',
		})

		// Then: the deleted source path prevents approval
		await expect(written).resolves.toMatchObject({
			ok: false,
			error: { code: 'review_target_stale' },
		})
	})

	it('rejects a report outside the repository without writing a receipt', async () => {
		const subject = await prepareReviewSubject({ root })
		expect(subject.ok).toBe(true)
		if (!subject.ok) return

		await expect(
			writeReviewReceipt({
				root,
				projectId: 'example',
				definitionHash: 'a'.repeat(64),
				workId: 'ISSUE-1',
				implementationActor: 'implementer',
				reviewer: { actor: 'reviewer', evaluator: 'agent' },
				disposition: 'approved',
				reportReference: '../private.md',
				subject: subject.value,
				decidedAt: '2026-09-09T00:00:00.000Z',
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'review_report_invalid' } })
	})

	it('validates historical review evidence after squash history drops the reviewed commit', async () => {
		const originalBranch = (
			await executeFile('git', ['branch', '--show-current'], { cwd: root, timeout: 10_000 })
		).stdout.trim()
		const subject = await prepareReviewSubject({ root })
		expect(subject.ok).toBe(true)
		if (!subject.ok) return
		await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
		await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Historical review\n')
		const written = await writeReviewReceipt({
			root,
			projectId: 'example',
			definitionHash: 'a'.repeat(64),
			workId: 'ISSUE-1',
			implementationActor: 'implementer',
			reviewer: { actor: 'reviewer', evaluator: 'human' },
			disposition: 'approved',
			reportReference: 'docs/work/reviews/ISSUE-1.md',
			subject: subject.value,
			decidedAt: '2026-09-09T00:00:00.000Z',
		})
		expect(written.ok).toBe(true)
		if (!written.ok) return
		await git('add', '.')
		await git('commit', '-qm', 'record review')
		await git('checkout', '--orphan', 'squashed')
		await git('commit', '-qam', 'squash reviewed result')
		await git('branch', '-D', originalBranch)
		await git('reflog', 'expire', '--expire=now', '--all')
		await git('gc', '--prune=now')

		await expect(
			validateHistoricalReviewReceipt({ root, receipt: written.value.receipt }),
		).resolves.toMatchObject({ ok: true, value: { current: true } })
	})
})
