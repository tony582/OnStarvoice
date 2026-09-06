import {PAGE_TYPE} from '../../utils/constants.js';

export const KEYWORD_SORT_DIMENSION = {
  LIKES: "likes",
  COLLECTS: "collects",
  COMMENTS: "comments",
};

export function createKeywordTaskState() {
  return {
    keywordSortDimension: KEYWORD_SORT_DIMENSION.LIKES,
    keywordSortSyncTimer: null,
    lastRuntimePageUrlForKeywordSort: "",
    expandedKeywordsBuffer: [],
    keywordExpandInFlight: false,
    keywordExpandCancelRequested: false,
    keywordAnalysisInFlight: false,
    keywordInsightSampleInFlight: false,
    keywordInsightRunToken: 0,
    keywordAnalysisStartedAt: 0,
    keywordBenchmarkInFlight: false,
    keywordBenchmarkCancelRequested: false,
    keywordBenchmarkStartedAt: 0,
    keywordBenchmarkResult: null,
    keywordBenchmarkErrorMessage: "",
    keywordBenchmarkAnalysisStatus: "idle",
    keywordBenchmarkLoadingTitle: "",
    keywordBenchmarkLoadingMeta: "",
    keywordOpportunityInFlight: false,
    keywordOpportunityCancelRequested: false,
    keywordOpportunityStartedAt: 0,
    keywordOpportunityResult: null,
    keywordOpportunityErrorMessage: "",
    lastRuntimePageTypeForKeywordSort: PAGE_TYPE.UNKNOWN,
    batchDraftByPlatform: {},
    activeBatchDraftPlatform: "",
    keywordPlanState: null,
    activeKeywordRunState: null,
    keywordPlanReconcileTimer: null,
    keywordPlanReconcileInFlight: false,
  };
}
