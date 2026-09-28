#!/usr/bin/env python3
"""Query DWD ICON global 10m wind (speed + direction) at a lat/lon/time
from Open-Meteo's public S3 mirror (s3://openmeteo/data_run/dwd_icon/...).
"""
import argparse
import json
import math
from datetime import datetime, timedelta, timezone

import s3fs
from omfiles import OmFileReader

BUCKET = "openmeteo"
MODEL_PREFIX = f"{BUCKET}/data_run/dwd_icon"
RUN_HOURS = (0, 6, 12, 18)
MAX_RUN_LOOKBACK = 40  # synoptic runs (6h apart) to search backwards; covers the ~7.5 day forecast horizon


def _run_prefix(run_dt: datetime) -> str:
    return f"{MODEL_PREFIX}/{run_dt:%Y/%m/%d}/{run_dt:%H}00Z"


def _candidate_run_times(target_dt: datetime):
    run_dt = target_dt.replace(minute=0, second=0, microsecond=0)
    while run_dt.hour not in RUN_HOURS:
        run_dt -= timedelta(hours=1)
    for _ in range(MAX_RUN_LOOKBACK):
        yield run_dt
        run_dt -= timedelta(hours=6)


def find_run(fs: s3fs.S3FileSystem, target_dt: datetime) -> dict:
    """Find the most recent ICON global run whose forecast window covers target_dt."""
    for run_dt in _candidate_run_times(target_dt):
        meta_path = f"{_run_prefix(run_dt)}/meta.json"
        if not fs.exists(meta_path):
            continue
        with fs.open(meta_path) as f:
            meta = json.load(f)
        valid_times = [datetime.strptime(t, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
                       for t in meta["valid_times"]]
        if valid_times[0] <= target_dt <= valid_times[-1]:
            meta["_run_prefix"] = _run_prefix(run_dt)
            meta["_valid_times"] = valid_times
            return meta
    raise RuntimeError(f"No ICON global run found covering {target_dt.isoformat()}")


def nearest_time_index(valid_times: list, target_dt: datetime) -> int:
    return min(range(len(valid_times)), key=lambda i: abs((valid_times[i] - target_dt).total_seconds()))


def grid_index(shape, lat: float, lon: float):
    """Nearest-neighbour index into ICON global's regular 0.125 deg lat/lon grid.

    shape is (n_lat, n_lon, n_time); grid spans -90..90 (lat) and -180..180 (lon).
    """
    n_lat, n_lon, _ = shape
    dlat = 180.0 / (n_lat - 1)
    dlon = 360.0 / n_lon
    lon = ((lon + 180.0) % 360.0) - 180.0  # normalize to [-180, 180)
    iy = round((lat + 90.0) / dlat)
    ix = round((lon + 180.0) / dlon) % n_lon
    iy = max(0, min(n_lat - 1, iy))
    return iy, ix, -90.0 + iy * dlat, -180.0 + ix * dlon


def read_point(fs: s3fs.S3FileSystem, run_prefix: str, variable: str, iy: int, ix: int, it: int) -> float:
    path = f"{run_prefix}/{variable}.om"
    with fs.open(path, "rb") as f:
        reader = OmFileReader(f)
        value = reader.read_array((slice(iy, iy + 1), slice(ix, ix + 1), slice(it, it + 1)))
        reader.close()
    return float(value.reshape(-1)[0])


def wind_direction_deg(u: float, v: float) -> float:
    """Meteorological direction wind is blowing FROM, in degrees."""
    return (180.0 + math.degrees(math.atan2(u, v))) % 360.0


def query_surface_wind(lat: float, lon: float, when: datetime) -> dict:
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    fs = s3fs.S3FileSystem(anon=True)

    meta = find_run(fs, when)
    run_prefix = meta["_run_prefix"]
    valid_times = meta["_valid_times"]
    it = nearest_time_index(valid_times, when)

    with fs.open(f"{run_prefix}/wind_u_component_10m.om", "rb") as f:
        shape = OmFileReader(f).shape
    iy, ix, grid_lat, grid_lon = grid_index(shape, lat, lon)

    u = read_point(fs, run_prefix, "wind_u_component_10m", iy, ix, it)
    v = read_point(fs, run_prefix, "wind_v_component_10m", iy, ix, it)
    speed = math.hypot(u, v)
    direction = wind_direction_deg(u, v)

    return {
        "requested": {"lat": lat, "lon": lon, "time": when.isoformat()},
        "run_reference_time": meta["reference_time"],
        "valid_time": valid_times[it].isoformat(),
        "grid_point": {"lat": grid_lat, "lon": grid_lon, "iy": iy, "ix": ix},
        "wind_u_10m_ms": u,
        "wind_v_10m_ms": v,
        "wind_speed_10m_ms": speed,
        "wind_direction_10m_deg": direction,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--lon", type=float, required=True)
    parser.add_argument("--time", type=str, default=None,
                         help="ISO8601 UTC time, e.g. 2026-09-29T12:00. Defaults to now.")
    args = parser.parse_args()

    when = datetime.now(timezone.utc) if args.time is None else datetime.fromisoformat(args.time)
    result = query_surface_wind(args.lat, args.lon, when)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
