export function hasUnattendedNegativePatrol(planSnapshot: unknown): boolean;
export function hasFirstCollectedNegativePatrolWindow(run: unknown): boolean;
export const NEGATIVE_PATROL_STATUS_OPTIONS: Array<{value: string; label: string}>;
export const DEFAULT_NEGATIVE_PATROL_STATUSES: string[];
export function negativePatrolTriageStatuses(planSnapshot: unknown): string[];
export function validNegativePatrolStatuses(statuses: unknown): boolean;
export function negativePatrolStatusSummary(statuses: string[]): string;
export function unattendedNegativePatrolRequest(enabled: boolean, executionMode: string, triageStatuses?: string[]): {negativePatrol?: {enabled: true; lookbackDays: 7; triageStatuses: string[]}};
export function negativePatrolCapabilityAvailable(capabilities: unknown): boolean;
