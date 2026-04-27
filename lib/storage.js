/*
 * Copyright 2023-2024 Saillogger LLC <info@saillogger.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

const fs = require('fs');

const BUFFER_FIELDS = [
  'ts',
  'latitude',
  'longitude',
  'speedOverGround',
  'courseOverGroundTrue',
  'windSpeedApparent',
  'angleSpeedApparent',
  'portEngineHours',
  'starboardEngineHours',
  'additionalData'
];

function atomicWrite(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function normalizeTimestamp(value, label) {
  const timestamp = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a finite timestamp`);
  }
  return timestamp;
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('buffer row must be an object');
  }

  const normalized = {};
  for (const field of BUFFER_FIELDS) {
    if (field === 'ts') {
      normalized.ts = normalizeTimestamp(row.ts, 'row.ts');
    } else {
      const value = row[field];
      normalized[field] = value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? null : value;
    }
  }
  return normalized;
}

class BufferStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.rows = [];

    if (!fs.existsSync(filePath)) {
      return;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        this.rows.push(normalizeRow(JSON.parse(line)));
      } catch (e) {
        // Leave the on-disk cache untouched; unreadable rows are ignored in memory.
      }
    }
    this.rows.sort((a, b) => a.ts - b.ts);
  }

  insert(row) {
    this.insertMany([row]);
  }

  insertMany(rows) {
    const normalizedRows = rows.map(normalizeRow);
    if (normalizedRows.length === 0) {
      return;
    }

    this.rows.push(...normalizedRows);
    this.rows.sort((a, b) => a.ts - b.ts);
    fs.appendFileSync(
      this.filePath,
      normalizedRows.map(r => JSON.stringify(r)).join('\n') + '\n'
    );
  }

  count() {
    return this.rows.length;
  }

  peek(limit) {
    return this.rows.slice(0, limit);
  }

  deleteUpTo(ts) {
    const threshold = normalizeTimestamp(ts, 'processedUntil');
    const before = this.rows.length;
    this.rows = this.rows.filter(r => r.ts > threshold);
    if (this.rows.length !== before) {
      this._rewrite();
    }
  }

  _rewrite() {
    const contents = this.rows.map(r => JSON.stringify(r)).join('\n') +
                     (this.rows.length ? '\n' : '');
    atomicWrite(this.filePath, contents);
  }
}

class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  save(obj) {
    atomicWrite(this.filePath, JSON.stringify(obj));
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw) return null;
    return JSON.parse(raw);
  }
}

module.exports = { BufferStore, ConfigStore, BUFFER_FIELDS };
