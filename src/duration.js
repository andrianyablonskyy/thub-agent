/**
 * @file        packages/agent/src/duration.js
 * @description Parses human-readable durations (e.g. 30m, 1h) into seconds
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

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
