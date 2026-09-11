import type { OrchestrationAttemptRecord, OrchestrationExecutionRecord, OrchestrationItemRecord } from './types'
export function resultObject(value: unknown): Record<string, unknown>
export function resultCount(value: unknown): number | null
export function resultDuration(start?: string | null, end?: string | null): string
export function resultMessage(value: unknown): string
export function taskResultKind(task: {task_type?: string; feature_key?: string; metadata?: Record<string, unknown> | null}): string
export function historicalItemStatus(status: string): string
export function resultTiming(input: {createdAt?: string | null; startedAt?: string | null; finishedAt?: string | null}): {label: string; source: string | null; duration: string}
export function resultSyncEvidence(progress?: Record<string, unknown> | null): {known: boolean; failed: number | null; remaining: number | null; outcome: 'unknown' | 'reported_drained' | 'needs_review'}
export function orchestrationCurrentExecution(item: OrchestrationItemRecord, executions: OrchestrationExecutionRecord[]): OrchestrationExecutionRecord | undefined
export function orchestrationItemTiming(item: OrchestrationItemRecord, execution: OrchestrationExecutionRecord | undefined, attempts?: OrchestrationAttemptRecord[]): {source: 'attempt' | 'execution' | 'item'; startedAt: string | null; finishedAt: string | null; invalidOrder: boolean; note: string}
export function orchestrationSearchStepLabel(round: number, searchPasses?: string[]): string
export type OrchestrationResultEvidence = {steps: Record<string, unknown>[]; childIncomplete: boolean; failedStepCount: number; completedStepCount: number; missingCompletedSteps: boolean; unfinishedStepLabels: string[]; syncNeedsReview: boolean}
export function orchestrationResultEvidence(item: OrchestrationItemRecord, execution: OrchestrationExecutionRecord | undefined, expectedSearchPasses?: number, searchPasses?: string[]): OrchestrationResultEvidence
export function orchestrationResultRecovery(item: OrchestrationItemRecord, execution: OrchestrationExecutionRecord | undefined, options?: {parentStatus?: string; automaticRecovery?: boolean; now?: number; evidence?: OrchestrationResultEvidence}): {state: string; label: string; message: string; currentError: string}
