#!/usr/bin/env python3
"""Add a city-wide boundary to the tracker's small-city submarket layer.

For deals in small cities far outside the covered MSAs, the whole city acts as
its own submarket. This pulls the official incorporated-place boundary from
Census TIGERweb and appends it to data/submarkets/cities.geojson (creating the
file if needed). Re-running for the same city replaces its old polygon.

Usage:
    python3 tools/fetch_city_boundary.py "Waco" TX
    python3 tools/fetch_city_boundary.py "Athens" GA        # matches Athens-Clarke County etc.
    python3 tools/fetch_city_boundary.py --remove "Waco" TX

No dependencies beyond the standard library.
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'submarkets' / 'cities.geojson'

# TIGERweb current incorporated places layer (ArcGIS REST, returns GeoJSON)
TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/28/query'

STATE_FIPS = {
    'AL': '01', 'AK': '02', 'AZ': '04', 'AR': '05', 'CA': '06', 'CO': '08', 'CT': '09',
    'DE': '10', 'DC': '11', 'FL': '12', 'GA': '13', 'HI': '15', 'ID': '16', 'IL': '17',
    'IN': '18', 'IA': '19', 'KS': '20', 'KY': '21', 'LA': '22', 'ME': '23', 'MD': '24',
    'MA': '25', 'MI': '26', 'MN': '27', 'MS': '28', 'MO': '29', 'MT': '30', 'NE': '31',
    'NV': '32', 'NH': '33', 'NJ': '34', 'NM': '35', 'NY': '36', 'NC': '37', 'ND': '38',
    'OH': '39', 'OK': '40', 'OR': '41', 'PA': '42', 'RI': '44', 'SC': '45', 'SD': '46',
    'TN': '47', 'TX': '48', 'UT': '49', 'VT': '50', 'VA': '51', 'WA': '53', 'WV': '54',
    'WI': '55', 'WY': '56',
}


def load_collection():
    if OUT.exists():
        return json.loads(OUT.read_text())
    return {'type': 'FeatureCollection', 'features': []}


def save_collection(fc):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fc, separators=(',', ':')))
    print(f'wrote {OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT} '
          f'({len(fc["features"])} city boundaries)')


def fetch(city, state):
    fips = STATE_FIPS[state.upper()]
    params = {
        'where': f"UPPER(BASENAME) = '{city.upper()}' AND STATE = '{fips}'",
        'outFields': 'NAME,BASENAME,STATE,GEOID',
        'returnGeometry': 'true',
        'geometryPrecision': '5',
        'outSR': '4326',
        'f': 'geojson',
    }
    url = TIGER + '?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as r:
        data = json.loads(r.read())
    feats = data.get('features', [])
    if not feats:
        # fall back to a fuzzy match (handles consolidated names like "Athens-Clarke County")
        params['where'] = f"UPPER(BASENAME) LIKE '{city.upper()}%' AND STATE = '{fips}'"
        url = TIGER + '?' + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=60) as r:
            data = json.loads(r.read())
        feats = data.get('features', [])
    if not feats:
        raise SystemExit(f'No incorporated place matching "{city}, {state}" in TIGERweb.')
    if len(feats) > 1:
        names = [f['properties'].get('NAME') for f in feats]
        print(f'note: {len(feats)} matches ({", ".join(names)}) — using the first')
    return feats[0]


def key(f):
    return (f['properties'].get('city', '').upper(), f['properties'].get('state', '').upper())


def main():
    args = [a for a in sys.argv[1:] if a != '--remove']
    remove = '--remove' in sys.argv
    if len(args) != 2:
        raise SystemExit(__doc__)
    city, state = args[0], args[1].upper()
    if state not in STATE_FIPS:
        raise SystemExit(f'Unknown state abbreviation: {state}')

    fc = load_collection()
    fc['features'] = [f for f in fc['features'] if key(f) != (city.upper(), state)]
    if remove:
        save_collection(fc)
        return

    raw = fetch(city, state)
    base = raw['properties'].get('BASENAME') or raw['properties'].get('NAME') or city
    feature = {
        'type': 'Feature',
        'properties': {
            # same attribute shape as the metro submarket layers
            'name': f'{base} (City Limits)',
            'submkt': f'{base} (City Limits)',
            'metro': 'Standalone',
            'asset': 'All',
            'city': city,
            'state': state,
            'geoid': raw['properties'].get('GEOID'),
            'source': 'Census TIGERweb incorporated places',
        },
        'geometry': raw['geometry'],
    }
    fc['features'].append(feature)
    save_collection(fc)
    print(f'added: {feature["properties"]["name"]}, {state}')


if __name__ == '__main__':
    main()
