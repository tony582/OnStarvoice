-- 视频逐字稿的 AI 舆情分析:基于口播逐字稿,用 LLM 产出结构化洞察
-- (立场/概括/核心观点/槽点/品牌风险/用户诉求),让视频内容也参与舆情判断。
ALTER TABLE records ADD COLUMN IF NOT EXISTS transcript_analysis JSONB;
ALTER TABLE records ADD COLUMN IF NOT EXISTS transcript_analysis_at TIMESTAMPTZ;
