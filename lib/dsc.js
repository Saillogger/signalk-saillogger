/*
 * Copyright 2024 Saillogger LLC <info@saillogger.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * DSC (VHF Digital Selective Calling) parsers. The NMEA 0183 ($--DSC / $--DSE)
 * and NMEA 2000 (PGN 129808) decoding is adapted from signalk-dsc
 * (https://github.com/sailingnaturali/signalk-dsc), Copyright (c) 2026
 * Bryan Clark, released under the MIT License.
 *
 * Each parser returns a canonical, transport-independent DSC event:
 *   { format, category, mmsi, deviceBeacon?, natureOfDistress?, relay?,
 *     distressedMmsi?, position?: {latitude, longitude}, utcTime?,
 *     workingChannel?, acknowledgement?, expansion? }
 * Tolerant by design: anything that cannot be interpreted stays undefined.
 */

'use strict';

const FORMATS = {
  '02': 'area',
  '12': 'distressAlert',
  '14': 'group',
  '16': 'allShips',
  '20': 'individual',
  '23': 'autoService',
};

const CATEGORIES = {
  '00': 'routine',
  '08': 'safety',
  '10': 'urgency',
  '12': 'distress',
};

const NATURES = {
  '00': 'fire',
  '01': 'flooding',
  '02': 'collision',
  '03': 'grounding',
  '04': 'listing',
  '05': 'sinking',
  '06': 'adrift',
  '07': 'undesignated',
  '08': 'abandon',
  '09': 'piracy',
  '10': 'mob',
  '12': 'epirb',
};

// Telecommand 21 on a non-distress call = "ship position": field 5 is a position.
const TELECOMMAND_SHIP_POSITION = '21';

// AIS device-beacon MMSI prefixes (ITU 97x): a SART / MOB / EPIRB beacon can
// send a DSC distress directly. The tag lets the backend correlate it with the
// matching AIS target.
const DEVICE_BEACONS = { '970': 'sart', '972': 'mob', '974': 'epirb' };

function deviceBeaconFor(mmsi) {
  if (typeof mmsi !== 'string') return undefined;
  return DEVICE_BEACONS[mmsi.substring(0, 3)];
}

// Resolve a nature-of-distress code to its name. The code arrives over the air
// unsanitised, so only a clean 1-2 digit numeric code reaches the lookup; a key
// like "__proto__" would otherwise resolve to Object.prototype. Anything else
// collapses to a safe constant.
function parseNature(raw) {
  return /^\d{1,2}$/.test(raw) ? NATURES[raw] || `code-${raw}` : 'undesignated';
}

function field(parts, i) {
  const v = parts[i];
  return typeof v === 'string' ? v.trim() : '';
}

// DSC sentences carry the MMSI with a trailing zero (MMSI * 10).
function parseMmsi(raw) {
  if (typeof raw !== 'string') return undefined;
  const digits = raw.trim();
  if (!/^\d{9,10}$/.test(digits)) return undefined;
  return digits.length === 10 ? digits.substring(0, 9) : digits;
}

function parsePosition(raw) {
  if (typeof raw !== 'string' || !/^\d{10}$/.test(raw)) return undefined;
  if (raw === '9999999999') return undefined; // "position not available"
  const quadrant = Number(raw[0]); // 0 NE, 1 NW, 2 SE, 3 SW
  if (quadrant > 3) return undefined;
  const latMin = Number(raw.substring(3, 5));
  const lonMin = Number(raw.substring(8, 10));
  if (latMin >= 60 || lonMin >= 60) return undefined; // garbled minute field
  let latitude = Number(raw.substring(1, 3)) + latMin / 60;
  let longitude = Number(raw.substring(5, 8)) + lonMin / 60;
  // The field arrives over the air unvalidated; an out-of-range value cannot be
  // interpreted as a position, so it stays undefined like the "unavailable" code.
  if (latitude > 90 || longitude > 180) return undefined;
  if (quadrant === 1 || quadrant === 3) longitude = -longitude;
  if (quadrant === 2 || quadrant === 3) latitude = -latitude;
  return { latitude, longitude };
}

function parseUtcTime(raw) {
  if (typeof raw !== 'string' || !/^\d{4}$/.test(raw.trim())) return undefined;
  const t = raw.trim();
  if (t === '8888') return undefined; // "time not available"
  return `${t.substring(0, 2)}:${t.substring(2, 4)}`;
}

// VHF channel plausibility: 1-99 (international) or the 4-digit simplex forms.
function parseChannel(raw) {
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw.trim())) return undefined;
  const t = raw.trim();
  // A leading 9 on a 6-digit value marks "channel number follows" (900072 = 72).
  const digits = /^9\d{5}$/.test(t) ? t.slice(1) : t;
  const n = Number(digits);
  if (!Number.isInteger(n)) return undefined;
  if ((n >= 1 && n <= 99) || (n >= 1001 && n <= 1099) || (n >= 2001 && n <= 2099)) {
    return String(n);
  }
  return undefined;
}

/**
 * Parse the comma-split fields of a $--DSC sentence (id and checksum already
 * stripped). Returns null only when there is nothing usable at all.
 *
 *        0  1          2  3  4  5          6    7 8 9 10
 * $--DSC,XX,XXXXXXXXXX,XX,XX,XX,XXXXXXXXXX,XXXX,,,A,C*hh
 */
function parseDsc(parts) {
  if (!Array.isArray(parts) || parts.length < 2) return null;

  const formatCode = field(parts, 0);
  let categoryCode = field(parts, 2);
  // Some radios omit the category on distress alerts; it is implied by 112.
  if (!categoryCode && formatCode === '12') categoryCode = '12';

  const event = {
    format: FORMATS[formatCode] || 'unknown',
    category: CATEGORIES[categoryCode] || 'unknown',
    mmsi: parseMmsi(parts[1]),
  };

  const beacon = deviceBeaconFor(event.mmsi);
  if (beacon) event.deviceBeacon = beacon;

  const distress = event.category === 'distress';
  if (distress) {
    // A distress relay (all-ships / area / individual format) reports the
    // casualty in field 7 and the nature in field 8; a first-party alert
    // (distressAlert format) carries the nature in field 3, and field 7 has
    // no casualty meaning (the alerting vessel in field 1 is the casualty).
    if (event.format !== 'distressAlert') {
      event.relay = true;
      event.natureOfDistress = parseNature(field(parts, 8));
      event.distressedMmsi = parseMmsi(parts[7]);
    } else {
      event.natureOfDistress = parseNature(field(parts, 3));
    }
  }

  if (distress || field(parts, 3) === TELECOMMAND_SHIP_POSITION) {
    event.position = parsePosition(field(parts, 5));
    event.utcTime = parseUtcTime(field(parts, 6));
  } else {
    const channel = parseChannel(field(parts, 5));
    if (channel) event.workingChannel = channel;
  }

  const ack = field(parts, 9);
  if (ack) event.acknowledgement = ack;
  event.expansion = field(parts, 10) === 'E';

  return event;
}

const DSE_CODE_ENHANCED_POSITION = '00';

/**
 * Parse a $--DSE sentence (the expansion that can follow a $--DSC, refining its
 * position from whole minutes to ten-thousandths of a minute). Returns
 * { mmsi, latMinuteFraction, lonMinuteFraction } for single-sentence position
 * extensions, else null.
 *
 *        0 1 2 3          4  5
 * $--DSE,t,n,A,XXXXXXXXXX,00,llllyyyy*hh
 */
function parseDse(parts) {
  if (!Array.isArray(parts) || parts.length < 6) return null;
  // Multi-sentence groups are vanishingly rare on Class-D gear; skip them.
  if (field(parts, 0) !== '1' || field(parts, 1) !== '1') return null;

  const mmsi = parseMmsi(parts[3]);
  if (!mmsi) return null;

  for (let i = 4; i + 1 < parts.length; i += 2) {
    const code = field(parts, i);
    const data = field(parts, i + 1);
    if (code === DSE_CODE_ENHANCED_POSITION && /^\d{8}$/.test(data)) {
      return {
        mmsi,
        latMinuteFraction: Number(data.substring(0, 4)) / 10000,
        lonMinuteFraction: Number(data.substring(4, 8)) / 10000,
      };
    }
  }
  return null;
}

/**
 * Apply a DSE extension to a DSC position. DSC truncates coordinates toward
 * zero, so the fractional minutes always extend the magnitude (sign-preserving).
 */
function refinePosition(position, ext) {
  const extend = (value, minuteFraction) => {
    // Object.is guards negative zero: parsePosition yields -0 for a coordinate
    // at exactly 0deg in a W/S quadrant, and -0 < 0 is false, which would flip
    // the DSE-refined coordinate to the wrong hemisphere.
    const sign = value < 0 || Object.is(value, -0) ? -1 : 1;
    return sign * (Math.abs(value) + minuteFraction / 60);
  };
  return {
    latitude: extend(position.latitude, ext.latMinuteFraction),
    longitude: extend(position.longitude, ext.lonMinuteFraction),
  };
}

/*
 * NMEA 2000 PGN 129808 "DSC Call Information". canboatjs (useCamelCompat)
 * resolves lookups to their names; the distress variant uses
 * dscFormat/dscCategory/natureOfDistress, the general variant the *Symbol
 * fields. When a lookup cannot be resolved the raw ITU symbol number (1xx)
 * comes through instead, so both are handled.
 */
const N2K_FORMATS = new Map([
  ['geographical area', 'area'],
  ['distress', 'distressAlert'],
  ['common interest', 'group'],
  ['group call', 'group'],
  ['all ships', 'allShips'],
  ['individual stations', 'individual'],
  ['individual station automatic', 'autoService'],
  [102, 'area'], [112, 'distressAlert'], [114, 'group'],
  [116, 'allShips'], [120, 'individual'], [123, 'autoService'],
]);

const N2K_CATEGORIES = new Map([
  ['routine', 'routine'], ['safety', 'safety'],
  ['urgency', 'urgency'], ['distress', 'distress'],
  [100, 'routine'], [108, 'safety'], [110, 'urgency'], [112, 'distress'],
]);

const N2K_NATURES = new Map([
  ['fire, explosion', 'fire'],
  ['flooding', 'flooding'],
  ['collision', 'collision'],
  ['grounding', 'grounding'],
  ['listing, in danger of capsizing', 'listing'],
  ['sinking', 'sinking'],
  ['disabled and adrift', 'adrift'],
  ['undesignated distress', 'undesignated'],
  ['abandoning ship', 'abandon'],
  ['piracy/armed robbery attack', 'piracy'],
  ['man overboard', 'mob'],
  ['epirb emission', 'epirb'],
  [0, 'fire'], [1, 'flooding'], [2, 'collision'], [3, 'grounding'],
  [4, 'listing'], [5, 'sinking'], [6, 'adrift'], [7, 'undesignated'],
  [8, 'abandon'], [9, 'piracy'], [10, 'mob'], [12, 'epirb'],
]);

function n2kLookup(map, value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const hit = map.get(value.trim().toLowerCase());
    if (hit) return hit;
    const asNumber = Number(value);
    return Number.isNaN(asNumber) ? undefined : map.get(asNumber);
  }
  return map.get(value);
}

function n2kMmsi(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const digits = String(value).trim();
  if (!/^\d{1,9}$/.test(digits) || Number(digits) === 0) return undefined;
  return digits.padStart(9, '0');
}

function n2kTime(value) {
  if (typeof value === 'string') {
    const m = value.match(/^(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : undefined;
  }
  if (typeof value === 'number' && value >= 0 && value < 86400) {
    const h = String(Math.floor(value / 3600)).padStart(2, '0');
    const min = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
    return `${h}:${min}`;
  }
  return undefined;
}

// canboatjs may key PGN fields either camelCased (dscFormat — useCamelCompat)
// or in canboat's canonical spaced form (DSC Format), depending on its version
// and config. Collapse both (and underscored variants) to a space/underscore-
// stripped, lower-cased key so the normalizer reads the fields either way.
function canonicalFields(fields) {
  const map = {};
  for (const key in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const canon = key.replace(/[\s_]+/g, '').toLowerCase();
    if (!(canon in map)) map[canon] = fields[key];
  }
  return map;
}

/** Normalize a canboatjs-parsed PGN 129808 object into a canonical DSC event. */
function normalizePgn129808(pgnData) {
  const f = canonicalFields((pgnData && pgnData.fields) || {});
  const get = (...names) => {
    for (const n of names) {
      if (f[n] !== undefined && f[n] !== null) return f[n];
    }
    return undefined;
  };

  const event = {
    format: n2kLookup(N2K_FORMATS, get('dscformat', 'dscformatsymbol')) || 'unknown',
    category: n2kLookup(N2K_CATEGORIES, get('dsccategory', 'dsccategorysymbol')) || 'unknown',
    mmsi: n2kMmsi(get('dscmessageaddress')),
  };

  const beacon = deviceBeaconFor(event.mmsi);
  if (beacon) event.deviceBeacon = beacon;

  if (event.category === 'distress') {
    const nature = get('natureofdistress', '1sttelecommand');
    event.natureOfDistress = n2kLookup(N2K_NATURES, nature) || 'undesignated';
    if (event.format !== 'distressAlert') event.relay = true;
  }

  const lat = get('latitudeofvesselreported');
  const lon = get('longitudeofvesselreported');
  // Range-check like the 0183 parsePosition: an out-of-range value is a garbled
  // or not-available decode, not a position.
  if (typeof lat === 'number' && typeof lon === 'number' &&
      Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    event.position = { latitude: lat, longitude: lon };
  }

  const time = n2kTime(get('timeofposition'));
  if (time) event.utcTime = time;

  const distressed = n2kMmsi(get('mmsiofshipindistress'));
  if (distressed) event.distressedMmsi = distressed;

  return event;
}

module.exports = { parseDsc, parseDse, refinePosition, normalizePgn129808 };
