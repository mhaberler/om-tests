# icon_wind

Two examples querying DWD ICON global model data directly from Open-Meteo's
public S3 mirror (`s3://openmeteo/data_run/dwd_icon/...`) — no API call,
just reading `.om` files over HTTPS range requests.

- `icon_wind.py` (Python) — 10m surface wind (speed + direction from u/v)
  at a lat/lon/time.
- `icon_wind_profile.mjs` (Node.js) — full vertical profile (13 pressure
  levels, 50–1000 hPa) at a lat/lon/time: temperature, relative humidity,
  wind speed and direction per level.

## Setup — Python (`icon_wind.py`)

```
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

## Setup — Node.js (`icon_wind_profile.mjs`)

```
npm install
```

## Usage

```
(.venv) BigMac-1019 src/om-tests $ python3 icon_wind.py --lat 52.52 --lon 13.405 --time 2026-09-29T12:00

{
  "requested": {
    "lat": 52.52,
    "lon": 13.405,
    "time": "2026-09-29T12:00:00+00:00"
  },
  "run_reference_time": "2026-09-28T00:00:00Z",
  "valid_time": "2026-09-29T12:00:00+00:00",
  "grid_point": {
    "lat": 52.5,
    "lon": 13.442167419242793,
    "iy": 1140,
    "ix": 1547
  },
  "wind_u_10m_ms": -2.299999952316284,
  "wind_v_10m_ms": 2.200000047683716,
  "wind_speed_10m_ms": 3.1827660910697255,
  "wind_direction_10m_deg": 133.7269711935998
}
```

`--time` is optional (ISO8601, UTC) and defaults to now. The script finds
the most recent ICON global run covering the requested time (looking back
through 6-hourly runs up to the ~7.5 day forecast horizon), snaps the
lat/lon to the nearest 0.125° grid point, and returns the nearest available
forecast step.

Runtime is dominated by network I/O (S3 range requests), not CPU:

```
0.45s user 0.10s system 8% cpu 6.615 total
```

### Node.js vertical profile

```
$ node icon_wind_profile.mjs --lat 52.52 --lon 13.405 --time 2026-09-29T12:00

{
  "requested": { "lat": 52.52, "lon": 13.405, "time": "2026-09-29T12:00:00.000Z" },
  "run_reference_time": "2026-09-28T00:00:00Z",
  "valid_time": "2026-09-29T12:00:00.000Z",
  "grid_point": { "lat": 52.5, "lon": 13.442167419242793, "iy": 1140, "ix": 1547 },
  "levels": [
    { "pressure_hpa": 1000, "temperature_c": 18.4, "relative_humidity_pct": 53,
      "wind_u_ms": -3.7, "wind_v_ms": 4.1, "wind_speed_ms": 5.52, "wind_direction_deg": 137.9 },
    { "pressure_hpa": 925, "...": "..." },
    "... (13 levels total, 1000 -> 50 hPa, near-surface first)"
  ]
}
```

Same run-lookup/grid-snap logic as `icon_wind.py`, reimplemented in JS since
the two runtimes can't share code — reads use the official
`@openmeteo/file-reader` WASM binding (`OmHttpBackend`) against plain
`https://openmeteo.s3.amazonaws.com/...` URLs (S3 serves public objects over
HTTPS with Range support, so no AWS SDK/credentials are needed).

## Example locations

| Place | lat | lon |
|---|---|---|
| Berlin, Germany | 52.52 | 13.405 |
| Stiwoll, Austria | 47.1333 | 15.2167 |

```
python3 icon_wind.py --lat 47.1333 --lon 15.2167
npm run profile -- --lat 47.1333 --lon 15.2167
```

<details>
<summary>Full vertical profile example output — Stiwoll, Austria</summary>

```
$ npm run profile

> om-tests@1.0.0 profile
> node icon_wind_profile.mjs --lat 47.1333 --lon 15.2167

{
  "requested": {
    "lat": 47.1333,
    "lon": 15.2167,
    "time": "2026-09-28T06:53:25.318Z"
  },
  "run_reference_time": "2026-09-28T00:00:00Z",
  "valid_time": "2026-09-28T07:00:00.000Z",
  "grid_point": {
    "lat": 47.125,
    "lon": 15.19277526919069,
    "iy": 1097,
    "ix": 1561
  },
  "levels": [
    { "pressure_hpa": 1000, "temperature_c": 15.3, "relative_humidity_pct": 80,
      "wind_u_ms": 0.3, "wind_v_ms": -0.2, "wind_speed_ms": 0.36, "wind_direction_deg": 303.7 },
    { "pressure_hpa": 925, "temperature_c": 11.92, "relative_humidity_pct": 72,
      "wind_u_ms": -0.45, "wind_v_ms": 0.45, "wind_speed_ms": 0.63, "wind_direction_deg": 135 },
    { "pressure_hpa": 850, "temperature_c": 8.93, "relative_humidity_pct": 79,
      "wind_u_ms": -0.51, "wind_v_ms": 0.63, "wind_speed_ms": 0.81, "wind_direction_deg": 141.3 },
    { "pressure_hpa": 700, "temperature_c": 3.2, "relative_humidity_pct": 43.3,
      "wind_u_ms": 0.69, "wind_v_ms": -9.66, "wind_speed_ms": 9.68, "wind_direction_deg": 355.9 },
    { "pressure_hpa": 600, "temperature_c": -4.42, "relative_humidity_pct": 57.5,
      "wind_u_ms": 0.91, "wind_v_ms": -15.45, "wind_speed_ms": 15.48, "wind_direction_deg": 356.6 },
    { "pressure_hpa": 500, "temperature_c": -13.07, "relative_humidity_pct": 28.6,
      "wind_u_ms": -1, "wind_v_ms": -14.67, "wind_speed_ms": 14.7, "wind_direction_deg": 3.9 },
    { "pressure_hpa": 400, "temperature_c": -25.14, "relative_humidity_pct": 58.3,
      "wind_u_ms": -0.33, "wind_v_ms": -9.67, "wind_speed_ms": 9.67, "wind_direction_deg": 2 },
    { "pressure_hpa": 300, "temperature_c": -40, "relative_humidity_pct": 30,
      "wind_u_ms": 4.67, "wind_v_ms": -13, "wind_speed_ms": 13.81, "wind_direction_deg": 340.3 },
    { "pressure_hpa": 250, "temperature_c": -48.5, "relative_humidity_pct": 22.2,
      "wind_u_ms": 6, "wind_v_ms": -13.67, "wind_speed_ms": 14.93, "wind_direction_deg": 336.3 },
    { "pressure_hpa": 200, "temperature_c": -59.5, "relative_humidity_pct": 40,
      "wind_u_ms": 4.33, "wind_v_ms": -10.67, "wind_speed_ms": 11.51, "wind_direction_deg": 337.9 },
    { "pressure_hpa": 150, "temperature_c": -62, "relative_humidity_pct": 8.6,
      "wind_u_ms": 1, "wind_v_ms": -7.67, "wind_speed_ms": 7.73, "wind_direction_deg": 352.6 },
    { "pressure_hpa": 100, "temperature_c": -61, "relative_humidity_pct": 3.3,
      "wind_u_ms": 0.33, "wind_v_ms": -2, "wind_speed_ms": 2.03, "wind_direction_deg": 350.5 },
    { "pressure_hpa": 50, "temperature_c": -57.5, "relative_humidity_pct": 0,
      "wind_u_ms": 3.33, "wind_v_ms": 0.67, "wind_speed_ms": 3.4, "wind_direction_deg": 258.7 }
  ]
}

npm run profile  1.34s user 0.25s system 2% cpu 53.969 total
```

</details>

Runtime for the full profile is dominated by network I/O: 52 separate `.om`
files are fetched (4 variables × 13 levels), each requiring its own HTTP
Range request round-trip against S3 — ~54s wall clock vs ~1.3s CPU time.
`icon_wind.py`'s single-level 10m query only fetches 2 files, hence the much
faster ~6.6s runtime noted above.
