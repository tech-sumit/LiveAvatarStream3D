-- Persist the uploaded sample key for retries + surface clone failures in the UI.
ALTER TABLE voices ADD COLUMN sample_key TEXT;
ALTER TABLE voices ADD COLUMN error TEXT;
