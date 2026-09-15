CREATE INDEX IF NOT EXISTS events_trip_time ON events(vin,timestamp,seq) WHERE kind='signal' AND field IN ('Gear','VehicleSpeed','Location','Odometer','Soc','BatteryLevel');
