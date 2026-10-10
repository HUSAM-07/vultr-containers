ALTER TABLE specs ADD COLUMN provider TEXT CHECK (provider IN ('openai', 'anthropic'));
ALTER TABLE specs ADD COLUMN model TEXT;
