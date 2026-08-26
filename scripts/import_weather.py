#!/usr/bin/env python3
"""
気象データ(WeatherCache)自動取り込みスクリプト。
GitHub Actionsから毎日実行し、当月分（気象庁が当日までに公開済みの分）を取り込む。
月初の数日は前月分がまだ確定していないことがあるため、前月も併せて取り込む。
"""

import os
import re
import sys
import json
from datetime import datetime, timezone, timedelta

import psycopg2
import requests

PREC_NO = '81'
BLOCK_NO = '0775'  # 防府（気象庁内部コード）
BASE_URL = 'https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php'

ROW_RE = re.compile(r'<tr\s+class="mtx"\s+style="text-align:right;">([\s\S]*?)</tr>')
DAY_RE = re.compile(r'day=(\d{1,2})')
CELL_RE = re.compile(r'<td[^>]*class=data_0_0[^>]*>([\s\S]*?)</td>')
TAG_RE = re.compile(r'<[^>]*>')


def get_db_url():
    url = os.environ.get('DATABASE_URL', '')
    url = re.sub(r'[?&]pgbouncer=true', '', url)
    url = re.sub(r'\?$', '', url)
    return url


def fetch_monthly_weather(year, month):
    """指定年月の日別平均気温を取得（app/lib/weatherFetch.ts と同じロジック）"""
    url = f'{BASE_URL}?prec_no={PREC_NO}&block_no={BLOCK_NO}&year={year}&month={month}&day=&view='
    res = requests.get(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; miso-system)'}, timeout=30)
    res.raise_for_status()
    html = res.text

    results = []
    for row_match in ROW_RE.finditer(html):
        content = row_match.group(1)
        day_match = DAY_RE.search(content)
        if not day_match:
            continue
        day = int(day_match.group(1))
        if day < 1 or day > 31:
            continue

        cells = [TAG_RE.sub('', c).strip() for c in CELL_RE.findall(content)]
        if len(cells) < 4:
            continue
        try:
            avg_temp = float(cells[3])
        except ValueError:
            continue

        date = datetime(year, month, day, tzinfo=timezone.utc)
        effective_temp = max(avg_temp - 10, 0)
        results.append((date, avg_temp, effective_temp))

    return results


def upsert_weather(conn, days):
    if not days:
        return 0
    cur = conn.cursor()
    for date, avg_temp, effective_temp in days:
        cur.execute("""
            INSERT INTO "WeatherCache" (date, "avgTempC", "effectiveTemp")
            VALUES (%s, %s, %s)
            ON CONFLICT (date) DO UPDATE SET
              "avgTempC" = EXCLUDED."avgTempC",
              "effectiveTemp" = EXCLUDED."effectiveTemp"
        """, (date, avg_temp, effective_temp))
    conn.commit()
    return len(days)


def main():
    db_url = get_db_url()
    if not db_url:
        print(json.dumps({'ok': False, 'error': 'DATABASE_URL が設定されていません'}, ensure_ascii=False))
        sys.exit(1)

    now = datetime.now(timezone.utc)
    targets = [(now.year, now.month)]
    # 月初数日は前月分がまだ確定していないことがあるため念のため併せて取り込む
    if now.day <= 3:
        prev = now.replace(day=1) - timedelta(days=1)
        targets.append((prev.year, prev.month))

    conn = psycopg2.connect(db_url)
    try:
        total = 0
        for year, month in targets:
            try:
                days = fetch_monthly_weather(year, month)
                saved = upsert_weather(conn, days)
                total += saved
                print(f'{year}年{month}月: {saved}件取り込み', file=sys.stderr)
            except Exception as e:
                print(f'{year}年{month}月: 取得失敗 {e}', file=sys.stderr)

        print(json.dumps({'ok': True, 'saved': total}, ensure_ascii=False))
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        sys.exit(1)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
