-- Stable cluster lineage (rotation-tolerant) + optional canonical id for global feed dedupe.
-- Apply on existing DBs: run via Turso shell or npm run turso:schema if your flow runs migrations.

ALTER TABLE intel_cluster_track ADD COLUMN canonical_cluster_id TEXT;

UPDATE intel_cluster_track
SET canonical_cluster_id = cluster_fingerprint
WHERE canonical_cluster_id IS NULL OR TRIM(COALESCE(canonical_cluster_id, '')) = '';

CREATE INDEX IF NOT EXISTS idx_cluster_track_canonical ON intel_cluster_track (canonical_cluster_id);
