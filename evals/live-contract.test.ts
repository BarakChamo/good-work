/**
 * @description Verifies live-evaluation argument, ordering, budget, and scoring contracts.
 *
 * @module work/evals/live-contract
 * @file Live-contract.test.ts
 */

import { describe, expect, it } from 'vitest'

import {
	activeClaimAssertions,
	assertClaudeCampaignBudget,
	createBoundedLineCollector,
	classifyRuntimeResult,
	claudeAllowedTools,
	currentLiveIsolationBackend,
	evidenceReceiptAccepted,
	finalizeToolCount,
	inputTokenMetrics,
	isolatedClaudeCredentials,
	isolatedAuthenticationAccepted,
	livePreflightAccepted,
	maximumClaudeReservedUsd,
	nonNegativeMetric,
	ownershipConflictResultAccepted,
	parseLiveEvalArguments,
	reserveClaudeBudget,
	readBoundedUtf8Handle,
	runtimeOrder,
	serializablePreflightSummary,
	sanitizedControllerEnvironment,
	sanitizedRuntimeEnvironment,
	assertVerifiedLiveIsolation,
	campaignAccepted,
	telemetryProbeAccepted,
} from './live-contract'

describe('live evaluation contract', () => {
	it('extracts only a complete active claim for operator-authorized recovery', () => {
		expect.hasAssertions()
		expect(
			activeClaimAssertions({
				operation: {
					status: 'in_progress',
					activity: { actor: 'agent', role: 'coder', session: 'session-1' },
				},
			}),
		).toStrictEqual({ actor: 'agent', role: 'coder', session: 'session-1' })
		expect(
			activeClaimAssertions({
				operation: {
					status: 'open',
					activity: { actor: 'agent', role: 'coder', session: 'session-1' },
				},
			}),
		).toBeUndefined()
		expect(
			activeClaimAssertions({
				operation: { status: 'in_progress', activity: { actor: 'agent', role: 'coder' } },
			}),
		).toBeUndefined()
	})

	it('selects only bounded Claude account credentials for the isolated runtime home', () => {
		expect.hasAssertions()
		const credentials = isolatedClaudeCredentials({
			claudeAiOauth: {
				accessToken: 'access-token',
				expiresAt: 123,
				rateLimitTier: 'default',
				refreshToken: 'refresh-token',
				refreshTokenExpiresAt: 456,
				scopes: ['user:inference'],
				subscriptionType: 'team',
			},
			mcpOAuth: { untrusted: { accessToken: 'must-not-cross' } },
			organizationUuid: 'organization-id',
		})

		expect(credentials).toStrictEqual({
			claudeAiOauth: {
				accessToken: 'access-token',
				expiresAt: 123,
				rateLimitTier: 'default',
				refreshToken: 'refresh-token',
				refreshTokenExpiresAt: 456,
				scopes: ['user:inference'],
				subscriptionType: 'team',
			},
			organizationUuid: 'organization-id',
		})
		expect(
			isolatedClaudeCredentials({
				claudeAiOauth: {
					accessToken: 'x'.repeat(16_385),
					refreshToken: 'valid',
				},
			}),
		).toBeUndefined()
		expect(isolatedClaudeCredentials({ claudeAiOauth: { accessToken: 'valid' } })).toBeUndefined()
	})

	it('refuses paid execution without a verified OS isolation backend', () => {
		expect.hasAssertions()
		expect(
			currentLiveIsolationBackend({
				dockerExecutable: '/usr/local/bin/docker',
				dockerDaemonReady: true,
			}),
		).toStrictEqual({ kind: 'container', verified: false })
		expect(currentLiveIsolationBackend({ dockerDaemonReady: false })).toStrictEqual({
			kind: 'unavailable',
			verified: false,
		})
		expect(() => {
			assertVerifiedLiveIsolation({ kind: 'unavailable', verified: false })
		}).toThrow(/verified OS isolation backend/)
		expect(() => {
			assertVerifiedLiveIsolation({ kind: 'container', verified: false })
		}).toThrow(/verified OS isolation backend/)
		expect(() => {
			assertVerifiedLiveIsolation({ kind: 'container', verified: true })
		}).not.toThrow()
		expect(
			livePreflightAccepted({
				authentication: { codex: true, claude: true },
				isolation: { kind: 'unavailable', verified: false },
			}),
		).toBe(false)
		expect(
			livePreflightAccepted({
				authentication: { codex: true, claude: true },
				isolation: { kind: 'container', verified: true },
			}),
		).toBe(true)
	})

	it('applies the tool-call limit to the final unterminated event line', () => {
		expect.hasAssertions()
		expect(
			finalizeToolCount({
				observed: 40,
				pendingLine: '{"type":"tool"}',
				maximum: 40,
				countLine: () => 1,
			}),
		).toStrictEqual({ toolCalls: 41, exceeded: true })
		expect(
			finalizeToolCount({
				observed: 39,
				pendingLine: '{"type":"tool"}',
				maximum: 40,
				countLine: () => 1,
			}),
		).toStrictEqual({ toolCalls: 40, exceeded: false })
	})

	it('bounds an oversized unterminated runtime stream and ignores later chunks', () => {
		expect.hasAssertions()
		const collector = createBoundedLineCollector(4)

		const first = collector.append(Buffer.from('abcdefghij'))
		const second = collector.append(Buffer.from('more-data'))
		const finished = collector.finish()

		expect(first).toStrictEqual({ lines: [], overflowed: true })
		expect(second).toStrictEqual({ lines: [], overflowed: true })
		expect(finished).toStrictEqual({ content: 'abcd', pendingLine: 'abcd' })
		expect(Buffer.byteLength(finished.content)).toBe(4)
	})

	it('rejects an eval file that grows after its initial stat', async () => {
		expect.hasAssertions()
		const content = Buffer.from('12345')
		let offset = 0
		await expect(
			readBoundedUtf8Handle(
				{
					read: async (buffer) => {
						const bytesRead = Math.min(buffer.byteLength, content.byteLength - offset)
						buffer.set(content.subarray(offset, offset + bytesRead))
						offset += bytesRead
						return { buffer, bytesRead }
					},
					stat: async () => ({ isFile: () => true, size: 1 }),
				},
				4,
			),
		).resolves.toBeUndefined()
	})

	it('excludes executable and home paths from persisted preflight summaries', () => {
		expect.hasAssertions()
		const homeCanary = '/Users/private-operator/PRIVATE_HOME_CANARY'
		const summary = serializablePreflightSummary({
			bun: '1.3.7',
			git: 'git version 2.50.1',
			codex: 'codex-cli 0.146.0',
			claude: '2.1.251 (Claude Code)',
			executables: {
				bun: `${homeCanary}/bun`,
				git: '/usr/bin/git',
				codex: `${homeCanary}/codex`,
				claude: `${homeCanary}/claude`,
			},
			authentication: { codex: true, claude: true },
			isolatedAuthentication: { codex: true, claude: false },
		})

		expect(summary).toStrictEqual({
			bun: '1.3.7',
			git: 'git version 2.50.1',
			codex: 'codex-cli 0.146.0',
			claude: '2.1.251 (Claude Code)',
			authentication: { codex: true, claude: true },
			isolatedAuthentication: { codex: true, claude: false },
		})
		expect(JSON.stringify(summary)).not.toContain(homeCanary)
	})

	it('requires explicit live confirmation and validates bounded options', () => {
		expect.hasAssertions()
		expect(() => parseLiveEvalArguments([])).toThrow(/--confirm-live|--preflight-only/)
		expect(
			parseLiveEvalArguments([
				'--confirm-live',
				'--repetitions',
				'3',
				'--claude-budget-usd',
				'10',
				'--codex-model',
				'gpt-5.6-sol',
				'--claude-model',
				'sonnet',
				'--effort',
				'medium',
			]),
		).toStrictEqual({
			confirmLive: true,
			preflightOnly: false,
			repetitions: 3,
			claudeBudgetUsd: 10,
			codexModel: 'gpt-5.6-sol',
			claudeModel: 'sonnet',
			effort: 'medium',
		})
		expect(() => parseLiveEvalArguments(['--confirm-live', '--repetitions', '0'])).toThrow(
			/repetitions/,
		)
		expect(() => parseLiveEvalArguments(['--confirm-live', '--unknown'])).toThrow(/Unknown option/)
		expect(() => parseLiveEvalArguments(['--confirm-live', '--repetitions', '1.5'])).toThrow(
			/positive integer/,
		)
		expect(parseLiveEvalArguments(['--preflight-only'])).toMatchObject({
			confirmLive: false,
			preflightOnly: true,
		})
		expect(() => parseLiveEvalArguments(['--confirm-live', '--preflight-only'])).toThrow(
			/mutually exclusive/,
		)
	})

	it('counterbalances paired modes by runtime', () => {
		expect.hasAssertions()
		expect(runtimeOrder('codex', 3)).toStrictEqual([
			['work', 'native'],
			['native', 'work'],
			['work', 'native'],
		])
		expect(runtimeOrder('claude', 3)).toStrictEqual([
			['native', 'work'],
			['work', 'native'],
			['native', 'work'],
		])
	})

	it('gates campaign integrity independently from measured product outcomes', () => {
		expect.hasAssertions()
		expect(
			campaignAccepted({
				hierarchyAccepted: true,
				trials: [
					{ mode: 'work', accepted: true, classification: 'accepted' },
					{ mode: 'native', accepted: false, classification: 'product_failure' },
				],
			}),
		).toBe(true)
		expect(
			campaignAccepted({
				hierarchyAccepted: true,
				trials: [
					{ mode: 'work', accepted: false, classification: 'product_failure' },
					{ mode: 'native', accepted: true, classification: 'accepted' },
				],
			}),
		).toBe(true)
		expect(
			campaignAccepted({
				hierarchyAccepted: true,
				trials: [
					{ mode: 'work', accepted: true, classification: 'accepted' },
					{ mode: 'native', accepted: false, classification: 'infrastructure_failure' },
				],
			}),
		).toBe(false)
		expect(
			campaignAccepted({
				hierarchyAccepted: false,
				trials: [{ mode: 'work', accepted: true, classification: 'accepted' }],
			}),
		).toBe(false)
		expect(campaignAccepted({ hierarchyAccepted: true, trials: [] })).toBe(false)
		expect(
			campaignAccepted({
				hierarchyAccepted: true,
				trials: [{ mode: 'work', accepted: true, classification: 'accepted' }],
			}),
		).toBe(false)
	})

	it('allows Claude to record test evidence without granting broad shell access', () => {
		expect.hasAssertions()
		const work = claudeAllowedTools('work')
		const native = claudeAllowedTools('native')

		expect(work).toContain('Bash(bun test*)')
		expect(work).toContain('Bash(tee /workspace/evidence/*)')
		expect(work).toContain('Bash(bun run work *)')
		expect(work.split(',')).not.toContain('Bash')
		expect(native).not.toContain('tee')
		expect(native).not.toContain('work *')
	})

	it('scores accepted product state independently from runtime exhaustion', () => {
		expect.hasAssertions()
		expect(
			classifyRuntimeResult({
				exitCode: 1,
				timedOut: false,
				budgetExhausted: true,
				oracleAccepted: true,
				ledgerAccepted: true,
				durableEffects: true,
			}),
		).toStrictEqual({
			accepted: true,
			classification: 'runtime_warning',
			replacementAllowed: false,
		})
		expect(
			classifyRuntimeResult({
				exitCode: null,
				timedOut: true,
				budgetExhausted: false,
				oracleAccepted: false,
				ledgerAccepted: false,
				durableEffects: false,
			}),
		).toStrictEqual({
			accepted: false,
			classification: 'infrastructure_failure',
			replacementAllowed: true,
		})
	})

	it('reserves Claude exposure before scheduling', () => {
		expect.hasAssertions()
		expect(reserveClaudeBudget({ spentUsd: 7.5, budgetUsd: 10, invocationCapUsd: 1 })).toBe(8.5)
		expect(() =>
			reserveClaudeBudget({ spentUsd: 9.5, budgetUsd: 10, invocationCapUsd: 1 }),
		).toThrow(/budget/)
		expect(() => reserveClaudeBudget({ spentUsd: -1, budgetUsd: 10, invocationCapUsd: 1 })).toThrow(
			/finite non-negative/,
		)
		expect(() => reserveClaudeBudget({ spentUsd: 0, budgetUsd: 10, invocationCapUsd: -1 })).toThrow(
			/finite positive/,
		)
	})

	it('rejects a campaign budget that cannot cover every planned Claude invocation', () => {
		expect.hasAssertions()
		expect(maximumClaudeReservedUsd(3, 1)).toBe(8)
		expect(assertClaudeCampaignBudget({ repetitions: 3, budgetUsd: 8, invocationCapUsd: 1 })).toBe(
			8,
		)
		expect(() =>
			assertClaudeCampaignBudget({ repetitions: 3, budgetUsd: 7.99, invocationCapUsd: 1 }),
		).toThrow(/cannot cover/)
	})

	it('rejects negative, non-finite, and non-numeric runtime metrics', () => {
		expect.hasAssertions()
		expect(nonNegativeMetric(0)).toBe(0)
		expect(nonNegativeMetric(1.25)).toBe(1.25)
		expect(nonNegativeMetric(-0.01)).toBeUndefined()
		expect(nonNegativeMetric(Number.NaN)).toBeUndefined()
		expect(nonNegativeMetric('1.25')).toBeUndefined()
	})

	it('allows re-enable to record itself but no command while disabled', () => {
		expect.hasAssertions()
		expect(telemetryProbeAccepted({ afterDisable: 33, afterDoctor: 33, afterEnable: 34 })).toBe(
			true,
		)
		expect(telemetryProbeAccepted({ afterDisable: 33, afterDoctor: 34, afterEnable: 35 })).toBe(
			false,
		)
	})

	it('separates Codex total input from cached input', () => {
		expect.hasAssertions()
		expect(
			inputTokenMetrics({ runtime: 'codex', reportedInput: 237_600, cachedInput: 218_880 }),
		).toStrictEqual({ uncachedInput: 18_720, cachedInput: 218_880 })
		expect(
			inputTokenMetrics({ runtime: 'claude', reportedInput: 26, cachedInput: 470_494 }),
		).toStrictEqual({ uncachedInput: 26, cachedInput: 470_494 })
	})

	it('passes only runtime-required host environment into live agent fixtures', () => {
		expect.hasAssertions()
		const source = {
			HOME: '/safe/home',
			LANG: 'en_US.UTF-8',
			CODEX_HOME: '/safe/home/.codex',
			CLAUDE_CONFIG_DIR: '/safe/home/.claude',
			OPENAI_API_KEY: 'codex-auth',
			ANTHROPIC_API_KEY: 'claude-auth',
			DATABASE_URL: 'must-not-cross',
			PRIVATE_REPOSITORY_TOKEN: 'must-not-cross-either',
		}
		expect(
			sanitizedRuntimeEnvironment({
				runtime: 'codex',
				source,
				path: '/fixture/bin',
				runId: 'run-1',
			}),
		).toStrictEqual({
			HOME: '/safe/home',
			LANG: 'en_US.UTF-8',
			CODEX_HOME: '/safe/home/.codex',
			PATH: '/fixture/bin',
			DO_NOT_TRACK: '1',
			WORK_CONTRACT_RUN_ID: 'run-1',
		})
		expect(
			sanitizedRuntimeEnvironment({
				runtime: 'claude',
				source,
				path: '/fixture/bin',
				runId: 'run-2',
			}),
		).toStrictEqual({
			HOME: '/safe/home',
			LANG: 'en_US.UTF-8',
			CLAUDE_CONFIG_DIR: '/safe/home/.claude',
			PATH: '/fixture/bin',
			DO_NOT_TRACK: '1',
			WORK_CONTRACT_RUN_ID: 'run-2',
		})
	})

	it('gives the controller no provider credentials or unrelated host environment', () => {
		expect.hasAssertions()
		expect(
			sanitizedControllerEnvironment({
				source: {
					LANG: 'en_US.UTF-8',
					OPENAI_API_KEY: 'must-not-cross',
					ANTHROPIC_API_KEY: 'must-not-cross',
					DATABASE_URL: 'must-not-cross',
				},
				home: '/controller/home',
				path: '/controller/bin',
				temporaryDirectory: '/controller/tmp',
			}),
		).toStrictEqual({
			HOME: '/controller/home',
			USER: 'work-contract-eval-controller',
			LOGNAME: 'work-contract-eval-controller',
			LANG: 'en_US.UTF-8',
			PATH: '/controller/bin',
			TMPDIR: '/controller/tmp',
			TMP: '/controller/tmp',
			TEMP: '/controller/tmp',
			NO_COLOR: '1',
		})
	})

	it('fails readiness unless both runtimes authenticate from isolated homes', () => {
		expect.hasAssertions()
		expect(isolatedAuthenticationAccepted({ codex: true, claude: true })).toBe(true)
		expect(isolatedAuthenticationAccepted({ codex: true, claude: false })).toBe(false)
		expect(isolatedAuthenticationAccepted({ codex: false, claude: true })).toBe(false)
	})

	it('binds evidence acceptance to the actual file digest', () => {
		expect.hasAssertions()
		const source = 'tests passed\n'
		const digest = 'fe57e664bcff3dea7ec404334cbf77b833fa2f27841075e943dd5da8e5ee98f8'
		expect(
			evidenceReceiptAccepted({
				receipt: { kind: 'test', reference: 'evidence/test.txt', digest },
				expectedReference: 'evidence/test.txt',
				actualSource: source,
			}),
		).toBe(true)
		expect(
			evidenceReceiptAccepted({
				receipt: { kind: 'test', reference: 'evidence/test.txt', digest: '0'.repeat(64) },
				expectedReference: 'evidence/test.txt',
				actualSource: source,
			}),
		).toBe(false)
	})

	it('accepts only a controller-observed typed ownership conflict', () => {
		expect.hasAssertions()
		expect(
			ownershipConflictResultAccepted({
				status: 1,
				stdout: '',
				stderr:
					'{"ok":false,"error":{"type":"work_contract_error","code":"ownership_conflict","message":"already claimed"}}\n',
			}),
		).toBe(true)
		expect(
			ownershipConflictResultAccepted({
				status: 0,
				stdout: '{"ok":true,"value":"ownership_conflict"}\n',
			}),
		).toBe(false)
		expect(
			ownershipConflictResultAccepted({ status: 1, stdout: 'assistant says ownership_conflict' }),
		).toBe(false)
	})
})
