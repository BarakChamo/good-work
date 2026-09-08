/**
 * @description Public provider-neutral API for compiling, synchronizing, and operating file-based work
 * contracts.
 *
 * @module work
 * @file Index.ts
 */

export { CanonicalDefinitionRevisionSchema, WORK_ERROR_CODES, WorkErrorSchema } from './contracts'
export type * from './contracts'
export * from './facade'
export { WorkManifestInputSchema } from './compiler'
