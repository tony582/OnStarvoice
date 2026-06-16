-- 销售客资:comment_leads.lead_type 增加 'sales_intent'(购买意向 / 询价 / 留联系方式)
-- 用于把「销售客资」从「舆情评论」中分离出来。

ALTER TABLE comment_leads DROP CONSTRAINT IF EXISTS comment_leads_lead_type_check;

ALTER TABLE comment_leads
  ADD CONSTRAINT comment_leads_lead_type_check
  CHECK (lead_type IN (
    'sales_intent',
    'complaint', 'renewal_billing', 'app_issue',
    'service_quality', 'safety_privacy', 'brand_risk', 'other'
  ));
