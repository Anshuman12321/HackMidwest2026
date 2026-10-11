-- Local simulations and live read-only reviews cannot become connected work.
-- Each local runtime applies the shared table migrations within its own schema.
CREATE SCHEMA IF NOT EXISTS ripple_fixture;
CREATE SCHEMA IF NOT EXISTS ripple_live_preview;
CREATE SCHEMA IF NOT EXISTS ripple_read_only;
REVOKE ALL ON SCHEMA ripple_fixture, ripple_live_preview, ripple_read_only FROM PUBLIC;
