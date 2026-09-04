#!/usr/bin/env python3
"""
月別出荷実績の取り込み（外部API → ShipmentHistory）

なぜ必要か：
  画面（/planning）は外部APIの月別出荷を毎回マージして表示しているが、
  DBには保存していなかった。SARIMAX（scripts/forecast_sarimax.py）はPythonが
  ShipmentHistory を直接読むため、APIの値が届かず**直近の実績を知らないまま**
  予測していた（2026-09-04 時点でDBは2026-04まで、実際は8月まである）。
  予測の前にこれを走らせて、DBを最新にしてから学習させる。

上書き範囲は画面のマージと同じ 2026-01 以降。それ以前はExcel取り込みの値を正とする
（外部APIは2026年からのデータしか持っていない）。

実行: python scripts/sync_shipments.py
必要な環境変数: DATABASE_URL / SALES_API_URL / EXTERNAL_API_KEY
"""

import os
import re
import sys
from datetime import datetime, timezone, timedelta

import psycopg2
import requests

JST = timezone(timedelta(hours=9))

# 外部APIを正とする開始月（画面のマージ条件と揃えること）
API_FROM_YEAR_MONTH = '2026-01'


def get_db_url():
    url = os.environ.get('DATABASE_URL', '')
    url = re.sub(r'[?&]pgbouncer=true', '', url)
    url = re.sub(r'\?$', '', url)
    return url


def current_year_month():
    """JST基準の当月。APIは進行中の月も返すため、これを取り込むと
    月の途中の数字（例: 9/4時点で823kg）が実績として学習され予測が壊れる"""
    return datetime.now(JST).strftime('%Y-%m')


def fetch_monthly_sales(api_url, api_key):
    res = requests.get(api_url, headers={'X-API-Key': api_key}, timeout=30)
    res.raise_for_status()
    payload = res.json()
    items = payload if isinstance(payload, list) else payload.get('data', [])
    this_month = current_year_month()
    out = []
    skipped = 0
    for item in items:
        ym   = item.get('yearMonth')
        miso = item.get('misoType')
        kg   = item.get('weightKg')
        if not ym or not miso or kg is None:
            continue
        if ym < API_FROM_YEAR_MONTH:
            continue
        # 進行中の月は月末まで待つ（途中の数字を実績として入れない）
        if ym >= this_month:
            skipped += 1
            continue
        out.append((ym, miso, float(kg)))
    if skipped:
        print(f'当月（{this_month}）は未確定のため {skipped} 件を除外しました', file=sys.stderr)
    return out


def main():
    db_url  = get_db_url()
    api_url = os.environ.get('SALES_API_URL', '')
    api_key = os.environ.get('EXTERNAL_API_KEY', '')
    missing = [n for n, v in [('DATABASE_URL', db_url), ('SALES_API_URL', api_url),
                              ('EXTERNAL_API_KEY', api_key)] if not v]
    if missing:
        print(f'環境変数が未設定です: {", ".join(missing)}', file=sys.stderr)
        return 1

    try:
        rows = fetch_monthly_sales(api_url, api_key)
    except Exception as e:
        print(f'出荷実績APIの取得に失敗: {e}', file=sys.stderr)
        return 1

    if not rows:
        print('取り込む出荷実績がありません（APIが空を返しました）', file=sys.stderr)
        return 1

    conn = psycopg2.connect(db_url)
    try:
        cur = conn.cursor()
        for year_month, miso_type, weight_kg in rows:
            cur.execute("""
                INSERT INTO "ShipmentHistory"
                  (id, "yearMonth", "misoType", "weightKg", "importedAt")
                VALUES (gen_random_uuid()::text, %s, %s, %s, NOW())
                ON CONFLICT ("yearMonth", "misoType") DO UPDATE SET
                  "weightKg"   = EXCLUDED."weightKg",
                  "importedAt" = EXCLUDED."importedAt"
            """, (year_month, miso_type, weight_kg))
        conn.commit()
        months = sorted({r[0] for r in rows})
        print(f'出荷実績を取り込みました: {len(rows)}件 / {months[0]}〜{months[-1]}')
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
