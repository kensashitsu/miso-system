#!/usr/bin/env python3
"""
月末在庫スナップショット保存スクリプト
毎月1日にGitHub Actionsから実行し、前月末時点の品種別在庫をSupabaseに保存する。
"""

import sys
import os
import re
import json
from datetime import datetime, timezone, timedelta

import psycopg2
import requests

MISO_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ']


def get_db_url():
    url = os.environ.get('DATABASE_URL', '')
    url = re.sub(r'[?&]pgbouncer=true', '', url)
    url = re.sub(r'\?$', '', url)
    return url


def get_prev_year_month():
    """前月の yearMonth を返す（例: 2026-04）"""
    now = datetime.now(timezone.utc)
    first_of_this_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_month = first_of_this_month - timedelta(days=1)
    return last_month.strftime('%Y-%m')


def fetch_fermenting_kg(conn):
    """熟成中ロットの品種別残量をBucketから集計"""
    cur = conn.cursor()
    cur.execute("""
        SELECT l."misoType",
               SUM(COALESCE(b."remainingWeightKg", b."initialWeightKg")) AS fermenting_kg
        FROM "Lot" l
        JOIN "Bucket" b ON b."lotId" = l.id
        WHERE l.status = '熟成中'
        GROUP BY l."misoType"
    """)
    return {row[0]: float(row[1]) for row in cur.fetchall()}


def fetch_aged_stock():
    """外部APIから熟成済在庫・小分け製品在庫を取得"""
    api_url = os.environ.get('STOCK_API_URL', '')
    api_key = os.environ.get('EXTERNAL_API_KEY', '')

    if not api_url or not api_key:
        print('STOCK_API_URL または EXTERNAL_API_KEY が未設定のためスキップ', file=sys.stderr)
        return {}

    try:
        res = requests.get(api_url, headers={'X-API-Key': api_key}, timeout=30)
        res.raise_for_status()
        items = res.json()
        result = {}
        for item in items:
            miso_type = item.get('misoType')
            if miso_type:
                result[miso_type] = {
                    'agedKg':     float(item.get('agedStockKg') or item.get('stockKg') or 0),
                    'packagedKg': float(item.get('packagedStockKg') or 0) or None,
                }
        return result
    except Exception as e:
        print(f'外部API取得エラー: {e}', file=sys.stderr)
        return {}


def save_snapshot(conn, year_month, fermenting_map, aged_map):
    cur = conn.cursor()
    saved = 0

    for miso_type in MISO_TYPES:
        fermenting_kg = fermenting_map.get(miso_type, 0.0)
        aged_info     = aged_map.get(miso_type, {})
        aged_kg       = aged_info.get('agedKg', None)
        packaged_kg   = aged_info.get('packagedKg', None)

        cur.execute("""
            INSERT INTO "MonthlyInventorySnapshot"
              (id, "yearMonth", "misoType", "fermentingKg", "agedKg", "packagedKg", "recordedAt")
            VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT ("yearMonth", "misoType") DO UPDATE SET
              "fermentingKg" = EXCLUDED."fermentingKg",
              "agedKg"       = EXCLUDED."agedKg",
              "packagedKg"   = EXCLUDED."packagedKg",
              "recordedAt"   = EXCLUDED."recordedAt"
        """, (year_month, miso_type, fermenting_kg, aged_kg, packaged_kg))

        print(f'  {miso_type}: 熟成中={fermenting_kg:.0f}kg'
              f' 熟成済={aged_kg:.0f}kg' if aged_kg is not None else
              f'  {miso_type}: 熟成中={fermenting_kg:.0f}kg 熟成済=—',
              file=sys.stderr)
        saved += 1

    conn.commit()
    print(f'{saved}件のスナップショットを保存しました（{year_month}）', file=sys.stderr)
    return saved


def main():
    db_url = get_db_url()
    if not db_url:
        print(json.dumps({'ok': False, 'error': 'DATABASE_URL が設定されていません'},
                         ensure_ascii=False))
        sys.exit(1)

    year_month = get_prev_year_month()
    print(f'スナップショット対象: {year_month}', file=sys.stderr)

    conn = psycopg2.connect(db_url)
    try:
        fermenting_map = fetch_fermenting_kg(conn)
        aged_map       = fetch_aged_stock()

        print(f'熟成中データ: {fermenting_map}', file=sys.stderr)
        print(f'熟成済データ: {aged_map}', file=sys.stderr)

        saved = save_snapshot(conn, year_month, fermenting_map, aged_map)

        print(json.dumps({'ok': True, 'yearMonth': year_month, 'saved': saved},
                         ensure_ascii=False))

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        sys.exit(1)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
