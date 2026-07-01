'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseDsc, parseDse, refinePosition, normalizePgn129808 } = require('../lib/dsc');

// Fields as the NMEA 0183 parser delivers them: talker+sentence id and checksum
// already stripped, so parts[0] is the DSC format specifier.

test('parseDsc: first-party distress alert with position', () => {
  const e = parseDsc(['12', '2442236000', '12', '02', '00', '0484700327', '1423', '', '', '', 'E']);
  assert.equal(e.format, 'distressAlert');
  assert.equal(e.category, 'distress');
  assert.equal(e.mmsi, '244223600'); // trailing-zero (MMSI * 10) stripped
  assert.equal(e.natureOfDistress, 'collision');
  assert.ok(Math.abs(e.position.latitude - 48.7833333) < 1e-4);
  assert.ok(Math.abs(e.position.longitude - 3.45) < 1e-4);
  assert.equal(e.utcTime, '14:23');
  assert.equal(e.expansion, true);
  assert.equal(e.relay, undefined);
});

test('parseDsc: distress relay reports casualty in fields 7/8', () => {
  const e = parseDsc(['16', '0023711000', '12', '', '', '0484700327', '1423', '2442236000', '05', '', '']);
  assert.equal(e.format, 'allShips');
  assert.equal(e.category, 'distress');
  assert.equal(e.relay, true);
  assert.equal(e.natureOfDistress, 'sinking');
  assert.equal(e.distressedMmsi, '244223600');
  assert.equal(e.mmsi, '002371100'); // relaying coast station
});

test('parseDsc: routine individual call carries a working channel, no position', () => {
  const e = parseDsc(['20', '3669701230', '00', '06', '00', '000016', '', '', '', '', '']);
  assert.equal(e.format, 'individual');
  assert.equal(e.category, 'routine');
  assert.equal(e.workingChannel, '16');
  assert.equal(e.position, undefined);
  assert.equal(e.expansion, false);
});

test('parseDsc: "position not available" yields no position', () => {
  const e = parseDsc(['12', '2442236000', '12', '07', '00', '9999999999', '8888', '', '', '', '']);
  assert.equal(e.position, undefined);
  assert.equal(e.utcTime, undefined); // 8888 = time unavailable
  assert.equal(e.natureOfDistress, 'undesignated');
});

test('parseDsc: malicious nature code cannot escape to a prototype key', () => {
  const e = parseDsc(['12', '2442236000', '12', '__proto__', '00', '0484700327', '1423', '', '', '', '']);
  assert.equal(e.natureOfDistress, 'undesignated');
});

test('parseDsc: impossible coordinates from a garbled packet are dropped', () => {
  const e = parseDsc(['12', '2442236000', '12', '07', '00', '0997800000', '1423', '', '', '', '']);
  assert.equal(e.position, undefined); // 99deg lat / 78min are not a position
  assert.equal(e.category, 'distress'); // the rest of the call is still forwarded
});

test('parseDsc: first-party alert does not read field 7 as a casualty MMSI', () => {
  const e = parseDsc(['12', '2442236000', '12', '02', '00', '0484700327', '1423', '3669701230', '', '', '']);
  assert.equal(e.format, 'distressAlert');
  assert.equal(e.relay, undefined);
  assert.equal(e.distressedMmsi, undefined); // field 7 has no casualty meaning here
});

test('parseDse + refinePosition: enhances a minute-resolution position', () => {
  const ext = parseDse(['1', '1', 'A', '2442236000', '00', '12345678']);
  assert.equal(ext.mmsi, '244223600');
  assert.ok(Math.abs(ext.latMinuteFraction - 0.1234) < 1e-9);
  assert.ok(Math.abs(ext.lonMinuteFraction - 0.5678) < 1e-9);

  const refined = refinePosition({ latitude: 48.7833333, longitude: 3.45 }, ext);
  assert.ok(Math.abs(refined.latitude - (48.7833333 + 0.1234 / 60)) < 1e-6);
  assert.ok(Math.abs(refined.longitude - (3.45 + 0.5678 / 60)) < 1e-6);
});

test('parseDse: multi-sentence groups are skipped', () => {
  assert.equal(parseDse(['1', '2', 'A', '2442236000', '00', '12345678']), null);
});

test('refinePosition keeps a negative-zero coordinate in its hemisphere', () => {
  // Position at 0deg00.0' W (prime meridian) parses as longitude -0; a DSE
  // refinement to the west must stay negative, not flip to +E.
  const refined = refinePosition(
    { latitude: 50, longitude: -0 },
    { latMinuteFraction: 0, lonMinuteFraction: 0.5 }
  );
  assert.ok(refined.longitude < 0, 'refined longitude should remain western');
  assert.ok(Math.abs(refined.longitude - (-0.5 / 60)) < 1e-9);
});

test('normalizePgn129808: resolved lookup names', () => {
  const e = normalizePgn129808({
    pgn: 129808,
    fields: {
      dscFormat: 'Distress',
      dscCategory: 'Distress',
      dscMessageAddress: '244223600',
      natureOfDistress: 'Sinking',
      latitudeOfVesselReported: 48.7833,
      longitudeOfVesselReported: 3.45,
      timeOfPosition: '14:23:00',
      mmsiOfShipInDistress: '244223600',
    },
  });
  assert.equal(e.format, 'distressAlert');
  assert.equal(e.category, 'distress');
  assert.equal(e.mmsi, '244223600');
  assert.equal(e.natureOfDistress, 'sinking');
  assert.equal(e.relay, undefined);
  assert.deepEqual(e.position, { latitude: 48.7833, longitude: 3.45 });
  assert.equal(e.utcTime, '14:23');
});

test('normalizePgn129808: accepts canboat space-separated field names too', () => {
  const e = normalizePgn129808({
    pgn: 129808,
    fields: {
      'DSC Format': 'Distress',
      'DSC Category': 'Distress',
      'DSC Message Address': '244223600',
      'Nature of Distress': 'Sinking',
      'Latitude of Vessel Reported': 48.7833,
      'Longitude of Vessel Reported': 3.45,
      'Time of Position': '14:23:00',
      'MMSI of Ship In Distress': '244223600',
    },
  });
  assert.equal(e.format, 'distressAlert');
  assert.equal(e.category, 'distress');
  assert.equal(e.mmsi, '244223600');
  assert.equal(e.natureOfDistress, 'sinking');
  assert.deepEqual(e.position, { latitude: 48.7833, longitude: 3.45 });
  assert.equal(e.utcTime, '14:23');
  assert.equal(e.distressedMmsi, '244223600');
});

test('normalizePgn129808: drops an out-of-range position but keeps the rest', () => {
  const e = normalizePgn129808({
    pgn: 129808,
    fields: {
      'DSC Format': 'Distress',
      'DSC Category': 'Distress',
      'DSC Message Address': '244223600',
      'Nature of Distress': 'Sinking',
      'Latitude of Vessel Reported': 991.2, // impossible
      'Longitude of Vessel Reported': 3.45,
    },
  });
  assert.equal(e.position, undefined);
  assert.equal(e.category, 'distress');
  assert.equal(e.natureOfDistress, 'sinking');
});

test('normalizePgn129808: raw ITU symbol numbers and seconds-since-midnight time', () => {
  const e = normalizePgn129808({
    pgn: 129808,
    fields: {
      dscFormatSymbol: 112,
      dscCategorySymbol: 112,
      dscMessageAddress: '366970123',
      '1stTelecommand': 1,
      timeOfPosition: 51780, // 14:23:00
    },
  });
  assert.equal(e.format, 'distressAlert');
  assert.equal(e.category, 'distress');
  assert.equal(e.natureOfDistress, 'flooding');
  assert.equal(e.utcTime, '14:23');
});
