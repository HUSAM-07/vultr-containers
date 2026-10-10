ALTER TABLE cloudflare_connections ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'token' CHECK (auth_method IN ('token', 'oauth'));
ALTER TABLE cloudflare_connections ADD COLUMN refresh_ciphertext TEXT;
ALTER TABLE cloudflare_connections ADD COLUMN token_expires_at INTEGER;
