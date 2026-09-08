/**
 * @description Narrow schema-owned public facade for loading a complete file-defined work project.
 *
 * @module work/facade
 * @file Facade.ts
 */

import { maxLength, minLength, optional, pipe, safeParse, strictObject, string } from 'valibot'

import type {
	CanonicalDefinitionRevision,
	CompiledWorkGraph,
	WorkManifest,
	WorkResult,
} from './contracts'
import type { CompletionRecord } from './completion-ledger'
import { loadAuthoritativeWorkProject } from './definition-authority'

/** @description Runtime schema for the public load-work-project operation. */
export const LoadWorkProjectInputSchema = strictObject({
	root: pipe(string(), minLength(1), maxLength(4096)),
	path: optional(pipe(string(), minLength(1), maxLength(500))),
})

/** @description Parsed input accepted by {@link loadWorkProject}. */
export interface LoadWorkProjectInput {
	readonly root: string
	readonly path?: string
}

/** @description Complete validated file-owned project definition. */
export interface LoadedWorkProject {
	readonly manifest: WorkManifest
	readonly graph: CompiledWorkGraph
	readonly definitionRevision?: CanonicalDefinitionRevision
	readonly completionRecords: readonly CompletionRecord[]
}

/** @description Parses operation input, then loads and compiles the complete work project. */
export const loadWorkProject = async (
	input: LoadWorkProjectInput,
): Promise<WorkResult<LoadedWorkProject>> => {
	const parsed = safeParse(LoadWorkProjectInputSchema, input)
	if (!parsed.success) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_operation_input',
				message: 'Load-work-project input validation failed.',
				details: parsed.issues.map(
					({ message, path }) =>
						`${path?.map(({ key }) => String(key)).join('.') ?? 'input'}: ${message}`,
				),
			},
		}
	}
	return loadAuthoritativeWorkProject({
		root: parsed.output.root,
		...(parsed.output.path === undefined ? {} : { path: parsed.output.path }),
	})
}
