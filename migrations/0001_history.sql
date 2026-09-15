CREATE TABLE IF NOT EXISTS signals (vin TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, timestamp INTEGER NOT NULL, timestamp_source TEXT NOT NULL, PRIMARY KEY(vin, field));
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, vin TEXT NOT NULL, kind TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, timestamp INTEGER NOT NULL, timestamp_source TEXT NOT NULL, received_at INTEGER NOT NULL, numeric_value REAL);
CREATE INDEX IF NOT EXISTS events_vin_seq ON events(vin,seq);
CREATE INDEX IF NOT EXISTS events_vin_field_time ON events(vin,field,timestamp);
CREATE INDEX IF NOT EXISTS events_received ON events(received_at);
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, vin TEXT NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS snapshots_vin_time ON snapshots(vin,timestamp);
