/**
 * @description Builds sanitized typed failures for the verified Beads installer.
 *
 * @module work/beads-installer-errors
 * @file Beads-installer-errors.ts
 */

import type { WorkResult } from './contracts'

export type InstallationStage =
	| 'target_resolution'
	| 'temporary_setup'
	| 'checksum_download'
	| 'checksum_manifest'
	| 'archive_download'
	| 'archive_checksum'
	| 'archive_extraction'
	| 'binary_version'
	| 'binary_publication'
	| 'cleanup'

export type InstallationCleanupTarget =
	| 'operating_system_temp_directory'
	| 'provider_binary_directory'

const cleanupRecovery = (targets: readonly InstallationCleanupTarget[]): string => {
	const actions = [
		targets.includes('operating_system_temp_directory')
			? 'remove work-contract-beads-install-* from the operating-system temp directory'
			: undefined,
		targets.includes('provider_binary_directory')
			? 'remove bd.tmp-* or bd.exe.tmp-* from the installed provider binary directory'
			: undefined,
	].filter((action): action is string => action !== undefined)
	return `recovery=${actions.join(' and ')}, then retry`
}

/** @description Builds a bounded failure without exposing URLs, paths, or process output. */
export const installationFailure = (
	stage: InstallationStage,
	cleanupTargets: readonly InstallationCleanupTarget[] = [],
): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code: 'provider_failed',
		message: 'Pinned Beads installation failed.',
		details: [
			`stage=${stage}`,
			...(cleanupTargets.length === 0
				? ['recovery=retry the checksum-verifying provider installer']
				: [`cleanupResidue=${cleanupTargets.join(',')}`, cleanupRecovery(cleanupTargets)]),
		],
	},
})
