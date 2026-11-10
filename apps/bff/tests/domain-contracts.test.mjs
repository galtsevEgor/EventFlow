import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  EVENT_CURRENCY,
  MAX_EVENT_DESCRIPTION_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  MAX_OFFLINE_PAYLOAD_LENGTH,
  MAX_OFFLINE_SNAPSHOT_HASHES,
  MAX_OFFLINE_SYNC_OPERATIONS,
  MAX_SEATS_PER_ORDER,
  MAX_SEATS_PER_ROW,
  MAX_VENUE_FEATURE_DIMENSION,
  MAX_VENUE_MAP_COORDINATE,
  MAX_VENUE_MAP_DIMENSION,
  MAX_VENUE_MAP_FEATURES,
  MAX_VENUE_ROWS,
  MAX_VENUE_SEATS,
  MIN_VENUE_FEATURE_DIMENSION,
  MIN_VENUE_MAP_DIMENSION,
  venueSeatIdSchema,
} from '@eventflow/event-contracts';

const { components } = JSON.parse(
  readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'),
);
const schemas = components.schemas;

test('BFF OpenAPI advertises the runtime limits for halls, drafts, and orders', () => {
  const config = schemas.EventConfiguration.properties;
  const layout = config.layout.properties;
  assert.equal(layout.rows.maximum, MAX_VENUE_ROWS);
  assert.equal(layout.columns.maximum, MAX_SEATS_PER_ROW);
  assert.equal(layout.overrides.maxItems, MAX_VENUE_SEATS);
  assert.deepEqual(config.currency.enum, [EVENT_CURRENCY]);
  assert.deepEqual(schemas.Order.properties.currency.enum, [EVENT_CURRENCY]);
  assert.equal(schemas.DraftInput.properties.title.maxLength, MAX_EVENT_TITLE_LENGTH);
  assert.equal(schemas.DraftInput.properties.description.maxLength, MAX_EVENT_DESCRIPTION_LENGTH);
  assert.equal(schemas.ReserveOrder.properties.seatIds.maxItems, MAX_SEATS_PER_ORDER);

  const map = schemas.VenueMap.properties;
  for (const size of [map.width, map.height]) {
    assert.equal(size.minimum, MIN_VENUE_MAP_DIMENSION);
    assert.equal(size.maximum, MAX_VENUE_MAP_DIMENSION);
  }
  assert.equal(map.seats.maxItems, MAX_VENUE_SEATS);
  assert.equal(map.features.maxItems, MAX_VENUE_MAP_FEATURES);
  const seat = map.seats.items.properties;
  const feature = map.features.items.properties;
  for (const position of [seat, feature]) {
    assert.equal(position.x.maximum, MAX_VENUE_MAP_COORDINATE);
    assert.equal(position.y.maximum, MAX_VENUE_MAP_COORDINATE);
  }
  for (const size of [feature.width, feature.height]) {
    assert.equal(size.minimum, MIN_VENUE_FEATURE_DIMENSION);
    assert.equal(size.maximum, MAX_VENUE_FEATURE_DIMENSION);
  }
  const seatId = new RegExp(seat.seatId.pattern);
  for (const id of [
    'r1-s1',
    `r${MAX_VENUE_ROWS}-s${MAX_SEATS_PER_ROW}`,
    'r01-s1',
    'r1-s0',
    `r${MAX_VENUE_ROWS + 1}-s1`,
    `r1-s${MAX_SEATS_PER_ROW + 1}`,
  ]) {
    assert.equal(seatId.test(id), venueSeatIdSchema.safeParse(id).success, id);
  }
});

test('BFF OpenAPI uses the same snapshot and batch limits as the offline gate', () => {
  assert.equal(schemas.OfflineManifest.properties.hashes.maxItems, MAX_OFFLINE_SNAPSHOT_HASHES);
  assert.equal(schemas.OfflineBundle.properties.payload.maxLength, MAX_OFFLINE_PAYLOAD_LENGTH);
  assert.equal(schemas.OfflineSync.properties.operations.maxItems, MAX_OFFLINE_SYNC_OPERATIONS);
  assert.equal(schemas.OfflineSyncResult.properties.results.maxItems, MAX_OFFLINE_SYNC_OPERATIONS);
});
