import {createKeywordPlanView} from './keyword-plan.js';
import {createKeywordStrategyView} from './keyword-strategy.js';
import {createKeywordSharingView} from './keyword-sharing.js';
import {createMonitorSettingsView} from './monitor-settings.js';

// Legacy view owns presentation-only state. Application state is read via named
// model readers; no mutable application state bag is passed to this adapter.
export function createLegacyKeywordView({ports, application, keywordModel}) {
  const legacyViewState = {
    keywordStrategyPanelVisible: false,
    keywordStrategyActiveTab: "opportunity",
    expandedKeywordsPanelVisible: false,
    expandedKeywordInsightCategoryIds: new Set(),
    keywordPlanProgressCountdownTimer: null,
    keywordPlanProgressCountdownToken: 0,
  };
  const viewOperations = Object.create(null);
  Object.assign(viewOperations, createKeywordPlanView({legacyViewState, ports, application, keywordModel, viewOperations}));
  Object.assign(viewOperations, createKeywordStrategyView({legacyViewState, ports, application, keywordModel, viewOperations}));
  Object.assign(viewOperations, createKeywordSharingView({legacyViewState, ports, application, keywordModel, viewOperations}));
  Object.assign(viewOperations, createMonitorSettingsView({legacyViewState, ports, application, keywordModel, viewOperations}));
  return Object.freeze({
    ...viewOperations,
    setStrategyPanelVisible: value => (legacyViewState.keywordStrategyPanelVisible = value),
    setStrategyActiveTab: value => (legacyViewState.keywordStrategyActiveTab = value),
    setExpandedKeywordsVisible: value => (legacyViewState.expandedKeywordsPanelVisible = value),
  });
}
