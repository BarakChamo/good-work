/**
 * @description Proves repository completion recovery with disposable external coordination state.
 *
 * @module work/repository-ledger.int.test
 * @file Repository-ledger.int.test.ts
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env as processEnvironment } from 'node:process'

import { afterEach, expect, test } from 'vitest'

import { runWorkContractCli } from './cli'
import { executeFile } from './subprocess'

const roots: string[] = []
const priorStateHome = processEnvironment.WORK_CONTRACT_STATE_HOME

afterEach(async () => {
	if (priorStateHome === undefined) {
		delete processEnvironment.WORK_CONTRACT_STATE_HOME
	} else {
		processEnvironment.WORK_CONTRACT_STATE_HOME = priorStateHome
	}
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

const git = async (root: string, ...args: readonly string[]) =>
	executeFile('git', args, { cwd: root, timeout: 10_000 })

const invoke = async (root: string, ...args: readonly string[]) => {
	const stdout: string[] = []
	const stderr: string[] = []
	const status = await runWorkContractCli(['--root', root, '--json', ...args], {
		stdout: (value) => void stdout.push(value),
		stderr: (value) => void stderr.push(value),
	})
	return { status, stdout, stderr }
}

const authorityManifest = (completionLedger: boolean): string =>
	[
		'version: 1',
		'project: { id: authority }',
		...(completionLedger ? ['completionLedger: true'] : []),
		'sources:',
		'  - kind: issue',
		'    include: docs/issues/*.md',
		'',
	].join('\n')

// oxlint-disable-next-line eslint/max-statements -- One real lifecycle proves the repository/external-state boundary end to end.
test('finalizes in a worktree and reconstructs closed work after external state is deleted', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-repository-ledger-'))
	const linked = `${root}-feature`
	const clone = `${root}-clone`
	const stateHome = await mkdtemp(join(tmpdir(), 'work-repository-state-'))
	roots.push(root, linked, clone, stateHome)
	processEnvironment.WORK_CONTRACT_STATE_HOME = stateHome
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(
		join(root, 'work.yaml'),
		[
			'version: 1',
			'project: { id: ledger }',
			'completionLedger: true',
			'sources:',
			'  - kind: issue',
			'    include: docs/issues/*.md',
			'policies:',
			'  terminalEvidence: [artifact, review]',
			'  delivery:',
			'    profile: local-direct',
			'    isolation: worktree',
			'    targetRef: refs/heads/main',
			'    requiredGates: [validation, landing]',
			'',
		].join('\n'),
	)
	await writeFile(
		join(root, 'docs', 'issues', 'ISSUE-1-work.md'),
		'---\nid: ISSUE-1\nroles: [implementer]\nevidence: [artifact, review]\n---\n\n# ISSUE-1 Work\n',
	)
	await git(root, 'init', '-b', 'main')
	await git(root, 'config', 'user.name', 'Work Test')
	await git(root, 'config', 'user.email', 'work@example.test')
	await git(root, 'add', '.')
	await git(root, 'commit', '-m', 'definitions')

	const synchronized = await invoke(root, 'sync', '--apply')
	expect(synchronized.status, synchronized.stderr.join('\n')).toBe(0)
	await git(root, 'worktree', 'add', '-b', 'feature', linked)
	const started = await invoke(
		linked,
		'start',
		'ISSUE-1',
		'--actor',
		'worker',
		'--role',
		'implementer',
		'--session',
		's1',
	)
	expect(started.status, started.stderr.join('\n')).toBe(0)
	await mkdir(join(linked, 'reports'))
	await writeFile(join(linked, 'reports', 'result.md'), '# Accepted\n')
	await git(linked, 'add', 'reports/result.md')
	await git(linked, 'commit', '-m', 'implement work')
	const prematureFinalize = await invoke(
		linked,
		'finalize',
		'ISSUE-1',
		'--actor',
		'worker',
		'--role',
		'implementer',
		'--session',
		's1',
		'--evidence',
		'artifact=reports/result.md',
	)
	expect(prematureFinalize.status).toBe(1)
	expect(prematureFinalize.stderr.join('\n')).toContain('review_required')
	const reviewPrepared = await invoke(
		linked,
		'review',
		'prepare',
		'ISSUE-1',
		'--actor',
		'worker',
		'--role',
		'implementer',
		'--session',
		's1',
	)
	expect(reviewPrepared.status, reviewPrepared.stderr.join('\n')).toBe(0)
	const reviewedHead = /"headSha":"([a-f0-9]{40,64})"/u.exec(reviewPrepared.stdout.join('\n'))?.[1]
	expect(reviewedHead).toBeDefined()
	await mkdir(join(linked, 'docs', 'work', 'reviews'), { recursive: true })
	await writeFile(
		join(linked, 'docs/work/reviews/ISSUE-1.md'),
		'# Independent review\n\nAccepted.\n',
	)
	const approved = await invoke(
		linked,
		'review',
		'approve',
		'ISSUE-1',
		'--actor',
		'reviewer',
		'--session',
		'review-session',
		'--evaluator',
		'agent',
		'--report',
		'docs/work/reviews/ISSUE-1.md',
		'--head',
		reviewedHead ?? '',
	)
	expect(approved.status, approved.stderr.join('\n')).toBe(0)
	await git(linked, 'add', 'docs/work/reviews')
	await git(linked, 'commit', '-m', 'record independent review')

	const finalized = await invoke(
		linked,
		'finalize',
		'ISSUE-1',
		'--actor',
		'worker',
		'--role',
		'implementer',
		'--session',
		's1',
		'--evidence',
		'artifact=reports/result.md',
	)
	expect(finalized.status, finalized.stderr.join('\n')).toBe(0)
	await expect(readFile(join(linked, 'docs/work/ledger/ISSUE-1.yaml'), 'utf8')).resolves.toContain(
		'work_id: ISSUE-1',
	)
	await expect(readFile(join(linked, 'docs/work/ledger/ISSUE-1.yaml'), 'utf8')).resolves.toContain(
		'kind: review',
	)
	await git(linked, 'add', 'docs/work/ledger/ISSUE-1.yaml')
	await git(linked, 'commit', '-m', 'record completion')
	const submitted = await invoke(
		linked,
		'submit',
		'ISSUE-1',
		'--actor',
		'worker',
		'--role',
		'implementer',
		'--session',
		's1',
	)
	expect(submitted.status, submitted.stderr.join('\n')).toBe(0)
	const submittedItem = await invoke(linked, 'show', 'ISSUE-1')
	expect(submittedItem.stdout.join('\n')).toContain('"disposition":"approved"')

	const acquired = await invoke(root, 'integration', 'acquire', '--actor', 'integrator')
	expect(acquired.status).toBe(0)
	const nonce = /"nonce":"([a-f0-9-]{36})"/u.exec(acquired.stdout.join('\n'))?.[1]
	expect(nonce).toBeDefined()
	const contended = await invoke(linked, 'integration', 'acquire', '--actor', 'other')
	expect(contended.status).toBe(1)
	await git(root, 'merge', '--ff-only', 'feature')
	const reconciled = await invoke(
		linked,
		'reconcile',
		'ISSUE-1',
		'--actor',
		'worker',
		'--role',
		'implementer',
		'--session',
		's1',
	)
	expect(reconciled.status, reconciled.stderr.join('\n')).toBe(0)
	const released = await invoke(
		root,
		'integration',
		'release',
		'--actor',
		'integrator',
		'--nonce',
		nonce ?? '',
	)
	expect(released.status).toBe(0)
	const closed = await invoke(root, 'show', 'ISSUE-1')
	expect(closed.stdout.join('\n')).toContain('"status":"closed"')
	await writeFile(join(root, 'unrelated.txt'), 'later unrelated work\n')
	await git(root, 'add', 'unrelated.txt')
	await git(root, 'commit', '-m', 'land unrelated work after reviewed completion')

	await rm(stateHome, { recursive: true, force: true })
	await mkdir(stateHome)
	const rebuilt = await invoke(root, 'sync', '--apply')
	expect(rebuilt.status, rebuilt.stderr.join('\n')).toBe(0)
	expect(rebuilt.stdout.join('\n')).toContain('"restored":1')
	const restoredItem = await invoke(root, 'show', 'ISSUE-1')
	expect(restoredItem.stdout.join('\n')).toContain('"status":"closed"')
	expect(restoredItem.stdout.join('\n')).toContain('"role":"implementer"')
	await executeFile('git', ['clone', '--quiet', root, clone], { timeout: 10_000 })
	const cloned = await invoke(clone, 'sync', '--apply')
	expect(cloned.status, cloned.stderr.join('\n')).toBe(0)
	expect(cloned.stdout.join('\n')).toContain('"restored":1')
	const clonedItem = await invoke(clone, 'show', 'ISSUE-1')
	expect(clonedItem.stdout.join('\n')).toContain('"status":"closed"')
	await writeFile(join(root, 'reports', 'result.md'), '# Changed after completion\n')
	await git(root, 'add', 'reports/result.md')
	await git(root, 'commit', '-m', 'simulate stale completion evidence')
	const staleEvidence = await invoke(root, 'sync', '--apply')
	expect(staleEvidence.status).toBe(1)
	expect(staleEvidence.stderr.join('\n')).toContain('Evidence digest does not match')
	await writeFile(join(root, 'reports', 'result.md'), '# Accepted\n')
	await git(root, 'add', 'reports/result.md')
	await git(root, 'commit', '-m', 'restore completion evidence')
	const consistent = await invoke(root, 'sync', '--apply')
	expect(consistent.status, consistent.stderr.join('\n')).toBe(0)
	const recordPath = join(root, 'docs', 'work', 'ledger', 'ISSUE-1.yaml')
	const recordSource = await readFile(recordPath, 'utf8')
	await writeFile(recordPath, recordSource.replace('actor: worker', 'actor: replacement'))
	await git(root, 'add', 'docs/work/ledger/ISSUE-1.yaml')
	await git(root, 'commit', '-m', 'simulate divergent completion record')
	const divergent = await invoke(root, 'sync', '--apply')
	expect(divergent.status).toBe(1)
	expect(divergent.stderr.join('\n')).toContain(
		'disposable completion differs from its repository record',
	)
	await expect(access(join(root, '.beads'))).rejects.toThrow('ENOENT')
	await expect(access(join(clone, '.beads'))).rejects.toThrow('ENOENT')
	const rootStatus = await git(root, 'status', '--porcelain')
	const linkedStatus = await git(linked, 'status', '--porcelain')
	const cloneStatus = await git(clone, 'status', '--porcelain')
	expect(rootStatus.stdout).toBe('')
	expect(linkedStatus.stdout).toBe('')
	expect(cloneStatus.stdout).toBe('')
}, 120_000)

test('reconciles only the selected landed record from a stale parallel worktree', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-repository-parallel-reconcile-'))
	const first = `${root}-first`
	const second = `${root}-second`
	const stateHome = await mkdtemp(join(tmpdir(), 'work-repository-parallel-state-'))
	roots.push(root, first, second, stateHome)
	processEnvironment.WORK_CONTRACT_STATE_HOME = stateHome
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(
		join(root, 'work.yaml'),
		[
			'version: 1',
			'project: { id: parallel-ledger }',
			'completionLedger: true',
			'sources:',
			'  - kind: issue',
			'    include: docs/issues/*.md',
			'policies:',
			'  terminalEvidence: [artifact]',
			'  delivery:',
			'    profile: local-direct',
			'    isolation: worktree',
			'    targetRef: refs/heads/main',
			'    requiredGates: [validation, landing]',
			'',
		].join('\n'),
	)
	await Promise.all([
		writeFile(
			join(root, 'docs', 'issues', 'ISSUE-1-first.md'),
			'---\nid: ISSUE-1\nevidence: [artifact]\n---\n\n# ISSUE-1 First\n',
		),
		writeFile(
			join(root, 'docs', 'issues', 'ISSUE-2-second.md'),
			'---\nid: ISSUE-2\nevidence: [artifact]\n---\n\n# ISSUE-2 Second\n',
		),
	])
	await git(root, 'init', '-b', 'main')
	await git(root, 'config', 'user.name', 'Work Test')
	await git(root, 'config', 'user.email', 'work@example.test')
	await git(root, 'add', '.')
	await git(root, 'commit', '-m', 'parallel definitions')
	const synchronized = await invoke(root, 'sync', '--apply')
	expect(synchronized.status).toBe(0)
	await git(root, 'worktree', 'add', '-b', 'first', first)
	await git(root, 'worktree', 'add', '-b', 'second', second)
	const firstStarted = await invoke(first, 'start', 'ISSUE-1', '--actor', 'first-worker')
	const secondStarted = await invoke(second, 'start', 'ISSUE-2', '--actor', 'second-worker')
	expect(firstStarted.status).toBe(0)
	expect(secondStarted.status).toBe(0)

	await mkdir(join(first, 'reports'))
	await writeFile(join(first, 'reports', 'first.md'), '# First accepted\n')
	await git(first, 'add', 'reports/first.md')
	await git(first, 'commit', '-m', 'first implementation')
	const firstFinalized = await invoke(
		first,
		'finalize',
		'ISSUE-1',
		'--actor',
		'first-worker',
		'--evidence',
		'artifact=reports/first.md',
	)
	expect(firstFinalized.status).toBe(0)
	await git(first, 'add', 'docs/work/ledger/ISSUE-1.yaml')
	await git(first, 'commit', '-m', 'record first completion')
	const firstSubmitted = await invoke(first, 'submit', 'ISSUE-1', '--actor', 'first-worker')
	expect(firstSubmitted.status).toBe(0)

	await mkdir(join(second, 'reports'))
	await writeFile(join(second, 'reports', 'second.md'), '# Second accepted\n')
	await git(second, 'add', 'reports/second.md')
	await git(second, 'commit', '-m', 'second implementation')
	const secondFinalized = await invoke(
		second,
		'finalize',
		'ISSUE-2',
		'--actor',
		'second-worker',
		'--evidence',
		'artifact=reports/second.md',
	)
	expect(secondFinalized.status).toBe(0)
	await git(second, 'add', 'docs/work/ledger/ISSUE-2.yaml')
	await git(second, 'commit', '-m', 'record second completion')
	const secondSubmitted = await invoke(second, 'submit', 'ISSUE-2', '--actor', 'second-worker')
	expect(secondSubmitted.status).toBe(0)

	await git(root, 'merge', '--ff-only', 'first')
	await git(root, 'merge', '--no-edit', 'second')
	const reconciled = await invoke(first, 'reconcile', 'ISSUE-1', '--actor', 'first-worker')
	const firstShown = await invoke(root, 'show', 'ISSUE-1')
	const secondShown = await invoke(root, 'show', 'ISSUE-2')

	expect(reconciled.status, reconciled.stderr.join('\n')).toBe(0)
	expect(firstShown.stdout.join('\n')).toContain('"status":"closed"')
	expect(secondShown.stdout.join('\n')).toContain('"status":"in_progress"')
}, 120_000)

test('serializes concurrent review decisions without overwriting the winning receipt', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-review-race-'))
	const stateHome = await mkdtemp(join(tmpdir(), 'work-review-race-state-'))
	roots.push(root, stateHome)
	processEnvironment.WORK_CONTRACT_STATE_HOME = stateHome
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(
		join(root, 'work.yaml'),
		[
			'version: 1',
			'project: { id: review-race }',
			'completionLedger: true',
			'sources:',
			'  - kind: issue',
			'    include: docs/issues/*.md',
			'policies:',
			'  terminalEvidence: [review]',
			'',
		].join('\n'),
	)
	await writeFile(
		join(root, 'docs/issues/ISSUE-1-review.md'),
		'---\nid: ISSUE-1\nevidence: [review]\n---\n\n# ISSUE-1 Review race\n',
	)
	await git(root, 'init', '-b', 'main')
	await git(root, 'config', 'user.name', 'Work Test')
	await git(root, 'config', 'user.email', 'work@example.test')
	await git(root, 'add', '.')
	await git(root, 'commit', '-m', 'review definitions')
	expect((await invoke(root, 'sync', '--apply')).status).toBe(0)
	expect((await invoke(root, 'start', 'ISSUE-1', '--actor', 'implementer')).status).toBe(0)
	await writeFile(join(root, 'implementation.ts'), 'export const value = 1\n')
	await git(root, 'add', 'implementation.ts')
	await git(root, 'commit', '-m', 'implementation')
	const prepared = await invoke(root, 'review', 'prepare', 'ISSUE-1', '--actor', 'implementer')
	const head = /"headSha":"([a-f0-9]{40,64})"/u.exec(prepared.stdout.join('\n'))?.[1]
	expect(prepared.status).toBe(0)
	expect(head).toBeDefined()
	await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
	await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Concurrent review\n')
	const decisions = await Promise.all([
		invoke(
			root,
			'review',
			'approve',
			'ISSUE-1',
			'--actor',
			'reviewer-a',
			'--evaluator',
			'agent',
			'--report',
			'docs/work/reviews/ISSUE-1.md',
			'--head',
			head ?? '',
		),
		invoke(
			root,
			'review',
			'request-changes',
			'ISSUE-1',
			'--actor',
			'reviewer-b',
			'--evaluator',
			'human',
			'--report',
			'docs/work/reviews/ISSUE-1.md',
			'--head',
			head ?? '',
		),
	])
	expect(
		decisions.map(({ status }) => status).toSorted((left, right) => left - right),
	).toStrictEqual([0, 1])
	const shown = await invoke(root, 'show', 'ISSUE-1')
	const receipt = await readFile(join(root, 'docs/work/reviews/ISSUE-1.yaml'), 'utf8')
	const winningActor = /"reviewer":\{"actor":"([^"]+)"/u.exec(shown.stdout.join('\n'))?.[1]
	expect(['reviewer-a', 'reviewer-b']).toContain(winningActor)
	expect(receipt).toContain(`actor: ${winningActor ?? 'missing'}`)
	expect(receipt).not.toContain(
		`actor: ${winningActor === 'reviewer-a' ? 'reviewer-b' : 'reviewer-a'}`,
	)
}, 120_000)

test('rejects disposable completion that has no repository completion record', async () => {
	expect.hasAssertions()
	const root = await mkdtemp(join(tmpdir(), 'work-repository-authority-'))
	const stateHome = await mkdtemp(join(tmpdir(), 'work-repository-state-'))
	roots.push(root, stateHome)
	processEnvironment.WORK_CONTRACT_STATE_HOME = stateHome
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(join(root, 'work.yaml'), authorityManifest(false))
	await writeFile(
		join(root, 'docs', 'issues', 'ISSUE-1-work.md'),
		'---\nid: ISSUE-1\n---\n\n# ISSUE-1 Work\n',
	)
	await git(root, 'init', '-b', 'main')
	await git(root, 'config', 'user.name', 'Work Test')
	await git(root, 'config', 'user.email', 'work@example.test')
	await git(root, 'add', '.')
	await git(root, 'commit', '-m', 'legacy definitions')
	const initialSync = await invoke(root, 'sync', '--apply')
	expect(initialSync.status, initialSync.stderr.join('\n')).toBe(0)
	const started = await invoke(root, 'start', 'ISSUE-1', '--actor', 'worker')
	expect(started.status).toBe(0)
	const completed = await invoke(root, 'complete', 'ISSUE-1', '--actor', 'worker')
	expect(completed.status).toBe(0)
	await writeFile(join(root, 'work.yaml'), authorityManifest(true))
	await git(root, 'add', 'work.yaml')
	await git(root, 'commit', '-m', 'enable repository completion ledger')
	const synchronized = await invoke(root, 'sync', '--apply')
	expect(synchronized.status).toBe(1)
	expect(synchronized.stderr.join('\n')).toContain('closed only in disposable state')
}, 60_000)
