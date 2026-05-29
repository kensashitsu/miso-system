#!/usr/bin/env python3
"""
需要予測: log-SARIMA + XGBoost 単純平均アンサンブル
  XGBoost特徴量に人口インデックスを追加（品種別スコープ）
    無添加麦みそ → 全国人口
    田舎みそ・山吹みそ・白みそ → 山口県人口
"""

import sys
import os
import re
import json
import warnings
from pathlib import Path
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
from statsmodels.tsa.statespace.sarimax import SARIMAX
import xgboost as xgb

warnings.filterwarnings('ignore')

MISO_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ']

# log-SARIMA: 航空機モデル優先、失敗時フォールバック
SARIMA_ORDER       = (0, 1, 1)
SARIMA_SEASONAL    = (0, 1, 1, 12)
SARIMA_FB_ORDER    = (1, 1, 1)
SARIMA_FB_SEASONAL = (1, 0, 1, 12)

N_FORECAST = 12
N_EVAL     = 24   # LOO評価月数
MIN_TRAIN  = 36


# ─────────────────────────────────────────────
# 人口データ（年次・1月1日基準）
# ─────────────────────────────────────────────

_POP_YAMAGUCHI = {
    2013: 1_426_000,
    2014: 1_415_000,
    2015: 1_404_729,
    2016: 1_392_000,
    2017: 1_379_000,
    2018: 1_366_000,
    2019: 1_354_000,
    2020: 1_342_059,
    2021: 1_328_000,
    2022: 1_315_000,
    2023: 1_302_000,
    2024: 1_289_000,
    2025: 1_275_000,
    2026: 1_262_000,
    2027: 1_249_000,
}

_POP_NATIONAL = {
    2013: 127_298_000,
    2014: 127_237_000,
    2015: 127_095_000,
    2016: 126_933_000,
    2017: 126_706_000,
    2018: 126_443_000,
    2019: 126_167_000,
    2020: 125_708_000,
    2021: 125_502_000,
    2022: 125_009_000,
    2023: 124_352_000,
    2024: 123_800_000,
    2025: 123_200_000,
    2026: 122_600_000,
    2027: 122_000_000,
}

_MISO_POP_DATA = {
    '無添加麦みそ': _POP_NATIONAL,
    '田舎みそ':     _POP_YAMAGUCHI,
    '山吹みそ':     _POP_YAMAGUCHI,
    '白みそ':       _POP_YAMAGUCHI,
}

MISO_USE_POPULATION = {'白みそ'}


def get_population_index(miso_type, yms):
    pop_data = _MISO_POP_DATA.get(miso_type, _POP_NATIONAL)
    years    = sorted(pop_data.keys())
    base_pop = pop_data[years[0]]

    def pop_at(year, month):
        frac = year + (month - 1) / 12
        y_lo = years[0] if frac <= years[0] else max(y for y in years if y <= frac)
        y_hi = years[-1] if frac >= years[-1] else min(y for y in years if y > frac)
        if y_lo == y_hi:
            return pop_data[y_lo]
        t = (frac - y_lo) / (y_hi - y_lo)
        return pop_data[y_lo] + t * (pop_data[y_hi] - pop_data[y_lo])

    result = []
    for ym in yms:
        year  = int(ym[:4])
        month = int(ym[5:7])
        if year < years[0] or (year == years[0] and month < 1):
            y1, y2 = years[0], years[1]
            slope  = (pop_data[y2] - pop_data[y1])
            p = pop_data[y1] + slope * (year + (month-1)/12 - y1)
        elif year > years[-1] or (year == years[-1] and month > 1):
            y1, y2 = years[-2], years[-1]
            slope  = (pop_data[y2] - pop_data[y1])
            p = pop_data[y2] + slope * (year + (month-1)/12 - y2)
        else:
            p = pop_at(year, month)
        result.append(p / base_pop)

    return result


# ─────────────────────────────────────────────
# DB接続
# ─────────────────────────────────────────────

def get_db_url():
    url = os.environ.get('DATABASE_URL', '')
    # pgbouncer パラメータを除去（psycopg2非対応）
    url = re.sub(r'[?&]pgbouncer=true', '', url)
    url = re.sub(r'\?$', '', url)
    return url


# ─────────────────────────────────────────────
# データ読み込み
# ─────────────────────────────────────────────

def load_shipment_data(conn):
    return pd.read_sql_query(
        'SELECT "yearMonth", "misoType", "weightKg" FROM "ShipmentHistory" ORDER BY "yearMonth"',
        conn,
    )


def load_weather_data(conn):
    df = pd.read_sql_query(
        'SELECT date, "avgTempC" FROM "WeatherCache" ORDER BY date',
        conn,
    )
    if df.empty:
        return pd.DataFrame(columns=['yearMonth', 'avgTempC'])
    df['yearMonth'] = pd.to_datetime(df['date'], utc=True).dt.strftime('%Y-%m')
    return df.groupby('yearMonth')['avgTempC'].mean().reset_index()


def get_seasonal_avg_temp(weather_monthly):
    if weather_monthly.empty:
        return {}
    wm = weather_monthly.copy()
    wm['month'] = wm['yearMonth'].str[5:7].astype(int)
    return wm.groupby('month')['avgTempC'].mean().to_dict()


# ─────────────────────────────────────────────
# XGBoost 特徴量
# ─────────────────────────────────────────────

def build_features(yms, values, temps, pop_index=None):
    rows = []
    for i in range(len(values)):
        month = int(yms[i][5:7])
        v = values
        row = {
            'month_sin': np.sin(2 * np.pi * month / 12),
            'month_cos': np.cos(2 * np.pi * month / 12),
            'temp':      temps[i],
            'lag1':      v[i-1]  if i >= 1  else np.nan,
            'lag2':      v[i-2]  if i >= 2  else np.nan,
            'lag3':      v[i-3]  if i >= 3  else np.nan,
            'lag6':      v[i-6]  if i >= 6  else np.nan,
            'lag12':     v[i-12] if i >= 12 else np.nan,
            'lag24':     v[i-24] if i >= 24 else np.nan,
            'roll3':     float(np.mean(v[max(0,i-3):i]))  if i >= 1 else np.nan,
            'roll12':    float(np.mean(v[max(0,i-12):i])) if i >= 3 else np.nan,
        }
        if pop_index is not None:
            row['pop_index'] = pop_index[i]
        rows.append(row)
    return pd.DataFrame(rows)


# ─────────────────────────────────────────────
# log-SARIMA
# ─────────────────────────────────────────────

def sarima_loo_step(train_y, train_x, pred_x):
    y_log = np.log1p(train_y)
    for order, seasonal in [(SARIMA_ORDER, SARIMA_SEASONAL),
                             (SARIMA_FB_ORDER, SARIMA_FB_SEASONAL)]:
        try:
            res = SARIMAX(y_log, exog=train_x, order=order, seasonal_order=seasonal,
                          enforce_stationarity=False, enforce_invertibility=False
                          ).fit(disp=False, maxiter=50)
            return max(0.0, float(np.expm1(np.asarray(res.forecast(1, exog=pred_x), float)[0])))
        except Exception:
            continue
    return None


def sarima_forecast(y, exog, future_exog, steps):
    y_log = np.log1p(y)
    for order, seasonal in [(SARIMA_ORDER, SARIMA_SEASONAL),
                             (SARIMA_FB_ORDER, SARIMA_FB_SEASONAL)]:
        try:
            res = SARIMAX(y_log, exog=exog, order=order, seasonal_order=seasonal,
                          enforce_stationarity=False, enforce_invertibility=False
                          ).fit(disp=False, maxiter=200)
            fc  = res.get_forecast(steps=steps, exog=future_exog)
            ml  = np.asarray(fc.predicted_mean, float)
            ci  = np.asarray(fc.conf_int(alpha=0.10), float)
            print(f'  log-SARIMA {order}×{seasonal} AIC={res.aic:.1f}', file=sys.stderr)
            return (np.maximum(0, np.expm1(ml)),
                    np.maximum(0, np.expm1(ci[:, 0])),
                    np.maximum(0, np.expm1(ci[:, 1])))
        except Exception:
            continue
    return None, None, None


# ─────────────────────────────────────────────
# XGBoost
# ─────────────────────────────────────────────

def _xgb_model():
    return xgb.XGBRegressor(n_estimators=300, max_depth=4, learning_rate=0.05,
                             subsample=0.8, colsample_bytree=0.8,
                             random_state=42, verbosity=0)


def xgb_loo_step(feat_df, values, i):
    if i < MIN_TRAIN:
        return None
    X_tr = feat_df.iloc[:i].dropna()
    if len(X_tr) < MIN_TRAIN:
        return None
    X_pr = feat_df.iloc[[i]]
    if X_pr.isnull().any().any():
        return None
    y_tr = np.array([values[j] for j in X_tr.index])
    try:
        return max(0.0, float(_xgb_model().fit(X_tr, y_tr).predict(X_pr)[0]))
    except Exception:
        return None


def xgb_forecast(feat_df, values, future_yms, future_temps, future_pop=None):
    X_tr = feat_df.dropna()
    if len(X_tr) < MIN_TRAIN:
        return None
    y_tr = np.array([values[j] for j in X_tr.index])
    try:
        model = _xgb_model()
        model.fit(X_tr, y_tr)
    except Exception:
        return None
    rolling = list(values)
    preds   = []
    for step, ym in enumerate(future_yms):
        month = int(ym[5:7])
        n     = len(rolling)
        row = {
            'month_sin': np.sin(2 * np.pi * month / 12),
            'month_cos': np.cos(2 * np.pi * month / 12),
            'temp':      future_temps[step],
            'lag1':  rolling[-1]  if n >= 1  else np.nan,
            'lag2':  rolling[-2]  if n >= 2  else np.nan,
            'lag3':  rolling[-3]  if n >= 3  else np.nan,
            'lag6':  rolling[-6]  if n >= 6  else np.nan,
            'lag12': rolling[-12] if n >= 12 else np.nan,
            'lag24': rolling[-24] if n >= 24 else np.nan,
            'roll3':  float(np.mean(rolling[-3:]))  if n >= 3  else np.nan,
            'roll12': float(np.mean(rolling[-12:])) if n >= 12 else np.nan,
        }
        if future_pop is not None:
            row['pop_index'] = future_pop[step]
        try:
            pred = max(0.0, float(model.predict(pd.DataFrame([row]))[0]))
        except Exception:
            pred = rolling[-12] if n >= 12 else float(np.mean(rolling[-3:])) if n >= 3 else 0.0
        preds.append(pred)
        rolling.append(pred)
    return np.array(preds)


# ─────────────────────────────────────────────
# LOO と MAPE
# ─────────────────────────────────────────────

def run_loo(values, temps, yms, feat_df):
    n          = len(values)
    start_eval = max(MIN_TRAIN, n - N_EVAL)
    actuals, sarima_preds, xgb_preds = {}, {}, {}

    for i in range(start_eval, n):
        actual = values[i]
        if actual == 0:
            continue
        ym      = yms[i]
        actuals[ym] = actual
        train_y = np.array(values[:i], float)
        train_x = np.array(temps[:i],  float).reshape(-1, 1)
        pred_x  = np.array([[temps[i]]])

        s = sarima_loo_step(train_y, train_x, pred_x)
        if s is not None:
            sarima_preds[ym] = s

        x = xgb_loo_step(feat_df, values, i)
        if x is not None:
            xgb_preds[ym] = x

    return actuals, sarima_preds, xgb_preds


def calc_mape(actuals, preds):
    errs = [abs(actuals[ym] - preds[ym]) / actuals[ym] * 100
            for ym in preds if ym in actuals and actuals[ym] > 0]
    return float(np.mean(errs)) if errs else None


def ensemble_preds(actuals, sarima_preds, xgb_preds):
    result = {}
    for ym in actuals:
        vals = [p[ym] for p in [sarima_preds, xgb_preds] if ym in p]
        if vals:
            result[ym] = max(0.0, float(np.mean(vals)))
    return result


# ─────────────────────────────────────────────
# 1品種の予測
# ─────────────────────────────────────────────

def forecast_one_type(miso_type, shipment_df, weather_monthly, seasonal_avg,
                      forecast_months=N_FORECAST):
    type_df = (shipment_df[shipment_df['misoType'] == miso_type]
               .sort_values('yearMonth').reset_index(drop=True))

    if len(type_df) < MIN_TRAIN:
        print(f'[{miso_type}] データ不足: {len(type_df)}ヶ月', file=sys.stderr)
        return [], None

    all_yms = type_df['yearMonth'].tolist()
    w_dict  = (dict(zip(weather_monthly['yearMonth'], weather_monthly['avgTempC']))
               if not weather_monthly.empty else {})
    temps   = [w_dict.get(ym, seasonal_avg.get(int(ym[5:7]), 14.0)) for ym in all_yms]
    y       = type_df['weightKg'].values.astype(float)
    exog    = np.array(temps, float).reshape(-1, 1)

    use_pop    = miso_type in MISO_USE_POPULATION
    pop_index  = get_population_index(miso_type, all_yms) if use_pop else None

    ly, lm = int(all_yms[-1][:4]), int(all_yms[-1][5:7])
    future_yms = []
    for i in range(1, forecast_months + 1):
        m    = lm + i
        yoff = (m - 1) // 12
        m    = (m - 1) % 12 + 1
        future_yms.append(f'{ly + yoff}-{m:02d}')
    future_temps = [seasonal_avg.get(int(ym[5:7]), 14.0) for ym in future_yms]
    future_exog  = np.array(future_temps, float).reshape(-1, 1)
    future_pop   = get_population_index(miso_type, future_yms) if use_pop else None

    pop_label = '人口特徴量あり' if use_pop else '人口特徴量なし'
    print(f'[{miso_type}] 将来予測中... ({pop_label})', file=sys.stderr)

    s_mean, s_lower, s_upper = sarima_forecast(y, exog, future_exog, forecast_months)

    feat_df = build_features(all_yms, list(y), temps, pop_index)
    x_mean  = xgb_forecast(feat_df, list(y), future_yms, future_temps, future_pop)
    if x_mean is not None:
        print(f'  XGBoost完了（{pop_label}）', file=sys.stderr)

    print(f'[{miso_type}] LOO評価中...', file=sys.stderr)
    actuals, sarima_loo, xgb_loo = run_loo(list(y), temps, all_yms, feat_df)

    s_mape = calc_mape(actuals, sarima_loo)
    x_mape = calc_mape(actuals, xgb_loo)
    if s_mape is not None:
        print(f'  sarima: MAPE={s_mape:.1f}%', file=sys.stderr)
    if x_mape is not None:
        print(f'  xgb:    MAPE={x_mape:.1f}%（{pop_label}）', file=sys.stderr)

    models_mean = [m for m in [s_mean, x_mean] if m is not None]
    if not models_mean:
        print(f'[{miso_type}] 全モデル失敗', file=sys.stderr)
        return [], None

    ens_mean = np.maximum(0, np.mean(models_mean, axis=0))

    if s_mean is not None and s_lower is not None:
        half_w    = (s_upper - s_lower) / 2
        ens_lower = np.maximum(0, ens_mean - half_w)
        ens_upper = ens_mean + half_w
    else:
        ens_lower = ens_mean * 0.80
        ens_upper = ens_mean * 1.20

    method = 'sarima+xgb' if len(models_mean) == 2 else ('sarima' if s_mean is not None else 'xgb')
    print(f'[{miso_type}] アンサンブル({method})', file=sys.stderr)

    now_utc = datetime.now(timezone.utc).isoformat()
    records = []
    for i, ym in enumerate(future_yms):
        fc = float(ens_mean[i])
        l  = float(ens_lower[i])
        u  = float(ens_upper[i])
        records.append({'misoType': miso_type, 'yearMonth': ym,
                        'forecastKg': round(fc, 1), 'lower90': round(l, 1),
                        'upper90': round(u, 1), 'updatedAt': now_utc})
        print(f'  {ym}: {fc:.0f} kg  [{l:.0f}, {u:.0f}]', file=sys.stderr)

    ens_loo = ensemble_preds(actuals, sarima_loo, xgb_loo)
    mape    = calc_mape(actuals, ens_loo)
    if mape is not None:
        print(f'[{miso_type}] アンサンブルMAPE(LOO): {mape:.1f}%', file=sys.stderr)
    else:
        print(f'[{miso_type}] MAPE計算不可', file=sys.stderr)

    for ym, pred_kg in ens_loo.items():
        v = round(float(pred_kg), 1)
        records.append({'misoType': miso_type, 'yearMonth': ym,
                        'forecastKg': v, 'lower90': v, 'upper90': v,
                        'updatedAt': now_utc})

    return records, mape


# ─────────────────────────────────────────────
# DB書き込み（PostgreSQL）
# ─────────────────────────────────────────────

def write_to_db(conn, records):
    if not records:
        return
    cur   = conn.cursor()
    types = list({r['misoType'] for r in records})
    cur.execute('DELETE FROM "ForecastCache" WHERE "misoType" = ANY(%s)', (types,))
    for r in records:
        cur.execute(
            'INSERT INTO "ForecastCache"'
            ' ("misoType", "yearMonth", "forecastKg", "lower90", "upper90", "updatedAt")'
            ' VALUES (%s, %s, %s, %s, %s, %s)'
            ' ON CONFLICT ("misoType", "yearMonth") DO UPDATE SET'
            '   "forecastKg" = EXCLUDED."forecastKg",'
            '   "lower90"    = EXCLUDED."lower90",'
            '   "upper90"    = EXCLUDED."upper90",'
            '   "updatedAt"  = EXCLUDED."updatedAt"',
            (r['misoType'], r['yearMonth'], r['forecastKg'],
             r['lower90'],  r['upper90'],   r['updatedAt']),
        )
    conn.commit()
    print(f'{len(records)}件のForecastCacheを書き込みました', file=sys.stderr)


def write_mape_to_settings(conn, mape_map):
    cur     = conn.cursor()
    now_utc = datetime.now(timezone.utc).isoformat()
    for miso_type, mape in mape_map.items():
        if mape is None:
            continue
        cur.execute(
            'INSERT INTO "SystemSetting" (key, value, "updatedAt") VALUES (%s, %s, %s)'
            ' ON CONFLICT (key) DO UPDATE SET'
            '   value       = EXCLUDED.value,'
            '   "updatedAt" = EXCLUDED."updatedAt"',
            (f'forecast_mape_{miso_type}', str(round(mape, 1)), now_utc),
        )
    conn.commit()


# ─────────────────────────────────────────────
# メイン
# ─────────────────────────────────────────────

def main():
    db_url = get_db_url()
    if not db_url:
        print(json.dumps({'ok': False, 'error': 'DATABASE_URL が設定されていません'},
                         ensure_ascii=False))
        sys.exit(1)

    print(f'データベース接続中...', file=sys.stderr)
    conn = psycopg2.connect(db_url)
    try:
        shipment_df     = load_shipment_data(conn)
        weather_monthly = load_weather_data(conn)
        seasonal_avg    = get_seasonal_avg_temp(weather_monthly)

        print(f'出荷データ: {len(shipment_df)}件', file=sys.stderr)
        print(f'気象データ: {len(weather_monthly)}ヶ月', file=sys.stderr)

        all_records = []
        mape_map    = {}

        for miso_type in MISO_TYPES:
            print(f'\n═══ {miso_type} ═══', file=sys.stderr)
            records, mape = forecast_one_type(
                miso_type, shipment_df, weather_monthly, seasonal_avg)
            all_records.extend(records)
            mape_map[miso_type] = mape

        write_to_db(conn, all_records)
        write_mape_to_settings(conn, mape_map)

        print(json.dumps({
            'ok':    True,
            'types': list({r['misoType'] for r in all_records}),
            'mape':  {k: round(v, 1) if v is not None else None
                      for k, v in mape_map.items()},
        }, ensure_ascii=False))

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        sys.exit(1)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
