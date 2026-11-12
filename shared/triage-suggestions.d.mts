export const NON_MONITOR_SUGGESTION: 'non_monitor';
export const TRIAGE_SUGGESTION_RULE_VERSION: 'non_monitor_f_v1';
export const TRIAGE_SUGGESTION_SETTING: 'triage_non_monitor_suggestion_enabled';
export const DEFAULT_SUGGESTION_TENANT_ID: string;
export const NON_MONITOR_REASON_PHRASES: readonly string[];
export const NON_MONITOR_RISK_TERMS: readonly string[];
export const NON_MONITOR_SERVICE_TERMS: readonly string[];
export const NON_MONITOR_MIN_TEXT_LENGTH: number;
export const NON_MONITOR_SERVICE_WINDOW: number;
export interface TriageSuggestionReason {
  ruleVersion: string;
  summary: string;
  checks: string[];
  evidence: {reasonPhrase: string; relevanceReason: string; textLength: number; serviceWindow: number};
}
export function evaluateNonMonitorSuggestion(record?: {title?: unknown; content?: unknown; ai_result?: unknown}): TriageSuggestionReason | null;
export function formatTriageSuggestionReason(reason: unknown): string;
export function triageSuggestionEnabled(setting: unknown, tenantId: string): boolean;
