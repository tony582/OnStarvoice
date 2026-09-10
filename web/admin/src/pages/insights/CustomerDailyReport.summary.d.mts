import type {DailyCounts, DailySnapshot} from './CustomerDailyReport.types';
export const monthlyFields: readonly ['monitor', 'sdb', 'positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther'];
export type MonthlyField = typeof monthlyFields[number];
export type MonthlyDraft = Record<string, Partial<Record<MonthlyField, string>>>;
export const monthlyLabels: Record<MonthlyField, string>;
export function isMonthlySummary(snapshot: DailySnapshot): boolean;
export function monthlyDraftFromRows(rows: NonNullable<DailySnapshot['summary']['rows']>): MonthlyDraft;
export function parseMonthlyDraft(rows: NonNullable<DailySnapshot['summary']['rows']>, draft: MonthlyDraft): {rows: Record<string, Record<MonthlyField, number>>};
export function sumMonthlyRows(rows: NonNullable<DailySnapshot['summary']['rows']>, draft: MonthlyDraft | null): Pick<DailyCounts, MonthlyField>;
