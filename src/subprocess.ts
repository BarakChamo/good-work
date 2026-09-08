/**
 * @description Runs bounded UTF-8 subprocesses without exposing callback overloads to callers.
 *
 * @module work/subprocess
 * @file Subprocess.ts
 */

import { execFile } from 'node:child_process'
import type {
	ExecFileOptionsWithBufferEncoding,
	ExecFileOptionsWithStringEncoding,
} from 'node:child_process'

type Utf8ExecFileOptions = Omit<ExecFileOptionsWithStringEncoding, 'encoding'>
type BufferExecFileOptions = Omit<ExecFileOptionsWithBufferEncoding, 'encoding'>

/** @description Executes one file directly and resolves its UTF-8 streams. */
export const executeFile = async (
	file: string,
	args: readonly string[],
	options: Utf8ExecFileOptions,
): Promise<{ readonly stderr: string; readonly stdout: string }> =>
	new Promise((resolve, reject) => {
		execFile(file, [...args], { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
			if (error !== null) {
				reject(error instanceof Error ? error : new Error('Subprocess failed.'))
				return
			}
			resolve({ stderr, stdout })
		})
	})

/** @description Executes one file directly and preserves exact stdout bytes for strict decoding. */
export const executeFileBytes = async (
	file: string,
	args: readonly string[],
	options: BufferExecFileOptions,
): Promise<{ readonly stderr: Buffer; readonly stdout: Buffer }> =>
	new Promise((resolve, reject) => {
		execFile(file, [...args], { ...options, encoding: 'buffer' }, (error, stdout, stderr) => {
			if (error !== null) {
				reject(error instanceof Error ? error : new Error('Subprocess failed.'))
				return
			}
			resolve({ stderr, stdout })
		})
	})
