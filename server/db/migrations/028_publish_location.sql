ALTER TABLE records ADD COLUMN IF NOT EXISTS publish_location TEXT NOT NULL DEFAULT '';

UPDATE records
SET publish_location = COALESCE(
  NULLIF(payload->>'publishLocation', ''),
  NULLIF(payload->>'region', ''),
  NULLIF(payload->>'ipLocation', ''),
  NULLIF(payload->>'ip_location', ''),
  NULLIF(payload->'detailPayload'->>'publishLocation', ''),
  NULLIF(payload->'detailPayload'->>'region', ''),
  NULLIF(payload->'detailPayload'->>'ipLocation', ''),
  NULLIF(payload->'detailPayload'->>'ip_location', ''),
  NULLIF(payload->'items'->0->>'publishLocation', ''),
  NULLIF(payload->'items'->0->>'region', ''),
  NULLIF(payload->'items'->0->>'ipLocation', ''),
  ''
)
WHERE publish_location = '';

UPDATE records
SET publish_location = substring(
  publish_time from '(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)\s*$'
)
WHERE publish_location = ''
  AND publish_time ~ '(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)\s*$';

UPDATE records
SET publish_time = btrim(regexp_replace(
  publish_time,
  '\s*(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)\s*$',
  ''
))
WHERE publish_time ~ '(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)\s*$';

CREATE INDEX IF NOT EXISTS idx_records_tenant_publish_location
  ON records (tenant_id, publish_location)
  WHERE publish_location <> '';
