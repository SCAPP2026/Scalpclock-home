#!/usr/bin/env python3
"""Refresh the constituent weights used by the Market Intelligence Center.

Writes functions/lib/etf-holdings-data.js (top holdings per ETF, with the
source, method and as-of date for each). Standard library only.

Sources, in order of preference:
  SPY  State Street daily holdings workbook            -> actual fund weights
  QQQ  Invesco holdings API (often blocks scripts)     -> actual fund weights
       fallback: Nasdaq's public Nasdaq-100 member list -> weights ESTIMATED
       from market cap (the index is modified-cap-weighted, so real weights
       differ somewhat); flagged method="estimated-market-cap"
  IWM  iShares holdings CSV (often blocks scripts)     -> actual fund weights
       no fallback: if it fails the ETF is written as unavailable and the UI
       says so rather than showing guessed numbers.

If a source fails, the previous good data for that ETF is kept (with its old
as-of date) instead of being overwritten with nothing.
"""
import csv, io, json, re, sys, urllib.request, zipfile, datetime, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'functions', 'lib', 'etf-holdings-data.js')
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
TOP_N = 25


def get(url, accept='*/*'):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-US,en;q=0.9'})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


def clean_name(name):
    name = re.sub(r'\s+', ' ', name.replace('&amp;', '&')).strip()
    return name.title() if name.isupper() else name


def top(rows):
    rows = [r for r in rows if r['ticker'] and re.fullmatch(r'[A-Z.]{1,6}', r['ticker']) and r['weight'] > 0]
    rows.sort(key=lambda r: -r['weight'])
    return [{'ticker': r['ticker'], 'name': clean_name(r['name']), 'weight': round(r['weight'], 3)} for r in rows[:TOP_N]]


def spy():
    raw = get('https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx')
    z = zipfile.ZipFile(io.BytesIO(raw))
    shared = [re.sub(r'<[^>]+>', '', s) for s in re.findall(r'<si>(.*?)</si>', z.read('xl/sharedStrings.xml').decode(), re.S)]
    sheet = z.read('xl/worksheets/sheet1.xml').decode()
    table, as_of, header = [], None, None
    for row in re.findall(r'<row[^>]*>(.*?)</row>', sheet, re.S):
        cells = []
        for attrs, v in re.findall(r'<c ([^>]*?)(?:/>|>(?:<v>(.*?)</v>)?.*?</c>)', row, re.S):
            cells.append(shared[int(v)] if 't="s"' in attrs and v else (v or ''))
        if not cells:
            continue
        if cells[0].startswith('Holdings') and len(cells) > 1:
            m = re.search(r'(\d{2}-\w{3}-\d{4})', cells[1])
            if m:
                as_of = datetime.datetime.strptime(m.group(1), '%d-%b-%Y').date().isoformat()
        elif cells[0] == 'Name' and 'Ticker' in cells and 'Weight' in cells:
            header = cells
        elif header and len(cells) >= len(header) - 1:
            rec = dict(zip(header, cells))
            try:
                table.append({'ticker': rec.get('Ticker', '').strip(), 'name': rec.get('Name', ''), 'weight': float(rec.get('Weight', 0))})
            except ValueError:
                pass
    if len(table) < 400:
        raise RuntimeError(f'only {len(table)} rows parsed')
    return {'source': 'State Street (SPY daily holdings file)', 'sourceUrl': 'https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy',
            'method': 'issuer-weights', 'asOf': as_of, 'count': len(table), 'holdings': top(table)}


def qqq_invesco():
    raw = get('https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/QQQ/holdings/fund?idType=ticker&interval=monthly&productType=ETF', 'application/json')
    d = json.loads(raw)
    rows = [{'ticker': h.get('ticker', ''), 'name': h.get('issuerName', ''), 'weight': float(h.get('percentageOfTotalNetAssets') or 0)} for h in d.get('holdings', [])]
    if len(rows) < 90:
        raise RuntimeError(f'only {len(rows)} rows')
    return {'source': 'Invesco (QQQ holdings)', 'sourceUrl': 'https://www.invesco.com/qqq-etf/en/about.html',
            'method': 'issuer-weights', 'asOf': (d.get('effectiveDate') or '')[:10] or None, 'count': len(rows), 'holdings': top(rows)}


def qqq_estimated():
    d = json.loads(get('https://api.nasdaq.com/api/quote/list-type/nasdaq100', 'application/json'))['data']['data']['rows']
    rows = []
    for r in d:
        cap = float(re.sub(r'[^0-9.]', '', r.get('marketCap') or '') or 0)
        rows.append({'ticker': r['symbol'], 'name': re.sub(r'\s+(Common Stock|Class [A-C].*|Ordinary Shares.*|American Depositary.*)$', '', r['companyName']), 'cap': cap})
    total = sum(r['cap'] for r in rows)
    if len(rows) < 95 or total <= 0:
        raise RuntimeError(f'only {len(rows)} members')
    for r in rows:
        r['weight'] = r['cap'] / total * 100
    return {'source': 'Nasdaq (Nasdaq-100 member list) — weights estimated from market cap', 'sourceUrl': 'https://www.nasdaq.com/market-activity/quotes/nasdaq-ndx-index',
            'method': 'estimated-market-cap', 'asOf': datetime.date.today().isoformat(), 'count': len(rows), 'holdings': top(rows)}


def iwm():
    raw = get('https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund', 'text/csv').decode('utf-8-sig', 'replace')
    if raw.lstrip().startswith('<'):
        raise RuntimeError('iShares returned a web page instead of the CSV')
    as_of = None
    m = re.search(r'Fund Holdings as of,"?([A-Za-z]{3} \d{1,2}, \d{4})', raw)
    if m:
        as_of = datetime.datetime.strptime(m.group(1), '%b %d, %Y').date().isoformat()
    start = raw.index('Ticker,Name')
    rows = []
    for rec in csv.DictReader(io.StringIO(raw[start:])):
        if (rec.get('Asset Class') or '') != 'Equity':
            continue
        try:
            rows.append({'ticker': (rec.get('Ticker') or '').strip(), 'name': rec.get('Name') or '', 'weight': float(rec.get('Weight (%)') or 0)})
        except ValueError:
            pass
    if len(rows) < 1500:
        raise RuntimeError(f'only {len(rows)} rows')
    return {'source': 'iShares (IWM holdings file)', 'sourceUrl': 'https://www.ishares.com/us/products/239710/ishares-russell-2000-etf',
            'method': 'issuer-weights', 'asOf': as_of, 'count': len(rows), 'holdings': top(rows)}


def load_previous():
    try:
        text = open(OUT).read()
        return json.loads(text[text.index('{'):text.rindex('}') + 1])
    except Exception:
        return {}


def main():
    prev = load_previous().get('etfs', {})
    plan = {'SPY': [spy], 'QQQ': [qqq_invesco, qqq_estimated], 'IWM': [iwm]}
    etfs, changed = {}, False
    for sym, fetchers in plan.items():
        result, errors = None, []
        for f in fetchers:
            try:
                result = f()
                break
            except Exception as e:  # noqa: BLE001 — every source failure is reported, never fatal
                errors.append(f'{f.__name__}: {e}')
        if result:
            print(f'{sym}: {result["method"]} — {len(result["holdings"])} of {result["count"]} holdings, as of {result["asOf"]}')
        elif prev.get(sym, {}).get('holdings'):
            result = prev[sym]
            print(f'{sym}: all sources failed, keeping data as of {result.get("asOf")} — {"; ".join(errors)}')
        else:
            result = {'source': None, 'sourceUrl': None, 'method': 'unavailable', 'asOf': None, 'count': 0, 'holdings': [],
                      'error': 'The issuer does not allow automated downloads of its holdings file.'}
            print(f'{sym}: unavailable — {"; ".join(errors)}')
        result['coveragePct'] = round(sum(h['weight'] for h in result['holdings']), 2)
        etfs[sym] = result
        if json.dumps(result, sort_keys=True) != json.dumps(prev.get(sym), sort_keys=True):
            changed = True
    if not changed:
        print('No change.')
        return
    body = json.dumps({'generatedAt': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z', 'topN': TOP_N, 'etfs': etfs}, indent=1, ensure_ascii=False)
    with open(OUT, 'w') as fh:
        fh.write('// GENERATED by scripts/update-etf-holdings.py — do not edit by hand.\n'
                 '// Top constituent weights for the Market Intelligence Center movers module.\n'
                 f'export default {body};\n')
    print('Wrote', os.path.relpath(OUT))


if __name__ == '__main__':
    sys.exit(main())
