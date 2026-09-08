/**
 * @description Runs the private, bounded Codex/Claude work-contract live campaign.
 *
 * @module work/evals/live
 * @file Live.ts
 */

/* oxlint-disable eslint/no-console -- This executable reports its result and fatal diagnostics. */

import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs'
import {
	access,
	chmod,
	copyFile,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { argv, env as processEnvironment, getgid, getuid } from 'node:process'

import {
	activeClaimAssertions,
	assertClaudeCampaignBudget,
	assertVerifiedLiveIsolation,
	campaignAccepted,
	claudeAllowedTools,
	classifyRuntimeResult,
	createBoundedLineCollector,
	currentLiveIsolationBackend,
	evidenceReceiptAccepted,
	finalizeToolCount,
	inputTokenMetrics,
	isolatedClaudeCredentials,
	livePreflightAccepted,
	nonNegativeMetric,
	ownershipConflictResultAccepted,
	parseLiveEvalArguments,
	reserveClaudeBudget,
	runtimeOrder,
	runtimeEnvironmentAllowlist,
	serializablePreflightSummary,
	sanitizedControllerEnvironment,
	telemetryProbeAccepted,
} from './live-contract'
import { secureArtifactTree } from './artifact-retention'
import {
	assertCanonicalDirectory,
	createPrivateDirectoryPath,
	dockerRunArguments,
	establishWorkFixtureBoundary,
	readBoundedContainedUtf8,
	readContainedDirectoryEntries,
	removeDockerContainer,
	safeGitArguments,
	safeGitEnvironment,
	shutdownEvalResources,
	trustedExecutablePath,
	writeExclusivePrivateFile,
} from './eval-security'
import type { DetachedProcessGroup } from './eval-security'
import type {
	EvaluationMode,
	LiveEvalOptions,
	RuntimeName,
	SerializablePreflightSummary,
} from './live-contract'

const AGENT_TIMEOUT_MS = 180_000
const AGENT_TOOL_LIMIT = 40
const AGENT_STREAM_LIMIT_BYTES = 8 * 1024 * 1024
const CLAUDE_INVOCATION_CAP_USD = 1

interface ProcessResult {
	readonly exitCode: number | null
	readonly stdout: string
	readonly stderr: string
	readonly elapsedMs: number
	readonly timedOut: boolean
	readonly toolLimitExceeded: boolean
}

interface TokenMetrics {
	readonly uncachedInput: number | null
	readonly cachedInput: number | null
	readonly output: number | null
	readonly reasoning: number | null
}

interface AgentMetrics {
	readonly turns: number | null
	readonly toolCalls: number
	readonly tokens: TokenMetrics
	readonly directCostUsd: number | null
}

interface TrialReport {
	readonly runtime: RuntimeName
	readonly mode: EvaluationMode
	readonly pair: number
	readonly order: number
	readonly attempt: number
	readonly accepted: boolean
	readonly classification: string
	readonly runtimeExitCode: number | null
	readonly timedOut: boolean
	readonly toolLimitExceeded: boolean
	readonly budgetExhausted: boolean
	readonly promptBytes: number
	readonly turns: number | null
	readonly toolCalls: number
	readonly retries: number
	readonly elapsedMs: number
	readonly operatorInterventions: number
	readonly tokens: TokenMetrics
	readonly directCostUsd: number | null
	readonly telemetryAccepted: boolean
	readonly retainedFixture?: string
}

interface Fixture {
	readonly root: string
	readonly baselineStatus: string
	readonly baselineTelemetryCount: number
	readonly baselineTelemetryConfig?: string
	readonly isWorkMode: boolean
}

interface Preflight {
	readonly bun: string
	readonly git: string
	readonly codex: string
	readonly claude: string
	readonly executables: Readonly<{
		readonly bun: string
		readonly git: string
		readonly tar: string
		readonly docker: string
	}>
	readonly authentication: Readonly<Record<'codex' | 'claude', true>>
	readonly isolatedAuthentication?: Readonly<Record<'codex' | 'claude', boolean>>
	readonly liveIsolation?: {
		readonly kind: 'container' | 'unavailable'
		readonly verified: boolean
	}
}

interface ClaudeBudgetState {
	spentUsd: number
}

interface RuntimeHomes {
	readonly codex: string
	readonly claude: string
}

interface EvalController {
	readonly root: string
	readonly binary: string
	readonly bunBinary: string
	readonly gitBinary: string
	readonly candidateRoot: string
	readonly candidateFingerprint: string
	readonly environment: Readonly<Record<string, string>>
	readonly isolation?: DockerIsolation
	readonly runtimeHome: string
}

interface DockerIsolation {
	readonly executable: string
	readonly image: string
}

const packageRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = packageRoot
let sensitiveRuntimeHomeRoot: string | undefined
let activeEvalArtifactRoot: string | undefined
let activeDockerIsolation: DockerIsolation | undefined
const activeRuntimeGroups = new Map<number, DetachedProcessGroup>()
const activeContainers = new Set<string>()
let signalShutdownStarted = false

const CONTAINER_BUN_VERSION = '1.3.7'
const CONTAINER_CODEX_VERSION = '0.146.0'
const CONTAINER_CLAUDE_VERSION = '2.1.251'
const CONTAINER_BASE_IMAGE = 'node:24-bookworm-slim'

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const parseJsonRecord = (source: string): Record<string, unknown> | undefined => {
	try {
		const value: unknown = JSON.parse(source)
		return isRecord(value) ? value : undefined
	} catch {
		return undefined
	}
}

const runSync = (
	command: string,
	arguments_: readonly string[],
	cwd: string,
	environment: Readonly<Record<string, string>> = {},
	inheritEnvironment = true,
) => {
	const result = spawnSync(command, arguments_, {
		cwd,
		encoding: 'utf8',
		env: inheritEnvironment ? { ...processEnvironment, ...environment } : environment,
		timeout: 120_000,
		maxBuffer: 16 * 1024 * 1024,
	})
	if (result.status !== 0) {
		let diagnostic = 'no subprocess diagnostic was returned'
		if (typeof result.stderr === 'string') {
			diagnostic = result.stderr
		} else if (result.error instanceof Error) {
			diagnostic = result.error.message
		}
		throw new Error(
			`${command} ${arguments_.join(' ')} failed (${String(result.status)}): ${diagnostic.slice(0, 2000)}`,
		)
	}
	return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const fingerprintTree = (root: string): string => {
	const digest = createHash('sha256')
	const visit = (path: string, relativePath: string): void => {
		const details = lstatSync(path)
		if (details.isSymbolicLink()) {
			digest.update(`link\0${relativePath}\0${readlinkSync(path)}\0`)
			return
		}
		if (details.isDirectory()) {
			digest.update(`directory\0${relativePath}\0`)
			for (const name of readdirSync(path).toSorted()) {
				visit(join(path, name), relativePath.length === 0 ? name : `${relativePath}/${name}`)
			}
			return
		}
		if (!details.isFile()) {
			throw new Error('Controller package contains an unsupported filesystem entry.')
		}
		digest.update(`file\0${relativePath}\0`)
		digest.update(readFileSync(path))
		digest.update('\0')
	}
	visit(realpathSync(root), '')
	return digest.digest('hex')
}

const assertControllerIntegrity = (controller: EvalController): void => {
	if (fingerprintTree(controller.candidateRoot) !== controller.candidateFingerprint) {
		throw new Error('Evaluation controller package integrity check failed.')
	}
}

const assertWorkspaceControlTree = (root: string): void => {
	const realRoot = realpathSync(root)
	let entries = 0
	const visit = (path: string): void => {
		let details: ReturnType<typeof lstatSync>
		try {
			details = lstatSync(path)
		} catch (error: unknown) {
			if (isRecord(error) && error.code === 'ENOENT') {
				return
			}
			throw error
		}
		entries += 1
		if (entries > 20_000 || details.isSymbolicLink()) {
			throw new Error('Evaluation fixture control state failed its bounded no-symlink check.')
		}
		const local = relative(realRoot, realpathSync(path))
		if (local.startsWith('..') || local.startsWith('/')) {
			throw new Error('Evaluation fixture control state escapes its workspace.')
		}
		if (details.isDirectory()) {
			for (const name of readdirSync(path)) {
				visit(join(path, name))
			}
			return
		}
		if (!details.isFile()) {
			throw new Error('Evaluation fixture control state contains an unsupported entry.')
		}
	}
	for (const relativePath of ['work.yaml', '.work', '.beads']) {
		visit(join(root, relativePath))
	}
}

const runControllerResult = (
	controller: EvalController,
	arguments_: readonly string[],
	cwd: string,
	runId?: string,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
	assertControllerIntegrity(controller)
	assertWorkspaceControlTree(cwd)
	if (controller.isolation !== undefined) {
		const name = `work-contract-controller-${randomUUID().slice(0, 8)}`
		activeContainers.add(name)
		const result = dockerSync(
			controller.isolation.executable,
			dockerContainerArguments({
				isolation: controller.isolation,
				name,
				workspace: cwd,
				runtimeHome: controller.runtimeHome,
				runtime: 'codex',
				runId: runId ?? 'controller',
				command: 'work',
				arguments: arguments_,
			}),
			120_000,
		)
		const removed = cleanupContainerSync(controller.isolation, name)
		return removed
			? { status: result.status, stdout: result.stdout, stderr: result.stderr }
			: { status: null, stdout: '', stderr: 'Controller container cleanup failed.' }
	}
	const result = spawnSync(controller.binary, arguments_, {
		cwd,
		encoding: 'utf8',
		env: {
			...controller.environment,
			...(runId === undefined ? {} : { WORK_CONTRACT_RUN_ID: runId }),
		},
		timeout: 120_000,
		maxBuffer: 16 * 1024 * 1024,
	})
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const runController = (
	controller: EvalController,
	arguments_: readonly string[],
	cwd: string,
	runId?: string,
): { readonly stdout: string; readonly stderr: string } => {
	const result = runControllerResult(controller, arguments_, cwd, runId)
	if (result.status !== 0) {
		const route = arguments_.find((argument) => !argument.startsWith('-')) ?? 'unknown'
		throw new Error(
			`Trusted work controller ${route} failed (${String(result.status)}): ${result.stderr.slice(0, 2000)}`,
		)
	}
	return result
}

const allowlistedVersion = (label: 'bun' | 'claude' | 'codex' | 'git', source: string): string => {
	const value = source.trim().split('\n')[0] ?? ''
	const accepted = {
		bun: /^\d+\.\d+\.\d+$/,
		git: /^git version \d+\.\d+\.\d+(?: \(Apple Git-\d+\))?$/,
		codex: /^codex-cli \d+\.\d+\.\d+$/,
		claude: /^\d+\.\d+\.\d+ \(Claude Code\)$/,
	}[label]
	if (!accepted.test(value)) {
		throw new Error(`The ${label} version probe returned an unsupported format.`)
	}
	return value
}

const preflight = (): Preflight => {
	if (process.platform === 'win32') {
		throw new Error('Live evaluation requires POSIX process-group cleanup semantics.')
	}
	const bunPath = trustedExecutablePath('bun', [process.execPath])
	const gitPath = trustedExecutablePath('git', ['/usr/bin/git'])
	const tarPath = trustedExecutablePath('tar', ['/usr/bin/tar', '/bin/tar'])
	const dockerPath = trustedExecutablePath('docker', [
		'/usr/local/bin/docker',
		'/opt/homebrew/bin/docker',
	])
	const bun = runSync(bunPath, ['--version'], repositoryRoot).stdout
	const git = runSync(gitPath, ['--version'], repositoryRoot).stdout
	return {
		bun: allowlistedVersion('bun', bun),
		git: allowlistedVersion('git', git),
		codex: `codex-cli ${CONTAINER_CODEX_VERSION}`,
		claude: `${CONTAINER_CLAUDE_VERSION} (Claude Code)`,
		executables: {
			bun: bunPath,
			git: gitPath,
			tar: tarPath,
			docker: dockerPath,
		},
		authentication: { codex: true, claude: true },
	}
}

const prepareRuntimeHomes = async (artifactRoot: string): Promise<RuntimeHomes> => {
	const homes = {
		codex: join(artifactRoot, 'runtime-homes/codex'),
		claude: join(artifactRoot, 'runtime-homes/claude'),
	}
	await Promise.all([
		createPrivateDirectoryPath(artifactRoot, ['runtime-homes', 'codex', '.codex']),
		createPrivateDirectoryPath(artifactRoot, ['runtime-homes', 'claude', '.claude']),
		createPrivateDirectoryPath(artifactRoot, ['runtime-homes', 'codex', 'tmp']),
		createPrivateDirectoryPath(artifactRoot, ['runtime-homes', 'claude', 'tmp']),
	])
	const hostHome = processEnvironment.HOME
	if (hostHome === undefined) {
		throw new Error('Runtime authentication isolation requires a host HOME.')
	}
	const hostCodexHome = processEnvironment.CODEX_HOME ?? join(hostHome, '.codex')
	await copyFile(join(hostCodexHome, 'auth.json'), join(homes.codex, '.codex/auth.json'))
	await chmod(join(homes.codex, '.codex/auth.json'), 0o600)

	const claudeState = parseJsonRecord(await readFile(join(hostHome, '.claude.json'), 'utf8'))
	if (claudeState === undefined) {
		throw new Error('Claude authentication state is unavailable for isolated evaluation.')
	}
	if (process.platform !== 'darwin') {
		throw new Error('Claude account credential isolation currently requires macOS Keychain.')
	}
	const keychainCredential = parseJsonRecord(
		runSync(
			trustedExecutablePath('security', ['/usr/bin/security']),
			['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
			repositoryRoot,
		).stdout,
	)
	const isolatedCredential = isolatedClaudeCredentials(keychainCredential)
	if (isolatedCredential === undefined) {
		throw new Error('Claude account credential is unavailable or invalid for isolated evaluation.')
	}
	const allowedClaudeState: Record<string, unknown> = {}
	for (const key of [
		'oauthAccount',
		'userID',
		'machineID',
		'hasCompletedOnboarding',
		'installMethod',
	]) {
		if (key in claudeState) {
			allowedClaudeState[key] = claudeState[key]
		}
	}
	const isolatedClaudeState = `${JSON.stringify(allowedClaudeState)}\n`
	await Promise.all([
		writeFile(join(homes.claude, '.claude.json'), isolatedClaudeState, { mode: 0o600 }),
		writeFile(join(homes.claude, '.claude/.claude.json'), isolatedClaudeState, { mode: 0o600 }),
		writeFile(
			join(homes.claude, '.claude/.credentials.json'),
			`${JSON.stringify(isolatedCredential)}\n`,
			{
				mode: 0o600,
			},
		),
	])
	return homes
}

const prepareArtifactBase = async (): Promise<string> =>
	createPrivateDirectoryPath(repositoryRoot, ['artifacts', 'work-contract-evals'])

const dockerSync = (
	executable: string,
	arguments_: readonly string[],
	timeout = 120_000,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
	const result = spawnSync(executable, arguments_, {
		argv0: 'docker',
		cwd: repositoryRoot,
		encoding: 'utf8',
		env: processEnvironment,
		timeout,
		maxBuffer: 16 * 1024 * 1024,
	})
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const dockerContainerArguments = (input: {
	readonly isolation: DockerIsolation
	readonly name: string
	readonly workspace: string
	readonly runtimeHome: string
	readonly runtime: RuntimeName
	readonly runId: string
	readonly command: string
	readonly arguments: readonly string[]
}): readonly string[] =>
	dockerRunArguments({
		image: input.isolation.image,
		name: input.name,
		workspace: input.workspace,
		runtimeHome: input.runtimeHome,
		runtime: input.runtime,
		runId: input.runId,
		uid: getuid?.() ?? 1000,
		gid: getgid?.() ?? 1000,
		command: input.command,
		arguments: input.arguments,
	})

const cleanupContainer = async (isolation: DockerIsolation, name: string): Promise<boolean> => {
	const removed = await removeDockerContainer({
		name,
		execute: async (arguments_) => dockerSync(isolation.executable, arguments_, 15_000),
	})
	if (removed) {
		activeContainers.delete(name)
	}
	return removed
}

const cleanupContainerSync = (isolation: DockerIsolation, name: string): boolean => {
	dockerSync(isolation.executable, ['stop', '--time', '2', name], 15_000)
	dockerSync(isolation.executable, ['kill', name], 15_000)
	dockerSync(isolation.executable, ['rm', '--force', name], 15_000)
	const removed = dockerSync(isolation.executable, ['inspect', name], 15_000).status !== 0
	if (removed) {
		activeContainers.delete(name)
	}
	return removed
}

const cleanupDockerImage = (isolation: DockerIsolation): boolean => {
	dockerSync(isolation.executable, ['image', 'rm', '--force', isolation.image], 60_000)
	return (
		dockerSync(isolation.executable, ['image', 'inspect', isolation.image], 15_000).status !== 0
	)
}

const assertRuntimeQuiescent = (): void => {
	if (activeRuntimeGroups.size > 0 || activeContainers.size > 0) {
		throw new Error(
			'Evaluation artifacts cannot be retained while runtime resources remain active.',
		)
	}
}

const buildDockerIsolation = async (input: {
	readonly artifactRoot: string
	readonly tarball: string
	readonly executable: string
	readonly runId: string
}): Promise<DockerIsolation> => {
	const buildRoot = await createPrivateDirectoryPath(input.artifactRoot, ['isolation-build'])
	await copyFile(input.tarball, join(buildRoot, 'candidate.tgz'))
	const image = `work-contract-eval:${createHash('sha256').update(input.runId).digest('hex').slice(0, 16)}`
	const dockerfile = `FROM ${CONTAINER_BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install --global bun@${CONTAINER_BUN_VERSION} @openai/codex@${CONTAINER_CODEX_VERSION} @anthropic-ai/claude-code@${CONTAINER_CLAUDE_VERSION}
COPY candidate.tgz /tmp/candidate.tgz
RUN mkdir -p /opt/work-contract && cd /opt/work-contract && printf '{"private":true,"scripts":{"work":"work"}}' > package.json && bun add --ignore-scripts /tmp/candidate.tgz && bun run work provider install && test -x /opt/work-contract/node_modules/@beads/bd/bin/bd && /opt/work-contract/node_modules/@beads/bd/bin/bd version >/dev/null && ln -s /opt/work-contract/node_modules/.bin/work /usr/local/bin/work && rm /tmp/candidate.tgz
`
	await writeExclusivePrivateFile(buildRoot, join(buildRoot, 'Dockerfile'), dockerfile)
	const built = dockerSync(
		input.executable,
		['build', '--pull=false', '--tag', image, '--file', join(buildRoot, 'Dockerfile'), buildRoot],
		600_000,
	)
	if (built.status !== 0) {
		throw new Error('Docker isolation image build failed.')
	}
	return { executable: input.executable, image }
}

const verifyDockerIsolation = async (input: {
	readonly isolation: DockerIsolation
	readonly artifactRoot: string
	readonly rawRoot: string
}): Promise<boolean> => {
	const root = await createPrivateDirectoryPath(input.artifactRoot, ['isolation-probe'])
	const workspace = await createPrivateDirectoryPath(root, ['workspace'])
	const runtimeHome = await createPrivateDirectoryPath(root, ['runtime-home'])
	await createPrivateDirectoryPath(runtimeHome, ['.codex'])
	const deniedCanary = join(input.rawRoot, 'docker-denied-canary')
	await writeExclusivePrivateFile(input.rawRoot, deniedCanary, 'must-not-be-readable\n')
	await Promise.all([assertCanonicalDirectory(workspace), assertCanonicalDirectory(runtimeHome)])
	const name = `work-contract-probe-${randomUUID().slice(0, 8)}`
	activeContainers.add(name)
	const result = dockerSync(
		input.isolation.executable,
		dockerContainerArguments({
			isolation: input.isolation,
			name,
			workspace,
			runtimeHome,
			runtime: 'codex',
			runId: 'preflight',
			command: '/bin/sh',
			arguments: [
				'-c',
				'touch /workspace/write-probe && test ! -e /var/run/docker.sock && ! touch /root-filesystem-probe 2>/dev/null && bun --version && codex --version && claude --version && work help >/dev/null',
			],
		}),
		120_000,
	)
	const removed = await cleanupContainer(input.isolation, name)
	await rm(deniedCanary, { force: true })
	if (result.status !== 0 || !removed) {
		return false
	}
	const versions = result.stdout.trim().split('\n')
	return (
		versions[0] === CONTAINER_BUN_VERSION &&
		allowlistedVersion('codex', versions[1] ?? '') === `codex-cli ${CONTAINER_CODEX_VERSION}` &&
		allowlistedVersion('claude', versions[2] ?? '') ===
			`${CONTAINER_CLAUDE_VERSION} (Claude Code)` &&
		(await pathIsAbsent(join(workspace, 'missing-probe')))
	)
}

const isolatedRuntimeProbe = async (input: {
	readonly isolation: DockerIsolation
	readonly workspace: string
	readonly runtimeHome: string
	readonly runtime: RuntimeName
	readonly arguments: readonly string[]
	readonly label: string
}): Promise<{ readonly status: number | null; readonly stdout: string }> => {
	const name = `work-contract-${input.label}-${randomUUID().slice(0, 8)}`
	await Promise.all([
		assertCanonicalDirectory(input.workspace),
		assertCanonicalDirectory(input.runtimeHome),
	])
	activeContainers.add(name)
	const result = dockerSync(
		input.isolation.executable,
		dockerContainerArguments({
			isolation: input.isolation,
			name,
			workspace: input.workspace,
			runtimeHome: input.runtimeHome,
			runtime: input.runtime,
			runId: 'preflight',
			command: input.runtime,
			arguments: input.arguments,
		}),
		30_000,
	)
	const removed = await cleanupContainer(input.isolation, name)
	return removed ? result : { status: null, stdout: '' }
}

const eventToolCount = (line: string): number => {
	const event = parseJsonRecord(line)
	if (event === undefined) {
		return 0
	}
	if (event.type === 'item.completed') {
		const item = isRecord(event.item) ? event.item : undefined
		return ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(
			typeof item?.type === 'string' ? item.type : '',
		)
			? 1
			: 0
	}
	if (event.type === 'assistant') {
		const message = isRecord(event.message) ? event.message : undefined
		const content = Array.isArray(message?.content) ? message.content : []
		return content.filter((block) => isRecord(block) && block.type === 'tool_use').length
	}
	return 0
}

const runStreamingProcess = async (input: {
	readonly command: string
	readonly argv0?: string
	readonly arguments: readonly string[]
	readonly cwd: string
	readonly environment: NodeJS.ProcessEnv
	readonly stdoutPath: string
	readonly stderrPath: string
}): Promise<ProcessResult> =>
	new Promise((resolvePromise, rejectPromise) => {
		const started = performance.now()
		const child = spawn(input.command, input.arguments, {
			...(input.argv0 === undefined ? {} : { argv0: input.argv0 }),
			cwd: input.cwd,
			env: input.environment,
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		const stdoutCollector = createBoundedLineCollector(AGENT_STREAM_LIMIT_BYTES)
		const stderrCollector = createBoundedLineCollector(AGENT_STREAM_LIMIT_BYTES)
		let toolCalls = 0
		let timedOut = false
		let toolLimitExceeded = false
		let settled = false
		let stopStarted = false
		let groupClosed = false
		let markGroupClosed: (() => void) | undefined
		const groupClose = new Promise<void>((resolveClose) => {
			markGroupClosed = resolveClose
		})
		if (child.pid !== undefined) {
			activeRuntimeGroups.set(child.pid, {
				pid: child.pid,
				closed: groupClose,
				isClosed: () => groupClosed,
			})
		}

		const signalTree = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== 'win32' && child.pid !== undefined) {
					process.kill(-child.pid, signal)
				} else {
					child.kill(signal)
				}
			} catch {
				// The process tree may have already exited between the bound check and signal.
			}
		}
		const stop = () => {
			if (stopStarted) {
				return
			}
			stopStarted = true
			signalTree('SIGTERM')
			setTimeout(() => {
				signalTree('SIGKILL')
			}, 2000).unref()
		}
		const timer = setTimeout(() => {
			timedOut = true
			stop()
		}, AGENT_TIMEOUT_MS)

		child.stdout.on('data', (chunk: Buffer) => {
			const collected = stdoutCollector.append(chunk)
			for (const line of collected.lines) {
				toolCalls += eventToolCount(line)
			}
			if (toolCalls > AGENT_TOOL_LIMIT || collected.overflowed) {
				toolLimitExceeded = true
				stop()
			}
		})
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderrCollector.append(chunk).overflowed) {
				toolLimitExceeded = true
				stop()
			}
		})

		const finish = async (exitCode: number | null) => {
			if (settled) {
				return
			}
			settled = true
			clearTimeout(timer)
			const stdoutResult = stdoutCollector.finish()
			const finalToolCount = finalizeToolCount({
				observed: toolCalls,
				pendingLine: stdoutResult.pendingLine,
				maximum: AGENT_TOOL_LIMIT,
				countLine: eventToolCount,
			})
			toolCalls = finalToolCount.toolCalls
			toolLimitExceeded ||= finalToolCount.exceeded
			const stdout = stdoutResult.content
			const stderr = stderrCollector.finish().content
			await Promise.all([
				writeExclusivePrivateFile(dirname(input.stdoutPath), input.stdoutPath, stdout),
				writeExclusivePrivateFile(dirname(input.stderrPath), input.stderrPath, stderr),
			])
			resolvePromise({
				exitCode,
				stdout,
				stderr,
				elapsedMs: Math.round(performance.now() - started),
				timedOut,
				toolLimitExceeded,
			})
		}
		const closeGroup = () => {
			groupClosed = true
			if (child.pid !== undefined) {
				activeRuntimeGroups.delete(child.pid)
			}
			markGroupClosed?.()
		}
		child.on('error', () => {
			closeGroup()
			void finish(null).catch(rejectPromise)
		})
		child.on('exit', () => {
			signalTree('SIGKILL')
		})
		child.on('close', (code) => {
			closeGroup()
			void finish(code).catch(rejectPromise)
		})
	})

const jsonLines = (source: string): Record<string, unknown>[] =>
	source
		.split('\n')
		.map((line) => parseJsonRecord(line))
		.filter((value): value is Record<string, unknown> => value !== undefined)

const firstNumeric = (
	records: readonly Record<string, unknown>[],
	keys: readonly string[],
): number | null => {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index]
		if (record === undefined) {
			continue
		}
		const candidates = [record, isRecord(record.usage) ? record.usage : undefined].filter(
			(value): value is Record<string, unknown> => value !== undefined,
		)
		for (const candidate of candidates) {
			for (const key of keys) {
				const value = nonNegativeMetric(candidate[key])
				if (value !== undefined) {
					return value
				}
			}
		}
	}
	return null
}

const runtimeMetrics = (runtime: RuntimeName, result: ProcessResult): AgentMetrics => {
	const records = jsonLines(result.stdout)
	const resultRecords = records.filter((record) => record.type === 'result')
	const reportedInput = firstNumeric(records, ['input_tokens', 'inputTokens'])
	const cachedInput = firstNumeric(records, [
		'cached_input_tokens',
		'cache_read_input_tokens',
		'cachedInputTokens',
	])
	const inputTokens = inputTokenMetrics({ runtime, reportedInput, cachedInput })
	let reasoning = firstNumeric(records, [
		'reasoning_output_tokens',
		'reasoning_tokens',
		'reasoningTokens',
	])
	if (reasoning === null) {
		for (let index = records.length - 1; index >= 0; index -= 1) {
			const record = records[index]
			const usage = isRecord(record?.usage) ? record.usage : undefined
			const details = isRecord(usage?.output_tokens_details)
				? usage.output_tokens_details
				: undefined
			const thinking = nonNegativeMetric(details?.thinking_tokens)
			if (thinking !== undefined) {
				reasoning = thinking
				break
			}
		}
	}
	const completedTurns = records.filter((record) => record.type === 'turn.completed').length
	let turns: number | null = completedTurns === 0 ? 1 : completedTurns
	if (runtime === 'claude') {
		turns = firstNumeric(resultRecords, ['num_turns'])
	}
	const toolCalls = result.stdout
		.split('\n')
		.reduce((count, line) => count + eventToolCount(line), 0)
	return {
		turns,
		toolCalls,
		tokens: {
			uncachedInput: inputTokens.uncachedInput,
			cachedInput: inputTokens.cachedInput,
			output: firstNumeric(records, ['output_tokens', 'outputTokens']),
			reasoning,
		},
		directCostUsd: firstNumeric(resultRecords, ['total_cost_usd', 'cost_usd']),
	}
}

const agentArguments = (
	runtime: RuntimeName,
	options: LiveEvalOptions,
	prompt: string,
	mode: EvaluationMode,
): readonly string[] => {
	if (runtime === 'codex') {
		return [
			'exec',
			'--ephemeral',
			'--ignore-user-config',
			'--sandbox',
			// Docker is the verified sandbox; nested bubblewrap namespaces are unavailable in the hardened container.
			'danger-full-access',
			'--json',
			'--model',
			options.codexModel,
			'--config',
			`model_reasoning_effort="${options.effort}"`,
			prompt,
		]
	}
	return [
		'--print',
		'--output-format',
		'stream-json',
		'--verbose',
		'--setting-sources',
		'project',
		'--strict-mcp-config',
		'--permission-mode',
		'dontAsk',
		'--allowedTools',
		claudeAllowedTools(mode),
		'--max-budget-usd',
		String(CLAUDE_INVOCATION_CAP_USD),
		'--model',
		options.claudeModel,
		'--effort',
		options.effort,
		'--no-session-persistence',
		prompt,
	]
}

const safeEnvironmentPath = (preflightState: Preflight): string => {
	const paths = [
		dirname(preflightState.executables.bun),
		dirname(preflightState.executables.git),
		'/usr/bin',
		'/bin',
	]
	return [...new Set(paths)].join(':')
}

const packageEntryAllowed = (path: string): boolean =>
	path === 'package/package.json' ||
	path === 'package/README.md' ||
	['package/bin/', 'package/src/', 'package/skills/'].some((prefix) => path.startsWith(prefix))

const BROKEN_SUM_SOURCE =
	'export const sum = (left: number, right: number): number => left - right\n'
const FIXED_SUM_SOURCE =
	'export const sum = (left: number, right: number): number => left + right\n'
const SUM_TEST_SOURCE =
	"import { expect, test } from 'bun:test'\nimport { sum } from '../src/sum'\n\ntest('adds signed numbers', () => {\n\texpect(sum(7, -2)).toBe(5)\n})\n"
const HIERARCHY_FEEDBACK_MESSAGE =
	'docs/fixture-guidance.md incorrectly says completion accepts only --actor; generated help requires role and session assertions.'
const HIERARCHY_PROMPTS = {
	handoff:
		'Use the installed work skill. Start ISSUE-1 as codex-handoff with role coder and session codex-handoff-1, follow the returned next actions, write handoff.md, then hand it off with matching role/session assertions and release it. Do not edit implementation files.',
	continuation:
		'Use the installed work skill. Start ISSUE-1 from its durable handoff as claude-hierarchy, role coder, session claude-hierarchy-1. Repair src/sum.ts. Run exactly `bun test` once as the standalone oracle, without pipes or redirection. The evidence directory already exists; use the file-write tool to write a short durable result to evidence/test.txt. Honor the issue feedback requirement exactly once, then complete with matching actor/role/session and test evidence. Finally start the newly ready ISSUE-2 under the same actor, role, and session before stopping. Do not inspect permission configuration or try alternate shell forms.',
	conflict:
		'Use the installed work skill. Attempt to start ISSUE-2 as codex-conflict with role coder and session codex-conflict-1. On the expected ownership conflict, do not bypass or mutate ledger files; stop and report the structured conflict.',
	recovery:
		'Use the installed work skill. Start ISSUE-2 as codex-recovery with role coder and session codex-recovery-1, follow the returned next actions, run its oracle, write its declared evidence, and complete with matching role/session assertions.',
} as const

const writeRepairFixture = async (root: string) => {
	await Promise.all([
		mkdir(join(root, 'src'), { recursive: true }),
		mkdir(join(root, 'tests'), { recursive: true }),
		mkdir(join(root, 'evidence'), { recursive: true }),
	])
	await Promise.all([
		writeFile(
			join(root, 'package.json'),
			`${JSON.stringify({ name: 'work-contract-live-fixture', private: true, type: 'module', scripts: { work: '/usr/local/bin/work' } }, null, 2)}\n`,
		),
		writeFile(join(root, '.gitignore'), 'node_modules\n.beads\n.work/lock.json\n.work/telemetry\n'),
		writeFile(join(root, 'src/sum.ts'), BROKEN_SUM_SOURCE),
		writeFile(join(root, 'tests/sum.test.ts'), SUM_TEST_SOURCE),
		writeFile(join(root, 'evidence/.gitkeep'), ''),
	])
}

const runGit = (controller: EvalController, arguments_: readonly string[], root: string) =>
	runSync(
		controller.gitBinary,
		safeGitArguments(arguments_),
		root,
		safeGitEnvironment(controller.environment),
		false,
	)

const initializeGit = (controller: EvalController, root: string) => {
	runGit(controller, ['init', '--quiet'], root)
	runGit(controller, ['config', 'user.email', 'work-contract-eval@example.invalid'], root)
	runGit(controller, ['config', 'user.name', 'Work Contract Eval'], root)
}

const commitFixture = (controller: EvalController, root: string) => {
	runGit(controller, ['add', '.'], root)
	runGit(controller, ['commit', '--quiet', '-m', 'eval fixture'], root)
}

const copyBeadsNativeWhenNeeded = async (consumerRoot: string) => {
	const nativeName = process.platform === 'win32' ? 'bd.exe' : 'bd'
	const target = join(consumerRoot, 'node_modules/@beads/bd/bin', nativeName)
	try {
		await access(target)
	} catch {
		const source = join(packageRoot, 'node_modules/@beads/bd/bin', nativeName)
		await copyFile(source, target)
		if (process.platform !== 'win32') {
			await chmod(target, 0o755)
		}
	}
}

const installCandidate = async (
	root: string,
	tarball: string,
	bunBinary: string,
	environmentPath: string,
	environment: Readonly<Record<string, string>>,
) => {
	runSync(
		bunBinary,
		['add', '--no-env-file', '--offline', '--ignore-scripts', tarball],
		root,
		{ ...environment, PATH: environmentPath },
		false,
	)
	await copyBeadsNativeWhenNeeded(root)
	const binary = join(root, 'node_modules/.bin/work')
	const workPath = `${join(root, 'node_modules/.bin')}:${environmentPath}`
	return { binary, workPath }
}

const createEvalController = async (input: {
	readonly root: string
	readonly tarball: string
	readonly environmentPath: string
	readonly bunBinary: string
	readonly gitBinary: string
	readonly isolation?: DockerIsolation
}): Promise<EvalController> => {
	await Promise.all([
		mkdir(input.root, { recursive: true, mode: 0o700 }),
		mkdir(join(input.root, 'home'), { recursive: true, mode: 0o700 }),
		mkdir(join(input.root, 'tmp'), { recursive: true, mode: 0o700 }),
	])
	await writeFile(
		join(input.root, 'package.json'),
		`${JSON.stringify({ name: 'work-contract-eval-controller', private: true })}\n`,
		{ mode: 0o600 },
	)
	const bootstrapEnvironment = sanitizedControllerEnvironment({
		source: processEnvironment,
		home: join(input.root, 'home'),
		path: input.environmentPath,
		temporaryDirectory: join(input.root, 'tmp'),
	})
	const installed = await installCandidate(
		input.root,
		input.tarball,
		input.bunBinary,
		input.environmentPath,
		bootstrapEnvironment,
	)
	const candidateRoot = realpathSync(join(input.root, 'node_modules'))
	return {
		root: input.root,
		binary: realpathSync(installed.binary),
		bunBinary: input.bunBinary,
		gitBinary: input.gitBinary,
		candidateRoot,
		candidateFingerprint: fingerprintTree(candidateRoot),
		...(input.isolation === undefined ? {} : { isolation: input.isolation }),
		runtimeHome: join(input.root, 'home'),
		environment: sanitizedControllerEnvironment({
			source: processEnvironment,
			home: join(input.root, 'home'),
			path: installed.workPath,
			temporaryDirectory: join(input.root, 'tmp'),
		}),
	}
}

const repairIssue = `---
id: ISSUE-1
roles: [coder]
evidence: [test]
---

# ISSUE-1 Repair signed addition

Correct \`src/sum.ts\` so \`sum\` adds both operands. Run \`bun test\`, write a concise
successful test receipt to \`evidence/test.txt\`, and complete the work with that
repository-relative \`test\` evidence. Do not change the test.

## Acceptance Criteria

- Signed addition is correct.
- The declared test passes.
- Completion retains the claiming actor, role, and session.
`

const createFixture = async (input: {
	readonly fixtureRoot: string
	readonly mode: EvaluationMode
	readonly tarball: string
	readonly environmentPath: string
	readonly controller: EvalController
}): Promise<Fixture> => {
	await mkdir(input.fixtureRoot, { recursive: true, mode: 0o700 })
	await writeRepairFixture(input.fixtureRoot)
	initializeGit(input.controller, input.fixtureRoot)
	if (input.mode === 'native') {
		commitFixture(input.controller, input.fixtureRoot)
		return {
			root: input.fixtureRoot,
			baselineStatus: gitChangedPaths(input.controller, input.fixtureRoot).join('\n'),
			baselineTelemetryCount: 0,
			isWorkMode: false,
		}
	}
	await establishWorkFixtureBoundary(input.fixtureRoot)
	await installCandidate(
		input.fixtureRoot,
		input.tarball,
		input.controller.bunBinary,
		input.environmentPath,
		input.controller.environment,
	)
	runController(input.controller, ['--json', 'init', '--project', 'evalpilot'], input.fixtureRoot)
	await writeFile(join(input.fixtureRoot, '.work/items/ISSUE-1.md'), repairIssue)
	runController(input.controller, ['--json', 'sync', '--apply'], input.fixtureRoot)
	runController(input.controller, ['--json', 'skill', 'install'], input.fixtureRoot)
	runController(input.controller, ['--json', 'telemetry', 'enable'], input.fixtureRoot)
	commitFixture(input.controller, input.fixtureRoot)
	const baselineTelemetryConfig = await readBoundedRegularUtf8(
		join(input.fixtureRoot, '.work/telemetry/config.json'),
		4096,
		input.fixtureRoot,
	)
	if (baselineTelemetryConfig === undefined) {
		throw new Error('Evaluation fixture telemetry configuration is unavailable.')
	}
	return {
		root: input.fixtureRoot,
		baselineStatus: gitChangedPaths(input.controller, input.fixtureRoot).join('\n'),
		baselineTelemetryCount: await telemetryCount(input.fixtureRoot),
		baselineTelemetryConfig,
		isWorkMode: true,
	}
}

const readBoundedRegularUtf8 = async (
	path: string,
	maxBytes: number,
	boundaryRoot?: string,
): Promise<string | undefined> =>
	readBoundedContainedUtf8(boundaryRoot ?? dirname(path), path, maxBytes)

const safeDirectoryEntries = async (root: string, path: string): Promise<readonly string[]> =>
	readContainedDirectoryEntries(root, path, 20_000)

const gitChangedPaths = (controller: EvalController, root: string): readonly string[] => {
	const result = spawnSync(
		controller.gitBinary,
		safeGitArguments(['status', '--porcelain=v1', '--untracked-files=all']),
		{
			cwd: root,
			encoding: 'utf8',
			env: safeGitEnvironment(controller.environment),
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		},
	)
	if (result.status !== 0) {
		throw new Error('Trusted Git status failed while scoring the evaluation fixture.')
	}
	return (result.stdout ?? '')
		.split('\n')
		.filter((line) => line.length > 3)
		.map((line) => line.slice(3))
}

const pathIsAbsent = async (path: string): Promise<boolean> =>
	access(path).then(
		() => false,
		() => true,
	)

const removeAndVerify = async (path: string): Promise<boolean> => {
	try {
		await rm(path, { force: true, recursive: true })
		return await pathIsAbsent(path)
	} catch {
		return false
	}
}

/** @description Removes reproducible package installs from retained failed fixtures. */
const pruneRetainedFixtureDependencies = async (fixtureRoot: string): Promise<boolean> => {
	let entries: readonly string[]
	try {
		entries = await safeDirectoryEntries(fixtureRoot, fixtureRoot)
	} catch {
		return false
	}
	const results = await Promise.all(
		entries.map(async (name) => removeAndVerify(join(fixtureRoot, name, 'node_modules'))),
	)
	return results.every(Boolean)
}

const ledgerClosed = async (
	controller: EvalController,
	fixture: Fixture,
	expected: { readonly actor: string; readonly role: string; readonly session: string },
): Promise<boolean> => {
	if (!fixture.isWorkMode) {
		return true
	}
	try {
		const shown = parseJsonRecord(
			runController(controller, ['--json', 'show', 'ISSUE-1'], fixture.root).stdout,
		)
		const value = isRecord(shown?.value) ? shown.value : undefined
		const operation = isRecord(value?.operation) ? value.operation : undefined
		const activity = isRecord(operation?.activity) ? operation.activity : undefined
		const evidence: readonly unknown[] = Array.isArray(operation?.evidence)
			? operation.evidence
			: []
		const evidenceSource = await readBoundedRegularUtf8(
			join(fixture.root, 'evidence/test.txt'),
			16_384,
			fixture.root,
		)
		const receipt = evidence.find((item) =>
			evidenceReceiptAccepted({
				receipt: item,
				expectedReference: 'evidence/test.txt',
				actualSource: evidenceSource ?? '',
			}),
		)
		return (
			operation?.status === 'closed' &&
			activity?.actor === expected.actor &&
			activity.role === expected.role &&
			activity.session === expected.session &&
			evidenceSource !== undefined &&
			evidenceSource.trim().length > 0 &&
			receipt !== undefined
		)
	} catch {
		return false
	}
}

const oraclePasses = async (controller: EvalController, fixture: Fixture): Promise<boolean> => {
	try {
		const [source, test] = await Promise.all([
			readBoundedRegularUtf8(join(fixture.root, 'src/sum.ts'), 4096, fixture.root),
			readBoundedRegularUtf8(join(fixture.root, 'tests/sum.test.ts'), 4096, fixture.root),
		])
		if (source !== FIXED_SUM_SOURCE || test !== SUM_TEST_SOURCE) {
			return false
		}
		const changed = gitChangedPaths(controller, fixture.root)
		const allowed = new Set(
			fixture.isWorkMode ? ['src/sum.ts', 'evidence/test.txt'] : ['src/sum.ts'],
		)
		if (changed.some((path) => !allowed.has(path)) || !changed.includes('src/sum.ts')) {
			return false
		}
		if (!fixture.isWorkMode) {
			const [workAbsent, beadsAbsent] = await Promise.all([
				pathIsAbsent(join(fixture.root, '.work')),
				pathIsAbsent(join(fixture.root, '.beads')),
			])
			return workAbsent && beadsAbsent
		}
		const evidence = await readBoundedRegularUtf8(
			join(fixture.root, 'evidence/test.txt'),
			16_384,
			fixture.root,
		)
		if (evidence === undefined) {
			return false
		}
		return evidence.trim().length > 0 && Buffer.byteLength(evidence, 'utf8') <= 16_384
	} catch {
		return false
	}
}

const trialTelemetryAccepted = async (input: {
	readonly fixture: Fixture
	readonly runId: string
	readonly actor: string
	readonly session: string
}): Promise<boolean> => {
	if (!input.fixture.isWorkMode) {
		return true
	}
	try {
		const source = await readBoundedRegularUtf8(
			join(input.fixture.root, '.work/telemetry/events.jsonl'),
			5_000_000,
			input.fixture.root,
		)
		if (source === undefined) {
			return false
		}
		const events = jsonLines(source)
		const configSource = input.fixture.baselineTelemetryConfig
		const config = configSource === undefined ? undefined : parseJsonRecord(configSource)
		const salt = config?.correlationSalt
		const expectedRunCorrelation =
			typeof salt === 'string' && /^[a-f0-9]{64}$/.test(salt)
				? createHmac('sha256', salt).update(`run\0${input.runId}`).digest('hex')
				: undefined
		const currentConfig = await readBoundedRegularUtf8(
			join(input.fixture.root, '.work/telemetry/config.json'),
			4096,
			input.fixture.root,
		)
		return (
			expectedRunCorrelation !== undefined &&
			currentConfig === configSource &&
			events.some((event) => event.runCorrelation === expectedRunCorrelation) &&
			![input.runId, input.actor, input.session, 'ISSUE-1', input.fixture.root].some((value) =>
				source.includes(value),
			)
		)
	} catch {
		return false
	}
}

const promptFor = (runtime: RuntimeName, mode: EvaluationMode, pair: number): string =>
	mode === 'work'
		? `Use the installed work skill to start ISSUE-1 as ${runtime}-pair-${pair}, role coder, session ${runtime}-pair-${pair}-session. Follow the returned next actions, the issue's bounded scope, and its evidence contract through completion.`
		: `Repair the issue below and run its test oracle. Do not use any work-management skill, ledger, or work binary.\n\n${repairIssue}`

const budgetExhausted = (result: ProcessResult): boolean =>
	/max(?:imum)? budget|budget (?:has been )?exhausted|cost limit/i.test(
		`${result.stdout}\n${result.stderr}`,
	)

const runAgent = async (input: {
	readonly runtime: RuntimeName
	readonly mode: EvaluationMode
	readonly options: LiveEvalOptions
	readonly fixture: Fixture
	readonly prompt: string
	readonly rawRoot: string
	readonly label: string
	readonly runId: string
	readonly claudeBudget: ClaudeBudgetState
	readonly isolation: DockerIsolation
}): Promise<{ readonly process: ProcessResult; readonly metrics: AgentMetrics }> => {
	if (input.runtime === 'claude') {
		reserveClaudeBudget({
			spentUsd: input.claudeBudget.spentUsd,
			budgetUsd: input.options.claudeBudgetUsd,
			invocationCapUsd: CLAUDE_INVOCATION_CAP_USD,
		})
	}
	const artifactRoot = resolve(input.rawRoot, '..')
	const homes: RuntimeHomes = {
		codex: join(artifactRoot, 'runtime-homes/codex'),
		claude: join(artifactRoot, 'runtime-homes/claude'),
	}
	const runtimeHome = homes[input.runtime]
	await Promise.all([
		assertCanonicalDirectory(input.fixture.root),
		assertCanonicalDirectory(runtimeHome),
	])
	const name = `work-contract-${input.label}-${randomUUID().slice(0, 8)}`.slice(0, 128)
	activeContainers.add(name)
	let processResult: ProcessResult | undefined
	let executionError: unknown
	try {
		processResult = await runStreamingProcess({
			command: input.isolation.executable,
			argv0: 'docker',
			arguments: dockerContainerArguments({
				isolation: input.isolation,
				name,
				workspace: input.fixture.root,
				runtimeHome,
				runtime: input.runtime,
				runId: input.runId,
				command: input.runtime,
				arguments: agentArguments(input.runtime, input.options, input.prompt, input.mode),
			}),
			cwd: repositoryRoot,
			environment: processEnvironment,
			stdoutPath: join(input.rawRoot, `${input.label}.stdout.jsonl`),
			stderrPath: join(input.rawRoot, `${input.label}.stderr.txt`),
		})
	} catch (error: unknown) {
		executionError = error
	}
	if (!(await cleanupContainer(input.isolation, name))) {
		throw new Error('Docker runtime cleanup could not prove container termination.')
	}
	if (executionError !== undefined) {
		throw executionError instanceof Error
			? executionError
			: new Error('Docker runtime execution failed.')
	}
	if (processResult === undefined) {
		throw new Error('Docker runtime ended without a process result.')
	}
	const metrics = runtimeMetrics(input.runtime, processResult)
	if (input.runtime === 'claude') {
		input.claudeBudget.spentUsd += metrics.directCostUsd ?? CLAUDE_INVOCATION_CAP_USD
	}
	return { process: processResult, metrics }
}

const executeTrial = async (input: {
	readonly runtime: RuntimeName
	readonly mode: EvaluationMode
	readonly pair: number
	readonly order: number
	readonly attempt: number
	readonly options: LiveEvalOptions
	readonly fixtureRoot: string
	readonly rawRoot: string
	readonly tarball: string
	readonly environmentPath: string
	readonly runId: string
	readonly claudeBudget: ClaudeBudgetState
	readonly controller: EvalController
	readonly isolation: DockerIsolation
}): Promise<TrialReport> => {
	const fixture = await createFixture({
		fixtureRoot: input.fixtureRoot,
		mode: input.mode,
		tarball: input.tarball,
		environmentPath: input.environmentPath,
		controller: input.controller,
	})
	const prompt = promptFor(input.runtime, input.mode, input.pair)
	const label = `${input.runtime}-pair-${input.pair}-${input.mode}-attempt-${input.attempt}`
	const run = await runAgent({
		runtime: input.runtime,
		mode: input.mode,
		options: input.options,
		fixture,
		prompt,
		rawRoot: input.rawRoot,
		label,
		runId: input.runId,
		claudeBudget: input.claudeBudget,
		isolation: input.isolation,
	})
	const oracleAccepted = await oraclePasses(input.controller, fixture)
	const expectedActor = `${input.runtime}-pair-${input.pair}`
	const expectedSession = `${input.runtime}-pair-${input.pair}-session`
	const telemetryAccepted = await trialTelemetryAccepted({
		fixture,
		runId: input.runId,
		actor: expectedActor,
		session: expectedSession,
	})
	const ledgerAccepted =
		(await ledgerClosed(input.controller, fixture, {
			actor: expectedActor,
			role: 'coder',
			session: expectedSession,
		})) && telemetryAccepted
	const currentStatus = gitChangedPaths(input.controller, fixture.root).join('\n')
	const telemetryChanged = (await telemetryCount(fixture.root)) !== fixture.baselineTelemetryCount
	const classified = classifyRuntimeResult({
		exitCode: run.process.exitCode,
		timedOut: run.process.timedOut || run.process.toolLimitExceeded,
		budgetExhausted: budgetExhausted(run.process),
		oracleAccepted,
		ledgerAccepted,
		durableEffects: currentStatus !== fixture.baselineStatus || telemetryChanged || ledgerAccepted,
	})
	const report: TrialReport = {
		runtime: input.runtime,
		mode: input.mode,
		pair: input.pair,
		order: input.order,
		attempt: input.attempt,
		accepted: classified.accepted,
		classification: classified.classification,
		runtimeExitCode: run.process.exitCode,
		timedOut: run.process.timedOut,
		toolLimitExceeded: run.process.toolLimitExceeded,
		budgetExhausted: budgetExhausted(run.process),
		promptBytes: Buffer.byteLength(prompt, 'utf8'),
		turns: run.metrics.turns,
		toolCalls: run.metrics.toolCalls,
		retries: input.attempt - 1,
		elapsedMs: run.process.elapsedMs,
		operatorInterventions: 0,
		tokens: run.metrics.tokens,
		directCostUsd: run.metrics.directCostUsd,
		telemetryAccepted,
		...(classified.accepted ? {} : { retainedFixture: relative(repositoryRoot, fixture.root) }),
	}
	if (classified.accepted) {
		await rm(fixture.root, { force: true, recursive: true })
	}
	return report
}

const workValue = (
	controller: EvalController,
	root: string,
	args: readonly string[],
	runId?: string,
) => {
	const record = parseJsonRecord(runController(controller, ['--json', ...args], root, runId).stdout)
	if (record?.ok !== true) {
		throw new Error(`work ${args.join(' ')} did not return success.`)
	}
	return record.value
}

const telemetryCount = async (root: string): Promise<number> => {
	const source = await readBoundedRegularUtf8(
		join(root, '.work/telemetry/events.jsonl'),
		5_000_000,
		root,
	)
	return source?.split('\n').filter((line) => line.length > 0).length ?? 0
}

const hierarchyManifest = `version: 1
project:
  id: evalpilot
sources:
  - kind: prd
    include: .work/prds/*.md
  - kind: issue
    include: .work/issues/*.md
    parentFields: [parent]
    dependencyFields: [depends_on, dependencies]
policies:
  contextMaxBytes: 12000
  staleClaimMinutes: 90
  terminalEvidence: [test]
`

const hierarchyOraclePasses = async (input: {
	readonly controller: EvalController
	readonly fixtureRoot: string
	readonly feedbackFiles: readonly string[]
}): Promise<boolean> => {
	try {
		if (input.feedbackFiles.length !== 1) {
			return false
		}
		const feedbackName = input.feedbackFiles[0]
		if (
			feedbackName === undefined ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(feedbackName)
		) {
			return false
		}
		const [source, test, firstEvidence, secondEvidence, handoff] = await Promise.all([
			readBoundedRegularUtf8(join(input.fixtureRoot, 'src/sum.ts'), 4096, input.fixtureRoot),
			readBoundedRegularUtf8(join(input.fixtureRoot, 'tests/sum.test.ts'), 4096, input.fixtureRoot),
			readBoundedRegularUtf8(
				join(input.fixtureRoot, 'evidence/test.txt'),
				16_384,
				input.fixtureRoot,
			),
			readBoundedRegularUtf8(
				join(input.fixtureRoot, 'evidence/dependent-test.txt'),
				16_384,
				input.fixtureRoot,
			),
			readBoundedRegularUtf8(join(input.fixtureRoot, 'handoff.md'), 16_384, input.fixtureRoot),
		])
		if (
			source !== FIXED_SUM_SOURCE ||
			test !== SUM_TEST_SOURCE ||
			firstEvidence === undefined ||
			firstEvidence.trim().length === 0 ||
			secondEvidence === undefined ||
			secondEvidence.trim().length === 0 ||
			handoff === undefined ||
			handoff.trim().length === 0
		) {
			return false
		}
		const feedbackPath = `.work/feedback/${feedbackName}`
		const required = new Set([
			'src/sum.ts',
			'evidence/test.txt',
			'evidence/dependent-test.txt',
			'handoff.md',
			feedbackPath,
		])
		const changed = gitChangedPaths(input.controller, input.fixtureRoot)
		return (
			changed.every((path) => required.has(path)) &&
			[...required].every((path) => changed.includes(path))
		)
	} catch {
		return false
	}
}

// oxlint-disable-next-line eslint/max-statements, eslint/complexity, eslint/max-lines-per-function -- This private scenario keeps the ordered multi-agent assertions visible in one orchestration boundary.
const runHierarchyConformance = async (input: {
	readonly options: LiveEvalOptions
	readonly fixtureRoot: string
	readonly rawRoot: string
	readonly tarball: string
	readonly environmentPath: string
	readonly runId: string
	readonly claudeBudget: ClaudeBudgetState
	readonly controller: EvalController
	readonly isolation: DockerIsolation
}) => {
	await mkdir(input.fixtureRoot, { recursive: true, mode: 0o700 })
	await writeRepairFixture(input.fixtureRoot)
	initializeGit(input.controller, input.fixtureRoot)
	await establishWorkFixtureBoundary(input.fixtureRoot)
	await installCandidate(
		input.fixtureRoot,
		input.tarball,
		input.controller.bunBinary,
		input.environmentPath,
		input.controller.environment,
	)
	runController(input.controller, ['--json', 'init', '--project', 'evalpilot'], input.fixtureRoot)
	await Promise.all([
		mkdir(join(input.fixtureRoot, '.work/prds'), { recursive: true }),
		mkdir(join(input.fixtureRoot, '.work/issues'), { recursive: true }),
		mkdir(join(input.fixtureRoot, 'docs'), { recursive: true }),
	])
	await Promise.all([
		writeFile(join(input.fixtureRoot, 'work.yaml'), hierarchyManifest),
		writeFile(
			join(input.fixtureRoot, '.work/prds/PRD-1.md'),
			'---\nid: PRD-1\n---\n\n# PRD-1 Repair arithmetic helpers\n',
		),
		writeFile(
			join(input.fixtureRoot, '.work/issues/ISSUE-1.md'),
			`---\nid: ISSUE-1\nparent: PRD-1\nroles: [coder]\nevidence: [test]\n---\n\n# ISSUE-1 Repair addition\n\nRepair src/sum.ts, run bun test, and write evidence/test.txt. Read docs/fixture-guidance.md; if its completion guidance conflicts with generated help, record exactly one docs feedback item with message "${HIERARCHY_FEEDBACK_MESSAGE}", work ID ISSUE-1, actor claude-hierarchy, and session claude-hierarchy-1.\n`,
		),
		writeFile(
			join(input.fixtureRoot, '.work/issues/ISSUE-2.md'),
			`---\nid: ISSUE-2\nparent: PRD-1\ndepends_on: [ISSUE-1]\nroles: [coder]\nevidence: [test]\n---\n\n# ISSUE-2 Verify the dependent repair\n\nRun bun test, write evidence/dependent-test.txt, and complete with that test evidence.\n`,
		),
		writeFile(
			join(input.fixtureRoot, 'docs/fixture-guidance.md'),
			'Completion accepts only --actor; role and session flags are not available.\n',
		),
	])
	runController(input.controller, ['--json', 'sync', '--apply'], input.fixtureRoot)
	runController(input.controller, ['--json', 'skill', 'install'], input.fixtureRoot)
	runController(input.controller, ['--json', 'telemetry', 'enable'], input.fixtureRoot)
	commitFixture(input.controller, input.fixtureRoot)
	const baselineTelemetryConfig = await readBoundedRegularUtf8(
		join(input.fixtureRoot, '.work/telemetry/config.json'),
		4096,
		input.fixtureRoot,
	)
	if (baselineTelemetryConfig === undefined) {
		throw new Error('Hierarchy telemetry configuration is unavailable.')
	}
	const fixture: Fixture = {
		root: input.fixtureRoot,
		baselineStatus: '',
		baselineTelemetryCount: await telemetryCount(input.fixtureRoot),
		baselineTelemetryConfig,
		isWorkMode: true,
	}
	const invocations: { runtime: RuntimeName; label: string; exitCode: number | null }[] = []
	const invoke = async (runtime: RuntimeName, label: string, prompt: string) => {
		const result = await runAgent({
			runtime,
			mode: 'work',
			options: input.options,
			fixture,
			prompt,
			rawRoot: input.rawRoot,
			label,
			runId: input.runId,
			claudeBudget: input.claudeBudget,
			isolation: input.isolation,
		})
		invocations.push({ runtime, label, exitCode: result.process.exitCode })
		return result
	}

	await invoke('codex', 'hierarchy-codex-handoff', HIERARCHY_PROMPTS.handoff)
	const intermediateRollup = workValue(input.controller, input.fixtureRoot, ['rollup', 'PRD-1'])
	await invoke('claude', 'hierarchy-claude-continuation', HIERARCHY_PROMPTS.continuation)
	const afterAdvanceRollup = workValue(input.controller, input.fixtureRoot, ['rollup', 'PRD-1'])
	const conflictBefore = workValue(input.controller, input.fixtureRoot, ['show', 'ISSUE-2'])
	await invoke('codex', 'hierarchy-codex-conflict', HIERARCHY_PROMPTS.conflict)
	const conflictAfterAgent = workValue(input.controller, input.fixtureRoot, ['show', 'ISSUE-2'])
	const controllerConflict = runControllerResult(
		input.controller,
		[
			'--json',
			'claim',
			'ISSUE-2',
			'--actor',
			'codex-conflict',
			'--role',
			'coder',
			'--session',
			'codex-conflict-1',
		],
		input.fixtureRoot,
		input.runId,
	)
	const conflictAfterController = workValue(input.controller, input.fixtureRoot, [
		'show',
		'ISSUE-2',
	])
	const conflictObserved =
		ownershipConflictResultAccepted(controllerConflict) &&
		JSON.stringify(conflictBefore) === JSON.stringify(conflictAfterAgent) &&
		JSON.stringify(conflictBefore) === JSON.stringify(conflictAfterController)
	const recoveryClaim = activeClaimAssertions(conflictAfterController)
	let recoveryReleaseAccepted = true
	if (recoveryClaim !== undefined) {
		recoveryReleaseAccepted =
			runControllerResult(
				input.controller,
				[
					'--json',
					'release',
					'ISSUE-2',
					'--actor',
					recoveryClaim.actor,
					'--role',
					recoveryClaim.role,
					'--session',
					recoveryClaim.session,
					'--reason',
					'Operator-authorized recovery after conflict conformance.',
				],
				input.fixtureRoot,
				input.runId,
			).status === 0
	}
	await invoke('codex', 'hierarchy-codex-recovery', HIERARCHY_PROMPTS.recovery)
	const finalRollup = workValue(input.controller, input.fixtureRoot, ['rollup', 'PRD-1'])
	const feedbackFiles = await safeDirectoryEntries(
		input.fixtureRoot,
		join(input.fixtureRoot, '.work/feedback'),
	)
	const feedbackRecords = await Promise.all(
		feedbackFiles.map(async (name) => {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)) {
				return null
			}
			const source = await readBoundedRegularUtf8(
				join(input.fixtureRoot, '.work/feedback', name),
				4096,
				input.fixtureRoot,
			)
			return source === undefined ? undefined : parseJsonRecord(source)
		}),
	)
	const invalidProbe = runControllerResult(
		input.controller,
		['complete', '--private-eval-flag'],
		input.fixtureRoot,
		`${input.runId}-parser`,
	)
	const countBeforeDisable = await telemetryCount(input.fixtureRoot)
	workValue(input.controller, input.fixtureRoot, ['telemetry', 'disable'])
	const countAfterDisable = await telemetryCount(input.fixtureRoot)
	workValue(input.controller, input.fixtureRoot, ['doctor'])
	const countAfterDoctor = await telemetryCount(input.fixtureRoot)
	workValue(input.controller, input.fixtureRoot, ['telemetry', 'enable'])
	const countAfterEnable = await telemetryCount(input.fixtureRoot)
	const telemetrySource =
		(await readBoundedRegularUtf8(
			join(input.fixtureRoot, '.work/telemetry/events.jsonl'),
			5_000_000,
			input.fixtureRoot,
		)) ?? ''
	const telemetryConfigSource = await readBoundedRegularUtf8(
		join(input.fixtureRoot, '.work/telemetry/config.json'),
		4096,
		input.fixtureRoot,
	)
	const telemetryConfig =
		telemetryConfigSource === undefined ? undefined : parseJsonRecord(telemetryConfigSource)
	const correlationSalt = telemetryConfig?.correlationSalt
	const expectedParserRunCorrelation =
		typeof correlationSalt === 'string' && /^[a-f0-9]{64}$/.test(correlationSalt)
			? createHmac('sha256', correlationSalt).update(`run\0${input.runId}-parser`).digest('hex')
			: undefined
	const telemetryEvents = jsonLines(telemetrySource)
	const parserEvent = telemetryEvents.find(
		(event) => event.command === 'complete' && event.failureStage === 'arguments',
	)
	const forbidden = [
		'private-eval-flag',
		input.fixtureRoot,
		input.runId,
		processEnvironment.HOME ?? '',
		'Completion accepts only --actor',
		'ISSUE-1',
		'ISSUE-2',
		'codex-handoff',
		'claude-hierarchy',
		'codex-recovery',
		'codex-conflict',
		'codex-handoff-1',
		'claude-hierarchy-1',
		'codex-recovery-1',
		'codex-conflict-1',
		'coder',
		HIERARCHY_FEEDBACK_MESSAGE,
	]
	const telemetryPrivate = forbidden.some(
		(value) => value.length > 0 && telemetrySource.includes(value),
	)
	const intermediateRecord = isRecord(intermediateRollup) ? intermediateRollup : undefined
	const advancedRecord = isRecord(afterAdvanceRollup) ? afterAdvanceRollup : undefined
	const finalRecord = isRecord(finalRollup) ? finalRollup : undefined
	const firstFinal = workValue(input.controller, input.fixtureRoot, ['show', 'ISSUE-1'])
	const secondFinal = workValue(input.controller, input.fixtureRoot, ['show', 'ISSUE-2'])
	const firstOperation =
		isRecord(firstFinal) && isRecord(firstFinal.operation) ? firstFinal.operation : undefined
	const secondOperation =
		isRecord(secondFinal) && isRecord(secondFinal.operation) ? secondFinal.operation : undefined
	const [firstEvidenceSource, secondEvidenceSource] = await Promise.all([
		readBoundedRegularUtf8(join(input.fixtureRoot, 'evidence/test.txt'), 16_384, input.fixtureRoot),
		readBoundedRegularUtf8(
			join(input.fixtureRoot, 'evidence/dependent-test.txt'),
			16_384,
			input.fixtureRoot,
		),
	])
	const finalOperationAccepted = (
		operation: Record<string, unknown> | undefined,
		actor: string,
		session: string,
		reference: string,
		actualSource: string | undefined,
	): boolean => {
		const activity = isRecord(operation?.activity) ? operation.activity : undefined
		const evidence = Array.isArray(operation?.evidence) ? operation.evidence : []
		return (
			actualSource !== undefined &&
			operation?.status === 'closed' &&
			activity?.actor === actor &&
			activity.role === 'coder' &&
			activity.session === session &&
			evidence.some((item) =>
				evidenceReceiptAccepted({ receipt: item, expectedReference: reference, actualSource }),
			)
		)
	}
	const hierarchyOracleAccepted = await hierarchyOraclePasses({
		controller: input.controller,
		fixtureRoot: input.fixtureRoot,
		feedbackFiles,
	})
	const accepted =
		invocations.every(({ exitCode }) => exitCode === 0) &&
		hierarchyOracleAccepted &&
		conflictObserved &&
		recoveryReleaseAccepted &&
		feedbackRecords.length === 1 &&
		feedbackRecords[0]?.schemaVersion === 1 &&
		feedbackRecords[0]?.kind === 'docs' &&
		feedbackRecords[0]?.message === HIERARCHY_FEEDBACK_MESSAGE &&
		feedbackRecords[0]?.workId === 'ISSUE-1' &&
		feedbackRecords[0]?.actor === 'claude-hierarchy' &&
		feedbackRecords[0]?.sessionId === 'claude-hierarchy-1' &&
		typeof feedbackRecords[0]?.id === 'string' &&
		/^[0-9a-f-]{36}$/.test(feedbackRecords[0].id) &&
		invalidProbe.status === 2 &&
		telemetryConfigSource === fixture.baselineTelemetryConfig &&
		expectedParserRunCorrelation !== undefined &&
		parserEvent?.runCorrelation === expectedParserRunCorrelation &&
		!telemetryPrivate &&
		telemetryProbeAccepted({
			afterDisable: countAfterDisable,
			afterDoctor: countAfterDoctor,
			afterEnable: countAfterEnable,
		}) &&
		intermediateRecord?.completed === 0 &&
		intermediateRecord.active === 0 &&
		advancedRecord?.completed === 1 &&
		advancedRecord.active === 1 &&
		finalOperationAccepted(
			firstOperation,
			'claude-hierarchy',
			'claude-hierarchy-1',
			'evidence/test.txt',
			firstEvidenceSource,
		) &&
		finalOperationAccepted(
			secondOperation,
			'codex-recovery',
			'codex-recovery-1',
			'evidence/dependent-test.txt',
			secondEvidenceSource,
		) &&
		finalRecord?.completed === 2 &&
		finalRecord.status === 'completed'
	if (accepted) {
		await rm(input.fixtureRoot, { force: true, recursive: true })
	}
	return {
		accepted,
		invocations,
		intermediateRollup,
		afterAdvanceRollup,
		finalRollup,
		feedbackCount: feedbackFiles.length,
		parserTelemetry: parserEvent !== undefined,
		conflictObserved,
		recoveryReleaseAccepted,
		hierarchyOracleAccepted,
		runCorrelation: parserEvent?.runCorrelation === expectedParserRunCorrelation,
		telemetryPrivate,
		telemetryCounts: {
			beforeDisable: countBeforeDisable,
			afterDisable: countAfterDisable,
			afterDoctor: countAfterDoctor,
			afterEnable: countAfterEnable,
		},
		operatorInterventions: 1,
		...(accepted ? {} : { retainedFixture: relative(repositoryRoot, input.fixtureRoot) }),
	}
}

const markdownReport = (input: {
	readonly runId: string
	readonly preflight: SerializablePreflightSummary
	readonly trials: readonly TrialReport[]
	readonly hierarchy: { readonly accepted: boolean; readonly feedbackCount: number }
	readonly claudeSpentUsd: number
}) => {
	const campaignIntegrityAccepted = campaignAccepted({
		hierarchyAccepted: input.hierarchy.accepted,
		trials: input.trials,
	})
	const workTrials = input.trials.filter((trial) => trial.mode === 'work')
	const nativeTrials = input.trials.filter((trial) => trial.mode === 'native')
	const rows = input.trials
		.map(
			(trial) =>
				`| ${trial.runtime} | ${trial.pair} | ${trial.mode} | ${trial.accepted ? 'yes' : 'no'} | ${trial.classification} | ${trial.elapsedMs} | ${trial.toolCalls} | ${trial.turns ?? 'n/a'} | ${trial.tokens.uncachedInput ?? 'n/a'} | ${trial.tokens.cachedInput ?? 'n/a'} | ${trial.tokens.output ?? 'n/a'} | ${trial.directCostUsd ?? 'n/a'} |`,
		)
		.join('\n')
	return `# Work Contract Live Evaluation ${input.runId}

- Codex: ${input.preflight.codex}
- Claude: ${input.preflight.claude}
- Campaign integrity: ${campaignIntegrityAccepted ? 'accepted' : 'failed'}
- Hierarchical conformance: ${input.hierarchy.accepted ? 'accepted' : 'failed'}
- Work outcomes: ${workTrials.filter((trial) => trial.accepted).length}/${workTrials.length} accepted
- Native outcomes: ${nativeTrials.filter((trial) => trial.accepted).length}/${nativeTrials.length} accepted
- Feedback records: ${input.hierarchy.feedbackCount}
- Accounted Claude exposure: USD ${input.claudeSpentUsd.toFixed(4)}

| Runtime | Pair | Mode | Accepted | Classification | ms | Tools | Turns | Input | Cached | Output | USD |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|
${rows}
`
}

// oxlint-disable-next-line eslint/max-statements, eslint/max-lines-per-function -- The non-shipped campaign entrypoint keeps resource cleanup and scheduling visibly ordered.
const main = async () => {
	const options = parseLiveEvalArguments(argv.slice(2))
	const maximumReservedClaudeUsd = assertClaudeCampaignBudget({
		repetitions: options.repetitions,
		budgetUsd: options.claudeBudgetUsd,
		invocationCapUsd: CLAUDE_INVOCATION_CAP_USD,
	})
	const basePreflightState = preflight()
	const dockerDaemonReady =
		dockerSync(basePreflightState.executables.docker, [
			'version',
			'--format',
			'{{.Server.Version}}',
		]).status === 0
	const isolationCandidate = currentLiveIsolationBackend({
		dockerExecutable: basePreflightState.executables.docker,
		dockerDaemonReady,
	})
	const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
	const artifactBase = await prepareArtifactBase()
	const artifactRoot = await createPrivateDirectoryPath(artifactBase, [runId])
	activeEvalArtifactRoot = artifactRoot
	const [fixtureRoot, rawRoot, packRoot, controllerRoot] = await Promise.all([
		createPrivateDirectoryPath(artifactRoot, ['fixtures']),
		createPrivateDirectoryPath(artifactRoot, ['raw']),
		createPrivateDirectoryPath(artifactRoot, ['package']),
		createPrivateDirectoryPath(artifactRoot, ['controller']),
	])
	const environmentPath = safeEnvironmentPath(basePreflightState)
	runSync(
		basePreflightState.executables.bun,
		['pm', 'pack', '--destination', packRoot, '--quiet'],
		packageRoot,
	)
	const packedEntries = await readdir(packRoot)
	const tarballName = packedEntries.find((name) => name.endsWith('.tgz'))
	if (tarballName === undefined) {
		throw new Error('Package tarball was not produced.')
	}
	const tarball = join(packRoot, tarballName)
	await chmod(tarball, 0o600)
	const packageFiles = runSync(basePreflightState.executables.tar, ['-tf', tarball], packRoot)
		.stdout.split('\n')
		.filter((entry) => entry.length > 0)
		.toSorted()
	if (
		packageFiles.some(
			(path) =>
				!packageEntryAllowed(path) ||
				path.startsWith('package/evals/') ||
				/\.(?:int\.)?test\.[cm]?[jt]sx?$/.test(path),
		)
	) {
		throw new Error('Packed production artifact contains a private or unexpected file.')
	}
	const isolation =
		isolationCandidate.kind === 'container'
			? await buildDockerIsolation({
					artifactRoot,
					tarball,
					executable: basePreflightState.executables.docker,
					runId,
				})
			: undefined
	activeDockerIsolation = isolation
	const isolationVerified =
		isolation === undefined
			? false
			: await verifyDockerIsolation({ isolation, artifactRoot, rawRoot })
	const liveIsolation = {
		...isolationCandidate,
		verified: isolationVerified,
	}
	if (options.confirmLive) {
		assertVerifiedLiveIsolation(liveIsolation)
	}
	let isolatedAuthentication = { codex: false, claude: false }
	if (isolation !== undefined && liveIsolation.verified) {
		sensitiveRuntimeHomeRoot = join(artifactRoot, 'runtime-homes')
		const runtimeHomes = await prepareRuntimeHomes(artifactRoot)
		const probeWorkspace = await createPrivateDirectoryPath(artifactRoot, ['auth-probe-workspace'])
		const isolatedCodexAuth = await isolatedRuntimeProbe({
			isolation,
			workspace: probeWorkspace,
			runtime: 'codex',
			runtimeHome: runtimeHomes.codex,
			arguments: ['login', 'status'],
			label: 'codex-auth',
		})
		const isolatedClaudeAuthProbe = await isolatedRuntimeProbe({
			isolation,
			workspace: probeWorkspace,
			runtime: 'claude',
			runtimeHome: runtimeHomes.claude,
			arguments: ['auth', 'status', '--json'],
			label: 'claude-auth',
		})
		const isolatedClaudeAuth = parseJsonRecord(isolatedClaudeAuthProbe.stdout)
		isolatedAuthentication = {
			codex: isolatedCodexAuth.status === 0,
			claude: isolatedClaudeAuthProbe.status === 0 && isolatedClaudeAuth?.loggedIn === true,
		}
	}
	const preflightState: Preflight = {
		...basePreflightState,
		liveIsolation,
		isolatedAuthentication,
	}
	const liveExecutionReady = livePreflightAccepted({
		authentication: preflightState.isolatedAuthentication ?? { codex: false, claude: false },
		isolation: liveIsolation,
	})
	const persistedPreflight = serializablePreflightSummary(preflightState)
	if (options.confirmLive && !liveExecutionReady) {
		throw new Error(
			'Paid evaluation refused because one or more runtimes cannot authenticate from an isolated home.',
		)
	}
	const controller = await createEvalController({
		root: controllerRoot,
		tarball,
		environmentPath,
		bunBinary: basePreflightState.executables.bun,
		gitBinary: basePreflightState.executables.git,
		...(isolation === undefined ? {} : { isolation }),
	})
	const controllerHelp = runController(controller, ['help'], controller.root).stdout
	assertControllerIntegrity(controller)
	if (!controllerHelp.includes('work claim') || !controllerHelp.includes('work complete')) {
		throw new Error('Evaluation controller help probe did not expose the required commands.')
	}
	const controllerHelpSha256 = createHash('sha256').update(controllerHelp).digest('hex')
	if (options.preflightOnly) {
		const [tarballSource, tarballStats] = await Promise.all([readFile(tarball), stat(tarball)])
		const promptHashes = [
			...new Set(
				[
					...Object.values(HIERARCHY_PROMPTS),
					...(['codex', 'claude'] as const).flatMap((runtime) =>
						Array.from({ length: options.repetitions }, (_, pairIndex) => pairIndex + 1).flatMap(
							(pair) => (['work', 'native'] as const).map((mode) => promptFor(runtime, mode, pair)),
						),
					),
				].map((prompt) => createHash('sha256').update(prompt).digest('hex')),
			),
		]
		const economicsPerRuntime = options.repetitions * 2
		const manifest = {
			schemaVersion: 1,
			mode: 'preflight-only',
			runId,
			createdAt: new Date().toISOString(),
			preflight: persistedPreflight,
			options,
			package: {
				sha256: createHash('sha256').update(tarballSource).digest('hex'),
				bytes: tarballStats.size,
				files: packageFiles,
			},
			controller: {
				helpSha256: controllerHelpSha256,
				candidateSha256: controller.candidateFingerprint,
				isolatedFromFixtures: true,
				environmentKeys: Object.keys(controller.environment).toSorted(),
			},
			campaign: {
				order: ['hierarchy', 'economics'],
				plannedInvocations: {
					codex: 3 + economicsPerRuntime,
					claude: 1 + economicsPerRuntime,
				},
				maximumInfrastructureReplacements: 1,
				maximumClaudeReservedUsd: maximumReservedClaudeUsd,
				promptSha256: promptHashes,
			},
			environmentAllowlist: {
				codex: runtimeEnvironmentAllowlist('codex'),
				claude: runtimeEnvironmentAllowlist('claude'),
			},
			artifacts: {
				permissions: 'private-0600-files-0700-directories',
				successfulFixtures: 'deleted',
				failedFixtures: 'retained-and-referenced',
				cleanupVerified: true,
			},
		}
		const manifestPath = join(artifactRoot, 'preflight.json')
		const cleanupPaths = [
			...(sensitiveRuntimeHomeRoot === undefined ? [] : [sensitiveRuntimeHomeRoot]),
			fixtureRoot,
			rawRoot,
			packRoot,
			controllerRoot,
			join(artifactRoot, 'isolation-build'),
			join(artifactRoot, 'isolation-probe'),
			join(artifactRoot, 'auth-probe-workspace'),
		]
		const imageRemoved = isolation === undefined || cleanupDockerImage(isolation)
		if (imageRemoved) {
			activeDockerIsolation = undefined
		}
		const cleanupResults = await Promise.all(
			cleanupPaths.map(async (path) => removeAndVerify(path)),
		)
		const cleanupAccepted = cleanupResults.every(Boolean) && imageRemoved
		if (!cleanupAccepted) {
			throw new Error('Preflight cleanup could not verify removal of sensitive directories.')
		}
		sensitiveRuntimeHomeRoot = undefined
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
		assertRuntimeQuiescent()
		await secureArtifactTree(artifactRoot)
		console.log(
			JSON.stringify({
				ok: liveExecutionReady,
				preflightOnly: true,
				runId,
				manifest: relative(repositoryRoot, manifestPath),
			}),
		)
		if (!liveExecutionReady) {
			process.exitCode = 1
		}
		activeEvalArtifactRoot = undefined
		return
	}
	const claudeBudget: ClaudeBudgetState = { spentUsd: 0 }
	const trials: TrialReport[] = []
	const replacedAttempts: TrialReport[] = []
	let infrastructureReplacementAvailable = true
	if (isolation === undefined) {
		throw new Error('Live evaluation isolation became unavailable after preflight.')
	}

	const hierarchy = await runHierarchyConformance({
		options,
		fixtureRoot: join(fixtureRoot, 'hierarchy'),
		rawRoot,
		tarball,
		environmentPath,
		runId,
		claudeBudget,
		controller,
		isolation,
	})

	for (const runtime of hierarchy.accepted ? (['codex', 'claude'] as const) : []) {
		for (const [pairIndex, modes] of runtimeOrder(runtime, options.repetitions).entries()) {
			for (const [orderIndex, mode] of modes.entries()) {
				const baseName = `${runtime}-pair-${pairIndex + 1}-${mode}`
				let trial = await executeTrial({
					runtime,
					mode,
					pair: pairIndex + 1,
					order: orderIndex + 1,
					attempt: 1,
					options,
					fixtureRoot: join(fixtureRoot, baseName),
					rawRoot,
					tarball,
					environmentPath,
					runId,
					claudeBudget,
					controller,
					isolation,
				})
				if (
					trial.classification === 'infrastructure_failure' &&
					infrastructureReplacementAvailable
				) {
					infrastructureReplacementAvailable = false
					replacedAttempts.push(trial)
					trial = await executeTrial({
						runtime,
						mode,
						pair: pairIndex + 1,
						order: orderIndex + 1,
						attempt: 2,
						options,
						fixtureRoot: join(fixtureRoot, `${baseName}-replacement`),
						rawRoot,
						tarball,
						environmentPath,
						runId,
						claudeBudget,
						controller,
						isolation,
					})
				}
				trials.push(trial)
			}
		}
	}

	const report = {
		schemaVersion: 1,
		runId,
		createdAt: new Date().toISOString(),
		preflight: persistedPreflight,
		options,
		limits: {
			timeoutMs: AGENT_TIMEOUT_MS,
			toolCalls: AGENT_TOOL_LIMIT,
			streamBytes: AGENT_STREAM_LIMIT_BYTES,
			claudeInvocationUsd: CLAUDE_INVOCATION_CAP_USD,
		},
		trials,
		replacedAttempts,
		hierarchy,
		claudeAccountedExposureUsd: claudeBudget.spentUsd,
		cleanupVerified: true,
	}
	if (!(await pruneRetainedFixtureDependencies(fixtureRoot))) {
		throw new Error('Campaign could not prune reproducible failed-fixture dependencies.')
	}
	const cleanupPaths = [
		...(sensitiveRuntimeHomeRoot === undefined ? [] : [sensitiveRuntimeHomeRoot]),
		packRoot,
		controllerRoot,
		join(artifactRoot, 'isolation-build'),
		join(artifactRoot, 'isolation-probe'),
		join(artifactRoot, 'auth-probe-workspace'),
	]
	const imageRemoved = cleanupDockerImage(isolation)
	if (imageRemoved) {
		activeDockerIsolation = undefined
	}
	const cleanupResults = await Promise.all(cleanupPaths.map(async (path) => removeAndVerify(path)))
	const cleanupAccepted = cleanupResults.every(Boolean) && imageRemoved
	if (!cleanupAccepted) {
		throw new Error('Campaign cleanup could not verify removal of sensitive directories.')
	}
	sensitiveRuntimeHomeRoot = undefined
	await Promise.all([
		writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
			mode: 0o600,
		}),
		writeFile(
			join(artifactRoot, 'report.md'),
			markdownReport({
				runId,
				preflight: persistedPreflight,
				trials,
				hierarchy,
				claudeSpentUsd: claudeBudget.spentUsd,
			}),
			{ mode: 0o600 },
		),
	])
	assertRuntimeQuiescent()
	await secureArtifactTree(artifactRoot)
	const accepted = campaignAccepted({ hierarchyAccepted: hierarchy.accepted, trials })
	const workTrials = trials.filter((trial) => trial.mode === 'work')
	const nativeTrials = trials.filter((trial) => trial.mode === 'native')
	console.log(
		JSON.stringify({
			ok: accepted,
			runId,
			report: relative(repositoryRoot, join(artifactRoot, 'report.md')),
			acceptedTrials: trials.filter((trial) => trial.accepted).length,
			totalTrials: trials.length,
			workAcceptedTrials: workTrials.filter((trial) => trial.accepted).length,
			workTotalTrials: workTrials.length,
			nativeAcceptedTrials: nativeTrials.filter((trial) => trial.accepted).length,
			nativeTotalTrials: nativeTrials.length,
			hierarchyAccepted: hierarchy.accepted,
			claudeAccountedExposureUsd: claudeBudget.spentUsd,
		}),
	)
	if (!accepted) {
		process.exitCode = 1
	}
	activeEvalArtifactRoot = undefined
}

const run = (): void => {
	void main().catch(async (error: unknown) => {
		const shutdown = await shutdownAllRuntimeResources()
		let imageRemoved = activeDockerIsolation === undefined
		if (activeDockerIsolation !== undefined) {
			imageRemoved = cleanupDockerImage(activeDockerIsolation)
			if (imageRemoved) {
				activeDockerIsolation = undefined
			}
		}
		if (activeEvalArtifactRoot !== undefined) {
			const failureRoot = activeEvalArtifactRoot
			const [fixturesRemoved, rawRemoved, packageRemoved, controllerRemoved] = await Promise.all([
				removeAndVerify(join(failureRoot, 'fixtures')),
				removeAndVerify(join(failureRoot, 'raw')),
				removeAndVerify(join(failureRoot, 'package')),
				removeAndVerify(join(failureRoot, 'controller')),
			])
			await writeFile(
				join(failureRoot, 'failure.json'),
				`${JSON.stringify({
					schemaVersion: 1,
					failedAt: new Date().toISOString(),
					status: 'driver-failure',
					credentialsRemoved: shutdown.credentialsRemoved,
					processesTerminated: shutdown.processesTerminated,
					containersTerminated: shutdown.containersTerminated,
					imageRemoved,
					fixturesRemoved,
					rawRemoved,
					packageRemoved,
					controllerRemoved,
				})}\n`,
				{ mode: 0o600 },
			).catch(() => false)
			if (
				shutdown.processesTerminated &&
				shutdown.containersTerminated &&
				shutdown.credentialsRemoved
			) {
				assertRuntimeQuiescent()
				await secureArtifactTree(failureRoot).catch(() => false)
			}
			activeEvalArtifactRoot = undefined
		}
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}

const waitMilliseconds = async (milliseconds: number): Promise<void> =>
	new Promise((resolveWait) => {
		setTimeout(resolveWait, milliseconds)
	})

const cleanupRuntimeCredentials = async (): Promise<boolean> => {
	if (sensitiveRuntimeHomeRoot === undefined) {
		return true
	}
	const root = sensitiveRuntimeHomeRoot
	sensitiveRuntimeHomeRoot = undefined
	return removeAndVerify(root)
}

const cleanupActiveContainers = async (): Promise<boolean> => {
	if (activeDockerIsolation === undefined) {
		return activeContainers.size === 0
	}
	const isolation = activeDockerIsolation
	const results = await Promise.all(
		[...activeContainers].map(async (name) => cleanupContainer(isolation, name)),
	)
	return results.every(Boolean) && activeContainers.size === 0
}

const shutdownAllRuntimeResources = async (): Promise<{
	readonly processesTerminated: boolean
	readonly containersTerminated: boolean
	readonly credentialsRemoved: boolean
}> => {
	const containersTerminated = await cleanupActiveContainers()
	const local = await shutdownEvalResources({
		groups: [...activeRuntimeGroups.values()],
		killGroup: (pid, childSignal) => {
			process.kill(-pid, childSignal)
		},
		wait: waitMilliseconds,
		cleanupCredentials: cleanupRuntimeCredentials,
		graceMs: 2000,
	})
	return { ...local, containersTerminated }
}

const handleTerminationSignal = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
	if (signalShutdownStarted) {
		return
	}
	signalShutdownStarted = true
	const shutdown = await shutdownAllRuntimeResources()
	if (
		!shutdown.processesTerminated ||
		!shutdown.containersTerminated ||
		!shutdown.credentialsRemoved
	) {
		console.error('Evaluation shutdown could not verify complete runtime isolation cleanup.')
	}
	if (activeDockerIsolation !== undefined && cleanupDockerImage(activeDockerIsolation)) {
		activeDockerIsolation = undefined
	}
	if (activeEvalArtifactRoot !== undefined) {
		const root = activeEvalArtifactRoot
		activeEvalArtifactRoot = undefined
		await removeAndVerify(root)
	}
	// oxlint-disable-next-line unicorn/no-process-exit -- Signal shutdown exits only after process groups and credentials are cleaned.
	process.exit(signal === 'SIGINT' ? 130 : 143)
}

process.once('SIGINT', () => void handleTerminationSignal('SIGINT'))
process.once('SIGTERM', () => void handleTerminationSignal('SIGTERM'))

run()
