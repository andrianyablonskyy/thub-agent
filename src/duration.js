'use strict';

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

function parseDurationSec(input) {
  if (input === undefined) return undefined;
  if (typeof input === 'number') return input;
  const match = /^(\d+)([smhd])?$/.exec(String(input).trim());
  if (!match) throw new Error(`Invalid duration "${input}" — use e.g. 30m, 1h, 900s`);
  const [, n, unit] = match;
  return Number(n) * (UNITS[unit] || 1);
}

module.exports = { parseDurationSec };
