import catalog from './fields.json';
import { HttpError, integer, validVin } from './security';

export { catalog };
export const SCOPES = 'openid offline_access vehicle_device_data vehicle_location';
export const API_HOSTS: Record<string, string> = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
};
export const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
export const LOCATION_FIELDS = new Set(['Location', 'OriginLocation', 'DestinationLocation', 'DestinationName', 'RouteLine', 'GpsState', 'GpsHeading']);
const essentials = new Set('VehicleSpeed Location Soc BatteryLevel Odometer EstBatteryRange IdealBatteryRange DetailedChargeState ChargeAmps ChargerVoltage ChargeLimitSoc ACChargingPower DCChargingPower DCChargingEnergyIn InsideTemp OutsideTemp Locked DoorState Gear VehicleName Version TpmsPressureFl TpmsPressureFr TpmsPressureRl TpmsPressureRr'.split(' '));
const quick = new Set('VehicleSpeed Location Gear PedalPosition BrakePedal PackCurrent PackVoltage Power LateralAcceleration LongitudinalAcceleration'.split(' '));
const slow = new Set(['Vehicle Configuration', 'User Preference', 'Safety']);
export type FieldConfig = { interval_seconds: number; minimum_delta?: number };

export function buildFields(preset: string, location = true): Record<string, FieldConfig> {
  if (!['essentials', 'complete', 'high-detail'].includes(preset)) throw new HttpError(400, 'Unknown collection preset.');
  return Object.fromEntries(catalog.filter(field => field.passenger && (preset !== 'essentials' || essentials.has(field.name)) && (location || !LOCATION_FIELDS.has(field.name))).map(field => {
    let interval = slow.has(field.category) ? 300 : 60;
    if (quick.has(field.name)) interval = preset === 'high-detail' ? 1 : 10;
    else if (preset === 'high-detail' && ['Driving', 'Powertrain', 'Charging'].includes(field.category)) interval = 10;
    const config: FieldConfig = { interval_seconds: interval };
    if (preset !== 'high-detail') {
      if (['InsideTemp', 'OutsideTemp'].includes(field.name)) config.minimum_delta = 0.5;
      if (['Soc', 'BatteryLevel'].includes(field.name)) config.minimum_delta = 0.5;
      if (field.name === 'ChargerVoltage') config.minimum_delta = 1;
      if (field.name === 'Location') config.minimum_delta = 10;
    }
    return [field.name, config];
  }));
}

export function validateFields(input: unknown): Record<string, FieldConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Fields must be a JSON object.');
  const entries = Object.entries(input);
  if (!entries.length || entries.length > 300) throw new HttpError(400, 'Choose between 1 and 300 fields.');
  const known = new Set(catalog.map(f => f.name));
  return Object.fromEntries(entries.map(([name, value]) => {
    if (!known.has(name) || !value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `Unknown or invalid field: ${name}`);
    const { interval_seconds, minimum_delta, ...extra } = value;
    if (Object.keys(extra).length || integer(interval_seconds, -1, 1, 3600) === -1) throw new HttpError(400, `${name}: interval_seconds must be an integer from 1 to 3600.`);
    if (minimum_delta !== undefined && (typeof minimum_delta !== 'number' || !Number.isFinite(minimum_delta) || minimum_delta < 0)) throw new HttpError(400, `${name}: minimum_delta must be nonnegative.`);
    return [name, { interval_seconds, ...(minimum_delta !== undefined ? { minimum_delta } : {}) }];
  }));
}

export type TelemetryEvent = {
  id: string;
  vin: string;
  kind: 'signal' | 'connectivity' | 'alert' | 'error';
  field: string;
  value: unknown;
  timestamp: number;
  timestampSource: 'vehicle' | 'receiver';
};

export function validateEvents(body: any, now = Date.now()): TelemetryEvent[] {
  if (!body || !Array.isArray(body.events) || !body.events.length || body.events.length > 200) throw new HttpError(400, 'Send 1 to 200 events per batch.');
  return body.events.map((event: any) => {
    if (!event || typeof event.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(event.id) || !validVin(event.vin) || !['signal', 'connectivity', 'alert', 'error'].includes(event.kind) || typeof event.field !== 'string' || !/^[a-zA-Z0-9_./:-]{1,128}$/.test(event.field) || !Object.hasOwn(event, 'value')) throw new HttpError(400, 'Invalid telemetry event.');
    if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 1577836800000 || event.timestamp > now + 300000 || !['receiver', 'vehicle'].includes(event.timestampSource)) throw new HttpError(400, 'Invalid telemetry timestamp. Use Unix milliseconds and identify the timestamp source.');
    if (JSON.stringify(event.value).length > 32768) throw new HttpError(400, 'Signal value is too large.');
    return { id: event.id, vin: event.vin, kind: event.kind, field: event.field, value: event.value, timestamp: event.timestamp, timestampSource: event.timestampSource };
  });
}
