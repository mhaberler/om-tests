#!/usr/bin/env node
// Query a DWD ICON global vertical profile (all pressure levels: wind speed,
// wind direction, temperature, humidity, pressure) at a lat/lon/time, reading
// directly from Open-Meteo's public S3 mirror over HTTPS range requests
// (no AWS SDK / credentials needed — the bucket is public-read).
import { OmFileReader, OmHttpBackend, OmDataType } from "@openmeteo/file-reader";

const BUCKET_URL = "https://openmeteo.s3.amazonaws.com";
const MODEL_PREFIX = "data_run/dwd_icon";
const RUN_HOURS = [0, 6, 12, 18];
const MAX_RUN_LOOKBACK = 40; // 6h-spaced runs; covers the ~7.5 day forecast horizon
const PRESSURE_LEVELS_HPA = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50];

function runPrefix(runDt) {
  const y = runDt.getUTCFullYear();
  const m = String(runDt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(runDt.getUTCDate()).padStart(2, "0");
  const h = String(runDt.getUTCHours()).padStart(2, "0");
  return `${MODEL_PREFIX}/${y}/${m}/${d}/${h}00Z`;
}

function* candidateRunTimes(targetDt) {
  let runDt = new Date(targetDt);
  runDt.setUTCMinutes(0, 0, 0);
  while (!RUN_HOURS.includes(runDt.getUTCHours())) {
    runDt = new Date(runDt.getTime() - 3600_000);
  }
  for (let i = 0; i < MAX_RUN_LOOKBACK; i++) {
    yield new Date(runDt);
    runDt = new Date(runDt.getTime() - 6 * 3600_000);
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function findRun(targetDt) {
  for (const runDt of candidateRunTimes(targetDt)) {
    const prefix = runPrefix(runDt);
    const meta = await fetchJson(`${BUCKET_URL}/${prefix}/meta.json`);
    if (!meta) continue;
    const parsed = meta.valid_times.map((t) => new Date(t));
    if (parsed[0] <= targetDt && targetDt <= parsed[parsed.length - 1]) {
      return { ...meta, runPrefix: prefix, validTimes: parsed };
    }
  }
  throw new Error(`No ICON global run found covering ${targetDt.toISOString()}`);
}

function nearestTimeIndex(validTimes, targetDt) {
  let best = 0;
  let bestDiff = Infinity;
  validTimes.forEach((t, i) => {
    const diff = Math.abs(t.getTime() - targetDt.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  });
  return best;
}

function gridIndex(shape, lat, lon) {
  const [nLat, nLon] = shape;
  const dLat = 180.0 / (nLat - 1);
  const dLon = 360.0 / nLon;
  const normLon = ((lon + 180.0) % 360.0 + 360.0) % 360.0 - 180.0;
  let iy = Math.round((lat + 90.0) / dLat);
  let ix = ((Math.round((normLon + 180.0) / dLon) % nLon) + nLon) % nLon;
  iy = Math.max(0, Math.min(nLat - 1, iy));
  return { iy, ix, gridLat: -90.0 + iy * dLat, gridLon: -180.0 + ix * dLon };
}

async function readPoint(runPrefix, variable, iy, ix, it) {
  const backend = new OmHttpBackend({ url: `${BUCKET_URL}/${runPrefix}/${variable}.om` });
  const reader = await OmFileReader.create(backend);
  const data = await reader.read({
    type: OmDataType.FloatArray,
    ranges: [
      { start: iy, end: iy + 1 },
      { start: ix, end: ix + 1 },
      { start: it, end: it + 1 },
    ],
  });
  const shape = reader.getDimensions();
  reader.dispose();
  await backend.close();
  return { value: data[0], shape };
}

function windDirectionDeg(u, v) {
  return (180.0 + (Math.atan2(u, v) * 180.0) / Math.PI + 360.0) % 360.0;
}

async function querySurfaceProfile(lat, lon, when) {
  const meta = await findRun(when);
  const it = nearestTimeIndex(meta.validTimes, when);

  // grid is identical across variables/levels; derive index once from the first level's u-component
  const first = await readPoint(meta.runPrefix, `wind_u_component_${PRESSURE_LEVELS_HPA[0]}hPa`, 0, 0, 0);
  const { iy, ix, gridLat, gridLon } = gridIndex(first.shape, lat, lon);

  const levels = [];
  for (const level of PRESSURE_LEVELS_HPA) {
    const [u, v, t, rh] = await Promise.all([
      readPoint(meta.runPrefix, `wind_u_component_${level}hPa`, iy, ix, it),
      readPoint(meta.runPrefix, `wind_v_component_${level}hPa`, iy, ix, it),
      readPoint(meta.runPrefix, `temperature_${level}hPa`, iy, ix, it),
      readPoint(meta.runPrefix, `relative_humidity_${level}hPa`, iy, ix, it),
    ]);
    levels.push({
      pressure_hpa: level,
      temperature_c: t.value,
      relative_humidity_pct: rh.value,
      wind_u_ms: u.value,
      wind_v_ms: v.value,
      wind_speed_ms: Math.hypot(u.value, v.value),
      wind_direction_deg: windDirectionDeg(u.value, v.value),
    });
  }
  // near-surface first (highest pressure = lowest altitude)
  levels.sort((a, b) => b.pressure_hpa - a.pressure_hpa);

  return {
    requested: { lat, lon, time: when.toISOString() },
    run_reference_time: meta.reference_time,
    valid_time: meta.validTimes[it].toISOString(),
    grid_point: { lat: gridLat, lon: gridLon, iy, ix },
    levels,
  };
}

function parseArgs(argv) {
  const args = { time: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lat") args.lat = parseFloat(argv[++i]);
    else if (argv[i] === "--lon") args.lon = parseFloat(argv[++i]);
    else if (argv[i] === "--time") args.time = argv[++i];
  }
  if (args.lat === undefined || args.lon === undefined) {
    console.error("Usage: node icon_wind_profile.mjs --lat <lat> --lon <lon> [--time <ISO8601 UTC>]");
    process.exit(1);
  }
  return args;
}

function parseUtc(iso) {
  // Bare ISO8601 (no timezone suffix) is local time to Date() — force UTC to match
  // the Python example's convention, unless the caller already specified an offset.
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(iso);
  return new Date(hasTz ? iso : `${iso}Z`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const when = args.time ? parseUtc(args.time) : new Date();
  const result = await querySurfaceProfile(args.lat, args.lon, when);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
