#!/usr/bin/env python3
"""
月末在庫スナップショット保存スクリプト
月末日の15:00 UTC（= JST翌1日0:00）にGitHub Actionsから実行し、
月末時点の品種別在庫をSupabaseに保存する。
"""

import sys
import os
import re
import json
from datetime import datetime, timezone, timedelta

import psycopg2
import requests

# 品種はMisoRecipe（有効なもの）から読む。ハードコードすると品種追加時に
# スナップショットから無言で抜け落ちる（フォールバックは従来の4品種）
FALLBACK_MISO_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ']

DEFAULT_YIELD_RATE = 0.95


def get_db_url():
    url = os.environ.get('DATABASE_URL', '')
    url = re.sub(r'[?&]pgbouncer=true', '', url)
    url = re.sub(r'\?$', '', url)
    return url


JST = timezone(timedelta(hours=9))


def get_prev_year_month():
    """JST基準で前月の yearMonth を返す（例: 2026-04）

    ワークフローは月末日の15:00 UTC（= JST翌1日0:00）に走るため、
    UTC基準で数えると1ヶ月ずれる。必ずJSTで判定する。
    """
    now = datetime.now(JST)
    first_of_this_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_month = first_of_this_month - timedelta(days=1)
    return last_month.strftime('%Y-%m')


def fetch_miso_types(conn):
    """有効な品種名を MisoRecipe から取得（表示順）"""
    cur = conn.cursor()
    cur.execute('SELECT name FROM "MisoRecipe" WHERE "isActive" = true ORDER BY "sortOrder" ASC')
    names = [row[0] for row in cur.fetchall()]
    return names or FALLBACK_MISO_TYPES


def fetch_yield_rate(conn):
    """歩留まり率（桶レコードが無いロットの概算に使う）"""
    cur = conn.cursor()
    cur.execute("""SELECT value FROM "SystemSetting" WHERE key = 'moisture_yieldRate'""")
    row = cur.fetchone()
    try:
        return float(row[0]) if row else DEFAULT_YIELD_RATE
    except (TypeError, ValueError):
        return DEFAULT_YIELD_RATE


def fetch_fermenting_kg(conn, yield_rate):
    """熟成中ロットの品種別残量をBucketから集計

    数え方は画面側（lib/lotStock.ts の fermentingKgOfLot）と揃える:
      - 「空」の桶は0
      - 残量が未入力の桶は初期重量とみなす
      - 桶レコードが無いロットは 仕立量 × 歩留まり で概算
    """
    cur = conn.cursor()
    cur.execute("""
        SELECT l."misoType",
               l."totalWeightKg",
               l."yieldRate",
               COUNT(b.id) AS bucket_count,
               COALESCE(SUM(
                 CASE WHEN b.status = '空' THEN 0
                      ELSE COALESCE(b."remainingWeightKg", b."initialWeightKg") END
               ), 0) AS bucket_kg
        FROM "Lot" l
        LEFT JOIN "Bucket" b ON b."lotId" = l.id
        WHERE l.status = '熟成中'
        GROUP BY l.id, l."misoType", l."totalWeightKg", l."yieldRate"
    """)
    result = {}
    for miso_type, total_kg, lot_yield, bucket_count, bucket_kg in cur.fetchall():
        if bucket_count > 0:
            kg = float(bucket_kg)
        else:
            kg = float(int(float(total_kg) * float(lot_yield if lot_yield is not None else yield_rate)))
        result[miso_type] = result.get(miso_type, 0.0) + kg
    return result


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


def save_snapshot(conn, year_month, miso_types, fermenting_map, aged_map):
    cur = conn.cursor()
    saved = 0

    # レシピに無い品種でも在庫・熟成中ロットに出てきたら記録する
    targets = list(miso_types)
    for extra in list(fermenting_map.keys()) + list(aged_map.keys()):
        if extra not in targets:
            targets.append(extra)

    for miso_type in targets:
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

        aged_label = f'{aged_kg:.0f}kg' if aged_kg is not None else '—'
        print(f'  {miso_type}: 熟成中={fermenting_kg:.0f}kg 熟成済={aged_label}', file=sys.stderr)
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
        miso_types     = fetch_miso_types(conn)
        yield_rate     = fetch_yield_rate(conn)
        fermenting_map = fetch_fermenting_kg(conn, yield_rate)
        aged_map       = fetch_aged_stock()

        print(f'対象品種: {miso_types}', file=sys.stderr)
        print(f'熟成中データ: {fermenting_map}', file=sys.stderr)
        print(f'熟成済データ: {aged_map}', file=sys.stderr)

        saved = save_snapshot(conn, year_month, miso_types, fermenting_map, aged_map)

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
