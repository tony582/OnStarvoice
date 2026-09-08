export function hasUnattendedNegativePatrol(planSnapshot: unknown): boolean;
export function unattendedNegativePatrolRequest(enabled: boolean, executionMode: string): {negativePatrol?: {enabled: true; lookbackDays: 7}};
export function negativePatrolCapabilityAvailable(capabilities: unknown): boolean;
