
(function () {
  "use strict";

  var FSKEY = "tradlab_fs";
  var HKEY = "tradlab_ai_history";
  var MKEY_AI = "tradlab_model";
  function loadModel() { try { return localStorage.getItem(MKEY_AI) || ""; } catch (e) { return ""; } }
  function saveModel(b64) { try { if (b64 && b64.length < 1500000) localStorage.setItem(MKEY_AI, b64); } catch (e) {} }
  function resetModel() { try { localStorage.removeItem(MKEY_AI); } catch (e) {} }
  var MKEY_RL = "tradlab_rl", MKEY_TX = "tradlab_text";
  function loadRL() { try { return localStorage.getItem(MKEY_RL) || ""; } catch (e) { return ""; } }
  function saveRL(b) { try { if (b && b.length < 1500000) localStorage.setItem(MKEY_RL, b); } catch (e) {} }
  function resetRL() { try { localStorage.removeItem(MKEY_RL); } catch (e) {} }
  function loadTX() { try { return localStorage.getItem(MKEY_TX) || ""; } catch (e) { return ""; } }
  function saveTX(b) { try { if (b && b.length < 1500000) localStorage.setItem(MKEY_TX, b); } catch (e) {} }
  function resetTX() { try { localStorage.removeItem(MKEY_TX); } catch (e) {} }

  var AKEY = "tradlab_auto";
  var AUTO_MAX_BYTES = 1000000;
  function loadAuto() { try { return localStorage.getItem(AKEY) || ""; } catch (e) { return ""; } }
  function saveAuto(rawJson) {
    try {
      var o = null; try { o = JSON.parse(rawJson); } catch (e) { return; }
      if (!o || o.kind !== "auto") return;
      var slim = { journal: Array.isArray(o.journal) ? o.journal.slice() : [], pass_count: o.pass_count || 0 };
      var s = JSON.stringify(slim);
      while (s.length > AUTO_MAX_BYTES && slim.journal.length > 1) { slim.journal.shift(); s = JSON.stringify(slim); }
      if (s.length > AUTO_MAX_BYTES) return;
      localStorage.setItem(AKEY, s);
    } catch (e) {}
  }
  function resetAuto() { try { localStorage.removeItem(AKEY); } catch (e) {} }
  function saveModelByKind(o, b64) { var k = o && o.kind; if (k === "rl") saveRL(b64); else if (k === "nlp") saveTX(b64); else if (k === "exp") {  } else if (k === "mind") {  } else if (k === "auto") {  } else saveModel(b64); }

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  /* =================== MOTEUR : Web Worker (+ repli Runner) =================== */
  var worker = null, workerReady = false, workerDead = false, reqSeq = 0, pending = {}, curLog = null, onStatusCb = null;
  function workerSupported() { return (typeof Worker !== "undefined") && location.protocol !== "file:"; }
  function ensureWorker(onStatus) {
    onStatusCb = onStatus || null;
    if (workerReady) return Promise.resolve(true);
    if (workerDead || !workerSupported()) return Promise.resolve(false);
    return new Promise(function (resolve) {
      try { worker = new Worker("js/tradl-ai-worker.js"); } catch (e) { workerDead = true; resolve(false); return; }
      worker.onmessage = function (e) {
        var m = e.data || {};
        if (m.type === "status") { if (onStatusCb) onStatusCb(m.text); }
        else if (m.type === "log") { if (curLog) curLog(m.text); }
        else if (m.type === "ready") { workerReady = true; resolve(true); }
        else if (m.type === "fatal") { workerDead = true; worker = null; resolve(false); }
        else if (m.type === "result") { var p = pending[m.reqId]; if (p) { delete pending[m.reqId]; p(m); } }
      };
      worker.onerror = function () { if (!workerReady) { workerDead = true; worker = null; resolve(false); } };
      worker.postMessage({ type: "init", indexURL: new URL("vendor/pyodide/", location.href).href });
    });
  }
  function workerRun(code, files, onLog) {
    return new Promise(function (resolve) { var id = ++reqSeq; pending[id] = resolve; curLog = onLog || null; worker.postMessage({ type: "run", code: code, files: files, reqId: id }); });
  }

  var pyLoading = false;
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = function () { rej(new Error("Impossible de charger " + src)); }; document.head.appendChild(s); }); }
  function getRunner() { try { return Runner; } catch (e) { return (typeof window !== "undefined" ? window.Runner : null); } }
  function ensurePy(onStatus) {
    if (getRunner() && getRunner().ready) return Promise.resolve();
    if (pyLoading) return new Promise(function (res) { var t = setInterval(function () { if (getRunner() && getRunner().ready) { clearInterval(t); res(); } }, 120); });
    pyLoading = true;
    return Promise.resolve()
      .then(function () { if (typeof loadPyodide === "undefined") { onStatus && onStatus("Téléchargement du moteur Python…"); return loadScript("vendor/pyodide/pyodide.js"); } })
      .then(function () { if (getRunner() == null) return loadScript("js/runner.js"); })
      .then(function () { var R = getRunner(); if (!R) throw new Error("moteur introuvable"); if (R.ready) return; return R.init(onStatus); })
      .then(function () { pyLoading = false; })
      .catch(function (e) { pyLoading = false; throw e; });
  }
  function pkgsFor(code) { var p = ["numpy", "pandas"]; if (/sklearn|scikit/.test(code)) p.push("scikit-learn"); if (/\bscipy\b/.test(code)) p.push("scipy"); return p; }
  function preludeFor(snap) {
    var data = snap || ((window.TradSim && window.TradSim.marketData) ? window.TradSim.marketData(600) : []);
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
    var newsArr = (window.TradSim && window.TradSim.news) ? window.TradSim.news(120) : [];
    var newsB64 = btoa(unescape(encodeURIComponent(JSON.stringify(newsArr))));
    return "__ai_json = None\nimport warnings as _w; _w.filterwarnings('ignore')\nimport base64 as _b64, json as _json, pandas as _pd\n" +
      "df = _pd.DataFrame(_json.loads(_b64.b64decode('" + b64 + "').decode('utf-8')))\n" +
      "if 't' in df.columns: df['t'] = _pd.to_datetime(df['t'], unit='ms')\n" +
      "__news_json = _b64.b64decode('" + newsB64 + "').decode('utf-8')\n";
  }

  /* =================== LE CODE DE L'IA (fichier ia.py par défaut) =================== */
  var AI_PY = `import json, base64, pickle, numpy as np, pandas as pd
import sklearn
from sklearn.linear_model import SGDRegressor
from sklearn.preprocessing import StandardScaler

try:
    __model_in
except NameError:
    __model_in = ''
try:
    __live
except NameError:
    __live = False

# df = marche courant (injecte). En mode LIVE on GARDE la bougie EN FORMATION comme
# ancre de prevision (analyse continue : prix + microstructure en direct, variables causales).
# Sinon on l'enleve. Dans les DEUX cas l'ENTRAINEMENT n'utilise que des bougies CLOTUREES :
# la bougie en formation a y = ret_{t+1} = NaN, donc 'keep' (dropna sur 'y') l'exclut -> 0 fuite.
d = df.copy().reset_index(drop=True)
if (not __live) and len(d) > 5:
    d = d.iloc[:-1].reset_index(drop=True)
c = d['c']; o = d['o']; h = d['h']; l = d['l']; vv = d['v']
d['t_ms'] = (df['t'].iloc[:len(d)].values.astype('int64') // 10**6)
print('> marche lu :', len(d), 'bougies cloturees')

# indicateurs (= analytique du terminal), tous causaux
d['ret'] = np.log(c / c.shift(1))
for k in (1, 2, 3): d['ret%d' % k] = d['ret'].shift(k)
for k in (3, 5, 10): d['mom%d' % k] = c.pct_change(k)
sma20 = c.rolling(20).mean(); sma50 = c.rolling(50).mean()
d['dsma20'] = c / sma20 - 1; d['dsma50'] = c / sma50 - 1
d['emax'] = c.ewm(span=9, adjust=False).mean() / c.ewm(span=21, adjust=False).mean() - 1
delta = c.diff(); up = delta.clip(lower=0).ewm(alpha=1/14, adjust=False).mean(); dn = (-delta.clip(upper=0)).ewm(alpha=1/14, adjust=False).mean()
d['rsi'] = 100 - 100 / (1 + up / dn.replace(0, 1e-9))
macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
d['macd'] = macd / c; d['macdh'] = (macd - macd.ewm(span=9, adjust=False).mean()) / c
lo14 = l.rolling(14).min(); hi14 = h.rolling(14).max()
d['stok'] = 100 * (c - lo14) / (hi14 - lo14).replace(0, 1e-9)
d['stod'] = d['stok'].rolling(3).mean()
tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
atr = tr.ewm(alpha=1/14, adjust=False).mean(); d['atrn'] = atr / c
std20 = c.rolling(20).std(); d['bbw'] = 4 * std20 / sma20; d['bbp'] = (c - sma20) / (2 * std20).replace(0, 1e-9)
vwap = (((h + l + c) / 3) * vv).cumsum() / vv.cumsum(); d['dvwap'] = c / vwap - 1
d['volr'] = vv / vv.rolling(20).mean(); d['rng'] = (h - l) / c; d['body'] = (c - o) / c

# --- microstructure : carnet d'ordres, spread, time & sales (donnees que seules les IA exploitent) ---
for _col in ('spread','imb','ofd','bvol','svol'):
    if _col not in d.columns: d[_col] = 0.0
d['ofdn'] = d['ofd'] / (d['v'] + 1)                       # flux d'ordres net normalise (agresseur)
d['bsr'] = (d['bvol'] - d['svol']) / (d['bvol'] + d['svol'] + 1)
d['spr'] = d['spread'] / c                                # spread relatif (liquidite)
# d['imb'] = desequilibre du carnet (deja fourni par le marche)
# --- tendances LONGUES (l'IA lit le passe) ---
d['mom20'] = c.pct_change(20); d['mom50'] = c.pct_change(50)
_lo50 = c.rolling(50).min(); _hi50 = c.rolling(50).max()
d['pos50'] = (c - _lo50) / (_hi50 - _lo50).replace(0, 1e-9)   # position dans le range 50
d['slope20'] = (c - c.shift(20)) / 20 / c
d['vof'] = d['atrn'] * d['ofdn']                          # interaction sigma x flux (terme 0.06*sigma*F du prix)
d['ofdn1'] = d['ofdn'].shift(1); d['ofdn2'] = d['ofdn'].shift(2)   # retards du flux (memoire OU ~0.93/tick)
d['imb1'] = d['imb'].shift(1); d['imb2'] = d['imb'].shift(2)       # retards du desequilibre carnet
if 'sent' in d.columns:                                            # NLP : sentiment des news (injecte par le marche)
    d['sent_chg'] = d['sent'].diff().fillna(0.0); d['sent_x_mom'] = d['sent'] * d['mom5']
else:
    d['sent'] = 0.0; d['sent_chg'] = 0.0; d['sent_x_mom'] = 0.0
# --- VUE D'ENSEMBLE (contexte long terme sur tout l'historique visible, causal) ---
d['lret'] = np.log(c / c.iloc[0])                                  # rendement depuis le debut de la fenetre
_emx = c.expanding().max(); _emn = c.expanding().min()
d['pos_all'] = (c - _emn) / (_emx - _emn).replace(0, 1e-9)         # position dans le range TOTAL (0..1)
d['dath'] = c / _emx - 1                                           # distance au plus-haut historique (<=0)
d['datl'] = c / _emn.replace(0, 1e-9) - 1                          # distance au plus-bas historique (>=0)
d['dema100'] = c / c.ewm(span=100, adjust=False).mean() - 1        # ecart a la tendance LONGUE (EMA 100)
print('> microstructure + tendances + interaction + retards de flux + sentiment + vue d ensemble integres')

FEAT = ['ret1','ret2','ret3','mom3','mom5','mom10','dsma20','dsma50','emax','rsi',
        'macd','macdh','stok','stod','atrn','bbw','bbp','dvwap','volr','rng','body',
        'ofdn','bsr','spr','imb','mom20','mom50','pos50','slope20','vof',
        'ofdn1','ofdn2','imb1','imb2','sent','sent_chg','sent_x_mom',
        'lret','pos_all','dath','datl','dema100']
d['y'] = d['ret'].shift(-1)
keep = d.dropna(subset=FEAT + ['y','t_ms']).reset_index(drop=True)
if len(keep) < 60:
    __ai_json = json.dumps({'error': 'pas assez de bougies (' + str(len(keep)) + ')'}); __model_out = __model_in
    print('> pas assez de bougies, on attend.')
else:
    X = keep[FEAT].values.astype(float)
    Y = keep['y'].values.astype(float)
    T = keep['t_ms'].values.astype('int64')
    print('> indicateurs OK :', len(FEAT), 'variables, echantillon', len(keep))

    def new_bundle():
        return {'model': SGDRegressor(loss='huber', epsilon=1e-4, penalty='l2', alpha=1e-4,
                  learning_rate='constant', eta0=0.005, fit_intercept=True,
                  warm_start=True, random_state=0, average=10),
                'scaler': StandardScaler(),
                'meta': {'last_trained_t': None, 'seen': 0, 'pq_correct': 0, 'pq_total': 0,
                         'pq_base_up': 0, 'resid_sum2': 0.0, 'resid_n': 0, 'updates': 0,
                         'ysum': 0.0, 'ysum2': 0.0, 'skl': sklearn.__version__},
                'feat': FEAT, 'schema': 1}

    b = None
    try:
        if __model_in:
            b = pickle.loads(base64.b64decode(__model_in))
            if b.get('schema') != 1 or b.get('feat') != FEAT or b.get('meta', {}).get('skl') != sklearn.__version__:
                b = None
    except Exception:
        b = None
    cold = b is None
    if cold:
        b = new_bundle(); print('> nouveau modele (cold start)')
    model = b['model']; scaler = b['scaler']; meta = b['meta']
    ltt = meta['last_trained_t']

    if ltt is None: idx = np.arange(len(T))
    else: idx = np.where(T > ltt)[0]
    print('> nouvelles bougies a apprendre :', len(idx), '(vues a vie:', meta['seen'], ')')

    fitted = meta['updates'] > 0
    epochs = 2 if (cold and len(idx) > 50) else 1
    for ep in range(epochs):
        for j in idx:
            xrow = X[j:j+1]; yrow = Y[j:j+1]
            if ep == 0 and fitted:
                p = float(model.predict(scaler.transform(xrow))[0])
                meta['pq_total'] += 1
                meta['pq_correct'] += int(np.sign(p) == np.sign(yrow[0]))
                meta['pq_base_up'] += int(yrow[0] > 0)
                r = float(yrow[0] - p); meta['resid_sum2'] += r * r; meta['resid_n'] += 1
            scaler.partial_fit(xrow)
            model.partial_fit(scaler.transform(xrow), yrow)
            fitted = True
            if ep == 0:
                meta['seen'] += 1; meta['updates'] += 1
                meta['ysum'] += float(yrow[0]); meta['ysum2'] += float(yrow[0] * yrow[0])
    if len(idx): meta['last_trained_t'] = int(T[idx[-1]])

    pt = max(1, meta['pq_total'])
    life_acc = meta['pq_correct'] / pt
    life_base = max(meta['pq_base_up'], meta['pq_total'] - meta['pq_base_up']) / pt
    life_edge = life_acc - life_base
    if meta['resid_n']: sigma_life = (meta['resid_sum2'] / meta['resid_n']) ** 0.5
    else: sigma_life = float(np.std(Y)) if len(Y) else 1e-3
    _vn = float(keep['atrn'].iloc[-1]); _vm = float(keep['atrn'].tail(120).mean())
    vol_scale = min(3.0, max(0.3, _vn / _vm)) if _vm > 0 else 1.0   # cone a l'echelle de la vol COURANTE (clustering de vol)
    nu = max(1, meta['updates'])
    vary = (meta['ysum2'] / nu) - (meta['ysum'] / nu) ** 2
    r2_life = (1 - (sigma_life ** 2) / vary) if vary > 0 else 0.0
    signif_life = bool(life_edge > 1.96 * (0.25 / pt) ** 0.5)
    print('> a vie : fiab %.1f%% base %.1f%% avantage %+.1f pts (vus=%d)' % (life_acc*100, life_base*100, life_edge*100, meta['seen']))

    Xs_all = scaler.transform(X); fit_all = model.predict(Xs_all)
    ck = keep['c'].values; replay = {}
    for i in range(max(0, len(keep) - 80), len(keep)):
        replay[str(int(T[i]))] = float(ck[i] * np.exp(fit_all[i]))

    K = 14
    # ancre de prevision : en LIVE = bougie EN FORMATION (prix + microstructure en direct,
    # variables causales) si complete ; sinon derniere bougie CLOTUREE (= keep, comportement d'origine).
    if __live and len(d) and not d[FEAT].iloc[-1].isnull().any():
        last_c = float(d['c'].iloc[-1]); base_row = d[FEAT].iloc[-1].to_dict(); sim = list(d['c'].values)
    else:
        last_c = float(c.iloc[-1]); base_row = keep[FEAT].iloc[-1].to_dict(); sim = list(c.values)
    center = []; band_lo = []; band_hi = []; cum = 0.0; varc = 0.0
    for step in range(K):
        s = pd.Series(sim); rr = np.log(s / s.shift(1)); feat = dict(base_row)
        feat['ret1'] = rr.iloc[-1]; feat['ret2'] = rr.iloc[-2]; feat['ret3'] = rr.iloc[-3]
        feat['mom3'] = s.iloc[-1] / s.iloc[-4] - 1
        feat['mom5'] = s.iloc[-1] / s.iloc[-6] - 1
        feat['mom10'] = s.iloc[-1] / s.iloc[-11] - 1
        feat['dsma20'] = s.iloc[-1] / s.rolling(20).mean().iloc[-1] - 1
        feat['dsma50'] = s.iloc[-1] / s.rolling(50).mean().iloc[-1] - 1
        feat['emax'] = s.ewm(span=9, adjust=False).mean().iloc[-1] / s.ewm(span=21, adjust=False).mean().iloc[-1] - 1
        feat['mom20'] = s.iloc[-1] / s.iloc[-21] - 1
        feat['mom50'] = s.iloc[-1] / s.iloc[-51] - 1
        _w = s.tail(50); _wl = _w.min(); _wh = _w.max(); _den = (_wh - _wl) if (_wh - _wl) > 0 else 1e-9
        feat['pos50'] = (s.iloc[-1] - _wl) / _den
        feat['slope20'] = (s.iloc[-1] - s.iloc[-21]) / 20 / s.iloc[-1]
        fv = np.nan_to_num(np.array([[feat[col] for col in FEAT]], dtype=float), nan=0.0)
        rhat = float(model.predict(scaler.transform(fv))[0])
        cum += rhat; varc += sigma_life ** 2
        price = last_c * np.exp(cum); half = 1.28 * np.sqrt(varc) * vol_scale
        center.append(float(price)); band_lo.append(float(price * np.exp(-half))); band_hi.append(float(price * np.exp(half)))
        sim.append(price)

    __model_out = base64.b64encode(pickle.dumps({'model': model, 'scaler': scaler, 'meta': meta, 'feat': FEAT, 'schema': 1}, protocol=4)).decode('ascii')
    out = {'center': center, 'bandLow': band_lo, 'bandHigh': band_hi, 'replay': replay,
           'dir_acc': life_acc, 'base': life_base, 'edge': life_edge, 'r2': r2_life, 'sigma': sigma_life, 'signif': signif_life,
           'n_oos': meta['pq_total'], 'n_train': meta['seen'], 'K': K, 'last_c': last_c,
           'up': bool(center[0] > last_c), 'model': 'SGD en ligne',
           'seen': meta['seen'], 'life_acc': life_acc, 'life_base': life_base, 'life_edge': life_edge, 'signif_life': signif_life}
    __ai_json = json.dumps(out)
    print('> termine. bundle sauvegarde (', len(__model_out), 'o base64 )')
`;


  var FEATURES_PY = `import numpy as np, pandas as pd

def build_features(df):
    d = df.copy().reset_index(drop=True)
    if len(d) > 5: d = d.iloc[:-1].reset_index(drop=True)
    c = d['c']; o = d['o']; h = d['h']; l = d['l']; vv = d['v']
    d['t_ms'] = (df['t'].iloc[:len(d)].values.astype('int64') // 10**6)
    d['ret'] = np.log(c / c.shift(1))
    for k in (1, 2, 3): d['ret%d' % k] = d['ret'].shift(k)
    for k in (3, 5, 10): d['mom%d' % k] = c.pct_change(k)
    sma20 = c.rolling(20).mean(); sma50 = c.rolling(50).mean()
    d['dsma20'] = c / sma20 - 1; d['dsma50'] = c / sma50 - 1
    d['emax'] = c.ewm(span=9, adjust=False).mean() / c.ewm(span=21, adjust=False).mean() - 1
    delta = c.diff(); up = delta.clip(lower=0).ewm(alpha=1/14, adjust=False).mean(); dn = (-delta.clip(upper=0)).ewm(alpha=1/14, adjust=False).mean()
    d['rsi'] = 100 - 100 / (1 + up / dn.replace(0, 1e-9))
    macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    d['macd'] = macd / c; d['macdh'] = (macd - macd.ewm(span=9, adjust=False).mean()) / c
    lo14 = l.rolling(14).min(); hi14 = h.rolling(14).max()
    d['stok'] = 100 * (c - lo14) / (hi14 - lo14).replace(0, 1e-9); d['stod'] = d['stok'].rolling(3).mean()
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1/14, adjust=False).mean(); d['atrn'] = atr / c
    std20 = c.rolling(20).std(); d['bbw'] = 4 * std20 / sma20; d['bbp'] = (c - sma20) / (2 * std20).replace(0, 1e-9)
    vwap = (((h + l + c) / 3) * vv).cumsum() / vv.cumsum(); d['dvwap'] = c / vwap - 1
    d['volr'] = vv / vv.rolling(20).mean(); d['rng'] = (h - l) / c; d['body'] = (c - o) / c
    for _col in ('spread', 'imb', 'ofd', 'bvol', 'svol'):
        if _col not in d.columns: d[_col] = 0.0
    d['ofdn'] = d['ofd'] / (d['v'] + 1); d['bsr'] = (d['bvol'] - d['svol']) / (d['bvol'] + d['svol'] + 1); d['spr'] = d['spread'] / c
    d['mom20'] = c.pct_change(20); d['mom50'] = c.pct_change(50)
    _lo50 = c.rolling(50).min(); _hi50 = c.rolling(50).max()
    d['pos50'] = (c - _lo50) / (_hi50 - _lo50).replace(0, 1e-9); d['slope20'] = (c - c.shift(20)) / 20 / c
    d['vof'] = d['atrn'] * d['ofdn']
    d['ofdn1'] = d['ofdn'].shift(1); d['ofdn2'] = d['ofdn'].shift(2)
    d['imb1'] = d['imb'].shift(1); d['imb2'] = d['imb'].shift(2)
    FEAT = ['ret1','ret2','ret3','mom3','mom5','mom10','dsma20','dsma50','emax','rsi','macd','macdh','stok','stod','atrn','bbw','bbp','dvwap','volr','rng','body','ofdn','bsr','spr','imb','mom20','mom50','pos50','slope20','vof','ofdn1','ofdn2','imb1','imb2']
    if 'sent' in df.columns: d['sent'] = df['sent'].iloc[:len(d)].values
    else: d['sent'] = 0.0
    d['sent_chg'] = d['sent'].diff().fillna(0.0)
    d['sent_x_mom'] = d['sent'] * d['mom5']
    FEAT = FEAT + ['sent', 'sent_chg', 'sent_x_mom']
    # --- VUE D'ENSEMBLE (contexte long terme sur tout l'historique visible, causal) ---
    d['lret'] = np.log(c / c.iloc[0])
    _emx = c.expanding().max(); _emn = c.expanding().min()
    d['pos_all'] = (c - _emn) / (_emx - _emn).replace(0, 1e-9)
    d['dath'] = c / _emx - 1
    d['datl'] = c / _emn.replace(0, 1e-9) - 1
    d['dema100'] = c / c.ewm(span=100, adjust=False).mean() - 1
    FEAT = FEAT + ['lret', 'pos_all', 'dath', 'datl', 'dema100']
    d['c'] = c.values
    d['y'] = d['ret'].shift(-1)
    keep = d.dropna(subset=FEAT + ['y', 't_ms', 'spr']).reset_index(drop=True)
    return keep, FEAT
`;


  var AGENT_PY = `import json, base64, pickle, numpy as np, pandas as pd, sklearn
from sklearn.preprocessing import StandardScaler

try:
    __rl_in
except NameError:
    __rl_in = ''

try:
    from features import build_features
    keep, FEAT = build_features(df)
except Exception as _e:
    raise SystemExit('features.py manquant ou invalide : ' + str(_e))

CFG = dict(gamma=0.0, alpha=0.02, cost=0.0006, eps0=0.30, eps_min=0.02, lam=1e-4)
ACTIONS = np.array([-1, 0, 1])              # short / plat / long
X = keep[FEAT].values.astype(float)
RET = keep['y'].values.astype(float)        # ret_{t+1} (cible decalee = pas de fuite)
T = keep['t_ms'].values.astype('int64')
CK = keep['c'].values
N = len(keep)

if N < 60:
    __ai_json = json.dumps({'kind': 'rl', 'error': 'pas assez de bougies (' + str(N) + ')'})
    __model_out = __rl_in
    print('> pas assez de bougies, on attend.')
else:
    D = len(FEAT) + 2                        # +position +biais
    def new_bundle():
        return {'schema': 1, 'kind': 'rl', 'feat': FEAT,
                'W': np.zeros((3, D)), 'scaler': StandardScaler(),
                'meta': {'last_trained_t': None, 'seen': 0, 'updates': 0,
                         'pnl_sum': 0.0, 'pnl_sum2': 0.0, 'bh_sum': 0.0,
                         'n_trades': 0.0, 'wins': 0, 'skl': sklearn.__version__},
                'cfg': CFG}
    b = None
    try:
        if __rl_in:
            b = pickle.loads(base64.b64decode(__rl_in))
            if (b.get('schema') != 1 or b.get('kind') != 'rl' or b.get('feat') != FEAT
                    or b['meta'].get('skl') != sklearn.__version__ or b['W'].shape != (3, D)):
                b = None
    except Exception:
        b = None
    cold = b is None
    if cold:
        b = new_bundle(); print('> nouvel agent (cold start)')
    W = b['W']; scaler = b['scaler']; meta = b['meta']; cfg = b.get('cfg', CFG)
    g, al, cost, lam = cfg['gamma'], cfg['alpha'], cfg['cost'], cfg['lam']

    def feat_z(xrow, pos_prev):
        xs = scaler.transform(xrow)[0]
        return np.concatenate([xs, [pos_prev, 1.0]])
    def qvals(z):
        return W @ z
    def greedy(q):
        a = int(np.argmax(q))
        if abs(q[a] - q[1]) < 1e-9: a = 1
        return a

    if cold:
        scaler.partial_fit(X)
    ltt = meta['last_trained_t']
    idx = np.arange(N) if ltt is None else np.where(T > ltt)[0]
    print('> nouvelles bougies a apprendre :', len(idx), '(vues a vie:', meta['seen'], ')')

    rng = np.random.RandomState(meta['updates'])
    pos_prev = 0.0
    a_idx = None; z_prev = None; r_prev = 0.0; q_prev_a = 0.0
    for j in idx:
        scaler.partial_fit(X[j:j+1])
        z_now = feat_z(X[j:j+1], pos_prev)
        q_now = qvals(z_now)
        a_greedy = greedy(q_now)
        a_pos = ACTIONS[a_greedy]
        dpos = abs(a_pos - pos_prev)
        r_greedy = a_pos * RET[j] - cost * dpos
        meta['pnl_sum'] += r_greedy; meta['pnl_sum2'] += r_greedy * r_greedy
        meta['bh_sum'] += RET[j]; meta['n_trades'] += dpos / 2.0
        meta['wins'] += int(r_greedy > 0); meta['seen'] += 1
        eps = max(cfg['eps_min'], cfg['eps0'] * (0.9995 ** meta['updates']))
        a_t = rng.randint(3) if rng.rand() < eps else a_greedy
        if a_idx is not None:
            delta = r_prev + g * q_now[a_t] - q_prev_a
            W[a_idx] += al * delta * z_prev
            W[a_idx] *= (1 - al * lam)
            meta['updates'] += 1
        r_t = ACTIONS[a_t] * RET[j] - cost * abs(ACTIONS[a_t] - pos_prev)
        a_idx = a_t; z_prev = z_now; r_prev = r_t; q_prev_a = q_now[a_t]
        pos_prev = ACTIONS[a_t]
    if len(idx):
        meta['last_trained_t'] = int(T[idx[-1]])

    eq = []; bh = []; markers = {}; cum = 0.0; cb = 0.0; pos = 0.0
    s0 = max(0, N - 80)
    for i in range(s0, N):
        a = greedy(qvals(feat_z(X[i:i+1], pos))); ap = ACTIONS[a]
        cum += ap * RET[i] - cost * abs(ap - pos); cb += RET[i]; pos = ap
        eq.append(float(cum)); bh.append(float(cb))
        if ap > 0: markers[str(int(T[i]))] = 'buy'
        elif ap < 0: markers[str(int(T[i]))] = 'sell'
    last_c = float(CK[-1]); eqline = {}
    if eq:
        e0 = eq[0]
        for i, val in zip(range(s0, N), eq):
            eqline[str(int(T[i]))] = last_c * float(np.exp(0.5 * (val - e0)))

    ns = max(1, meta['seen']); r_mean = meta['pnl_sum'] / ns
    var = meta['pnl_sum2'] / ns - r_mean * r_mean
    r_std = var ** 0.5 if var > 1e-18 else 1e-9
    sharpe = float(r_mean / r_std * np.sqrt(252))
    net = float(np.exp(meta['pnl_sum']) - 1); bhret = float(np.exp(meta['bh_sum']) - 1)
    win = meta['wins'] / ns; turn = meta['n_trades'] / ns
    signif = bool(abs(meta['pnl_sum']) > 1.96 * np.sqrt(max(meta['pnl_sum2'], 1e-12)))
    last_a = int(ACTIONS[greedy(qvals(feat_z(X[-1:], pos)))])
    print('> agent a vie : net %+.2f%% vs B&H %+.2f%% | Sharpe %.2f | rotation %.2f | %d pas' % (net * 100, bhret * 100, sharpe, turn, meta['seen']))
    print("> rappel honnete : apres frais, l'avantage doit etre ~0 sur ce marche quasi-efficient.")

    __model_out = base64.b64encode(pickle.dumps({'schema': 1, 'kind': 'rl', 'feat': FEAT, 'W': W, 'scaler': scaler, 'meta': meta, 'cfg': cfg}, protocol=4)).decode('ascii')
    __ai_json = json.dumps({
        'kind': 'rl', 'up': last_a > 0, 'lastAction': last_a,
        'edge': net - bhret, 'signif': signif, 'dir_acc': win, 'base': 0.5,
        'seen': meta['seen'], 'r2': sharpe, 'K': int(round(turn * 100)),
        'sharpe': sharpe, 'turnover': turn, 'net_return': net, 'bh_return': bhret,
        'vs_bh': net - bhret, 'equity': eq, 'bh': bh, 'markers': markers, 'line': eqline})
    print('> termine. bundle RL sauvegarde (', len(__model_out), 'o base64 )')
`;


  var NLP_PY = `import json, base64, pickle, re, numpy as np, sklearn
from sklearn.feature_extraction.text import HashingVectorizer
from sklearn.linear_model import SGDClassifier

try: __text_in
except NameError: __text_in = ''
try: __paste_text
except NameError: __paste_text = None
try: __news_json
except NameError: __news_json = '[]'
news = json.loads(__news_json or '[]')

POS = {'hausse':2,'rally':2,'record':2,'benefice':1.5,'profit':1.5,'dividende':1,'rachat':1.5,
 'buyback':1.5,'upgrade':1.5,'surperforme':1.5,'solide':1,'strong':1,'croissance':1,'growth':1,
 'beat':1.5,'resilient':1,'optimiste':1,'raises':1.2,'above':1.5,'climb':1,'gains':1,'envoler':1.5}
NEG = {'chute':2,'krach':2.5,'crash':2.5,'alerte':1.5,'warning':2,'defaut':2,'default':2,'fraude':2.5,
 'fraud':2.5,'enquete':1.5,'probe':1.5,'lawsuit':1.5,'downgrade':1.5,'deception':1.5,'miss':1.5,
 'licenciements':1.5,'layoffs':1.5,'recession':2,'selloff':2,'below':1.5,'slip':1,'softens':1,'cuts':1.2,'pression':1}
INT = {'fort':1.5,'massif':1.6,'sharp':1.5,'severe':1.6,'nettement':1.4}
NEGATORS = {'pas','ne','sans','no','not','aucun'}
def lex_score(txt):
    toks = re.findall(r"[a-zà-ÿ-]+", (txt or '').lower())
    sc = 0.0; npol = 0; neg = False
    for w in toks:
        if w in NEGATORS: neg = True; continue
        mult = INT.get(w, 1.0)
        v = POS.get(w, 0) - NEG.get(w, 0)
        if v != 0: sc += (-v if neg else v) * mult; npol += 1
        neg = False
    return float(np.clip(sc / (npol + 2.0), -1, 1))

HV = HashingVectorizer(n_features=2**14, alternate_sign=False, ngram_range=(1, 2),
                       lowercase=True, strip_accents='unicode', norm='l2')
def lab(s): return 0 if abs(s) < 0.15 else (1 if s > 0 else -1)
def new_bundle():
    return {'schema': 1, 'kind': 'text',
            'clf': SGDClassifier(loss='log_loss', alpha=1e-4, penalty='l2'),
            'meta': {'last_trained_t': None, 'seen': 0, 'pq_correct': 0, 'pq_total': 0,
                     'pq_base': {}, 'skl': sklearn.__version__}}
b = None
try:
    if __text_in:
        b = pickle.loads(base64.b64decode(__text_in))
        if b.get('schema') != 1 or b.get('kind') != 'text' or b['meta'].get('skl') != sklearn.__version__:
            b = None
except Exception: b = None
cold = b is None
if cold: b = new_bundle(); print('> nouveau modele texte (cold start)')
clf = b['clf']; meta = b['meta']; fitted = meta['seen'] > 0
CLASSES = np.array([-1, 0, 1])

news = sorted([n for n in news if n.get('text')], key=lambda n: n['t'])
ltt = meta['last_trained_t']
todo = [n for n in news if (ltt is None or n['t'] > ltt)]
print('> news total:', len(news), ' a apprendre:', len(todo), ' (vues a vie:', meta['seen'], ')')
for n in todo:
    y = lab(n['s']); Xr = HV.transform([n['text']])
    if fitted:
        p = int(clf.predict(Xr)[0]); meta['pq_total'] += 1; meta['pq_correct'] += int(p == y)
        meta['pq_base'][str(y)] = meta['pq_base'].get(str(y), 0) + 1
    if not fitted: clf.partial_fit(Xr, [y], classes=CLASSES); fitted = True
    else: clf.partial_fit(Xr, [y])
    meta['seen'] += 1
if todo: meta['last_trained_t'] = todo[-1]['t']

def model_score(txt):
    if meta['seen'] < 30 or not txt: return None
    try:
        P = clf.predict_proba(HV.transform([txt]))[0]; cl = list(clf.classes_)
        pp = P[cl.index(1)] if 1 in cl else 0.0; pn = P[cl.index(-1)] if -1 in cl else 0.0
        return float(np.clip(pp - pn, -1, 1))
    except Exception: return None
def fused(txt):
    lx = lex_score(txt); ms = model_score(txt)
    return lx if ms is None else float(np.clip(0.5 * lx + 0.5 * ms, -1, 1))

cur = fused(news[-1]['text']) if news else 0.0
paste = ({'text': __paste_text, 'score': fused(__paste_text),
          'lex': lex_score(__paste_text), 'model': model_score(__paste_text)}
         if __paste_text else None)
pt = max(1, meta['pq_total']); acc = meta['pq_correct'] / pt
base = (max(meta['pq_base'].values()) / pt) if meta['pq_base'] else 0.0
__model_out = base64.b64encode(pickle.dumps(b, protocol=4)).decode('ascii')
__ai_json = json.dumps({'kind': 'nlp', 'score': cur, 'paste': paste, 'n_news': len(news),
    'text_acc': acc, 'text_base': base, 'text_edge': acc - base, 'seen': meta['seen'],
    'note': 'News SIMULEES par le marche. Vraies news en direct = internet/API = etape EN LIGNE ulterieure.'})
print('> sentiment marche %.2f | classif texte %.0f%% (base %.0f%%) vus=%d' % (cur, acc * 100, base * 100, meta['seen']))
`;


  var PHASE3_PY = `__model_out = None  # PREMIERE ligne executable : neutralise un __model_out global perime laisse par un run agent.py/ia.py precedent (le worker ne persiste que si __model_out est une chaine non vide ; tradl-ai-worker.js l.45 mappe None->null, tradl-lab.js l.702 ne sauve que si truthy).

import json
import numpy as np
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import SGDRegressor
from features import build_features

# df est injecte par le prelude. build_features renvoie 'keep' (FEAT + 'y','c','t_ms')
# et FEAT. 'y' = ret_{t+1} (deja decale dans features.py -> causal, aucune fuite).
keep, FEAT = build_features(df)
X   = keep[FEAT].values.astype(float)     # variables au close de la bougie t
RET = keep['y'].values.astype(float)      # r_{t+1}, deja decale (causal)
N   = len(keep)

if N < 60:
    # Plancher identique a agent.py. On NE leve PAS d'exception (sinon la derniere
    # ligne __model_out=None serait sautee) : on passe par un else.
    __ai_json = json.dumps({'kind': 'exp', 'error': 'pas assez de bougies (' + str(N) + ')'})
    __model_out = None
else:
    # ---- constantes : identiques au code livre, SEULS gamma et stack sont balayes ----
    ACTIONS  = np.array([-1, 0, 1])        # short / plat / long
    ALPHA    = 0.02
    COST     = 0.0006                      # recompense = a*RET - COST*|a-pos_prev| ; PAS de normalisation sigma, PAS de penalite de drawdown
    EPS0     = 0.30
    EPS_MIN  = 0.02
    LAM      = 1e-4
    GAMMA_ON = 0.5                         # knob choisi (point unique), PAS un optimum balaye
    N_SEEDS  = 6
    BURN     = 30                          # rodage identique pour toutes les variantes : apprentissage des j=0, metriques comptees a partir de j>=BURN
    SEEDS    = list(range(N_SEEDS))        # [0..5], reutilises a l'identique sur les 4 variantes (bruit d'exploration apparie)
    YHAT_CLIP = 0.5                        # borne du yhat de stacking : protege le scaler partage si le SGD diverge

    VARIANTS = [('baseline', 0.0,      False),
                ('+gamma',   GAMMA_ON, False),
                ('+stack',   0.0,      True),
                ('+both',    GAMMA_ON, True)]   # (nom, gamma, stack)

    # B&H calcule UNE seule fois, hors run_variant, sur la MEME fenetre mesuree (j>=BURN).
    BH_NET = float(np.exp(RET[BURN:].sum()) - 1)

    def run_variant(gamma, stack, seed):
        # Cold-start de TOUT : rien n'est partage hormis les tableaux immuables X / RET.
        D = len(FEAT) + (1 if stack else 0) + 2   # +yhat (stack seul) +position +biais
        W = np.zeros((3, D))
        scaler = StandardScaler()                  # scaler de l'AGENT, dimensionne a la ligne (eventuellement augmentee)
        rng = np.random.RandomState(seed)          # UNIQUE source d'alea eps-greedy

        if stack:
            # Bundle SL cree a froid DANS chaque run stack (jamais charge, jamais sauve).
            # Parametres copies a l'identique de ia.py. random_state=0 : le SGD est deterministe
            # a ordre de donnees fixe -> l'ecart-type entre graines reflete le bruit d'EXPLORATION.
            sl = SGDRegressor(loss='huber', epsilon=1e-4, penalty='l2', alpha=1e-4,
                              learning_rate='constant', eta0=0.005, fit_intercept=True,
                              warm_start=True, random_state=0, average=10)
            sl_scaler = StandardScaler()           # SEPARE du scaler de l'agent ; scale les FEAT brutes uniquement
            sl_fitted = False                       # yhat = 0.0 tant que le SL n'a pas >=1 partial_fit (valeur causale honnete)

        pos_prev = 0.0
        a_idx = None; z_prev = None; r_prev = 0.0; q_prev_a = 0.0; updates = 0
        pnl_sum = 0.0; pnl_sum2 = 0.0; n_trades = 0.0; wins = 0; steps = 0

        def feat_z(arow, pp):
            xs = scaler.transform(arow)[0]
            return np.concatenate([xs, [pp, 1.0]])

        def greedy(q):
            a = int(np.argmax(q))
            if abs(q[a] - q[1]) < 1e-9: a = 1   # egalite -> PLAT
            return a

        # ---- passe prequentielle UNIQUE (predict-avant-update), pas d'epochs ni de replay ----
        for j in range(N):
            xrow = X[j:j+1]
            # (2) yhat causal : predire AVANT le fit du SL.
            if stack:
                yhat = float(sl.predict(sl_scaler.transform(xrow))[0]) if sl_fitted else 0.0
                # Garde anti-divergence : un SGD a froid peut exploser (inf/nan) et corrompre
                # DEFINITIVEMENT le scaler PARTAGE -> confound asymetrique. On borne identiquement.
                if not np.isfinite(yhat):
                    yhat = 0.0
                elif yhat > YHAT_CLIP:
                    yhat = YHAT_CLIP
                elif yhat < -YHAT_CLIP:
                    yhat = -YHAT_CLIP
                arow = np.concatenate([X[j], [yhat]])[None, :]
            else:
                arow = xrow
            # (3) scaler en ligne : fit-cette-ligne PUIS transform. Meme regime pour TOUTES les
            #     variantes (seule la LARGEUR change avec stack). DEPART DELIBERE d'agent.py : on
            #     N'IMITE PAS son batch scaler.partial_fit(X) du cold start -> ce serait du look-ahead.
            scaler.partial_fit(arow)
            z_now = feat_z(arow, pos_prev)
            q_now = W @ z_now
            a_greedy = greedy(q_now)
            # (6) metriques de la politique GLOUTONNE, comptees seulement si j>=BURN.
            ag = ACTIONS[a_greedy]
            rg = ag * RET[j] - COST * abs(ag - pos_prev)
            if j >= BURN:
                pnl_sum += rg; pnl_sum2 += rg * rg
                n_trades += abs(ag - pos_prev) / 2.0; wins += int(rg > 0); steps += 1
            # (7) action eps-greedy pour l'UPDATE. PAIRAGE DES GRAINES : les tirages RNG ne dependent
            #     NI de W, NI de gamma, NI de stack -> flux synchronises entre variantes. eps depend
            #     de 'updates', dont l'evolution doit rester identique entre variantes.
            eps = max(EPS_MIN, EPS0 * (0.9995 ** updates))
            a_t = rng.randint(3) if rng.rand() < eps else a_greedy
            # (8) update SARSA sur la transition PRECEDENTE.
            if a_idx is not None:
                delta = r_prev + gamma * q_now[a_t] - q_prev_a
                W[a_idx] += ALPHA * delta * z_prev
                W[a_idx] *= (1 - ALPHA * LAM)
                updates += 1
            # (9) report d'etat.
            r_t = ACTIONS[a_t] * RET[j] - COST * abs(ACTIONS[a_t] - pos_prev)
            a_idx = a_t; z_prev = z_now; r_prev = r_t; q_prev_a = q_now[a_t]
            pos_prev = ACTIONS[a_t]
            # (10) update SL EN DERNIER (apres que l'agent a agi sur yhat_j -> yhat_j n'a vu que < j).
            if stack:
                sl_scaler.partial_fit(xrow)
                sl.partial_fit(sl_scaler.transform(xrow), RET[j:j+1])
                sl_fitted = True

        # ---- metriques du run (agent.py a l'identique) ----
        ns = max(1, steps)
        r_mean = pnl_sum / ns
        var = pnl_sum2 / ns - r_mean * r_mean
        r_std = var ** 0.5 if var > 1e-18 else 1e-9
        sharpe = float(r_mean / r_std * np.sqrt(252))
        net = float(np.exp(pnl_sum) - 1)
        win = wins / ns
        turn = n_trades / ns
        return {'net': net, 'sharpe': sharpe, 'win': win, 'turn': turn}

    # ---- driver : toutes les variantes x graines, agregation (ecart-type population) ----
    results = []
    for (name, g, stack) in VARIANTS:
        runs = [run_variant(g, stack, s) for s in SEEDS]

        def agg(k, _runs=runs):
            a = np.array([r[k] for r in _runs], dtype=float)
            return float(a.mean()), float(a.std())

        net_m, net_s   = agg('net')
        shp_m, shp_s   = agg('sharpe')
        win_m, win_s   = agg('win')
        turn_m, turn_s = agg('turn')
        # edge = win - 0.5 : translation par une constante -> std(edge) == std(win) EXACTEMENT.
        results.append({
            'name': name,
            'net_mean': net_m, 'net_std': net_s,
            'sharpe_mean': shp_m, 'sharpe_std': shp_s,
            'win_mean': win_m, 'win_std': win_s,
            'turn_mean': turn_m, 'turn_std': turn_s,
            'edge_mean': win_m - 0.5, 'edge_std': win_s})

    # Classement DESCRIPTIF par Sharpe moyen mesure (pas une recommandation).
    ranking = [r['name'] for r in sorted(results, key=lambda r: r['sharpe_mean'], reverse=True)]

    n_meas = N - BURN
    LOW_N = bool(n_meas < 120)

    NOTE = ("Mesure brute sur UNE seule histoire de marche (non reproductible). "
            "Apres frais (0.0006/rotation) sur ce marche quasi-efficient, l'avantage attendu "
            "est ~0 par construction ; un ecart plus petit que l'ecart-type entre graines n'est "
            "PAS distinguable. Les graines controlent le hasard d'exploration, PAS l'incertitude "
            "de trajectoire de marche ; le SL de stacking est deterministe a graine donnee, donc "
            "son ecart-type ne capte que l'exploration. net/rotation refletent des actions "
            "GLOUTONNES prises depuis une position EXPLORATOIRE (fidele a agent.py), pas un backtest "
            "purement glouton. Le classement est descriptif (par Sharpe moyen mesure), ce n'est PAS "
            "une recommandation. gamma=0.5 est un point unique, pas un optimum balaye ; les resultats "
            "varient avec plus de donnees.")
    if LOW_N:
        NOTE = ("ATTENTION : seulement %d pas mesures (< 120) -> l'ecart-type entre graines n'est PAS "
                "fiable, ne pas surinterpreter le tableau. " % n_meas) + NOTE

    # ---- sortie stdout (console) : ASCII largeur fixe ----
    def fmt_sh(v):
        if not np.isfinite(v): return ' inf'
        if v > 99.99: return '  >99'
        if v < -99.99: return ' <-99'
        return '%+5.2f' % v
    def fmt_net(v):
        if not np.isfinite(v): return '   inf'
        if v > 999.99: return ' >999'
        if v < -99.99: return ' <-99'
        return '%+6.2f' % v

    print('=== Phase 3 : A/B gamma x stacking (%d pas mesures, %d graines) ===' % (n_meas, N_SEEDS))
    if LOW_N:
        print('!! fenetre courte (%d pas) : ecart-type entre graines peu fiable, lecture prudente.' % n_meas)
    print('%-9s | net%%        | Sharpe       | win%%        | rotation     | edge' % 'variante')
    for r in results:
        print('%-9s | %s+/-%4.2f | %s+/-%4.2f | %5.1f+/-%4.1f | %5.2f+/-%4.2f | %+5.3f+/-%4.3f' % (
            r['name'], fmt_net(r['net_mean'] * 100), min(r['net_std'] * 100, 99.99),
            fmt_sh(r['sharpe_mean']), min(r['sharpe_std'], 99.99),
            r['win_mean'] * 100, r['win_std'] * 100,
            r['turn_mean'], r['turn_std'], r['edge_mean'], r['edge_std']))
    print('%-9s | %s%% (deterministe, 1 histoire, meme fenetre j>=%d)' % ('B&H', fmt_net(BH_NET * 100), BURN))
    print('classement par Sharpe moyen (descriptif): ' + ' > '.join(ranking))
    print(NOTE)

    # ---- sortie structuree pour la carte UI ----
    out = {
        'kind': 'exp',
        'title': 'Phase 3 — A/B gamma x stacking',
        'n_steps': n_meas, 'n_seeds': N_SEEDS, 'burn': BURN,
        'gamma_on': GAMMA_ON, 'cost': COST, 'bh_net': BH_NET,
        'low_n_warning': LOW_N,
        'table': results, 'ranked_by': 'sharpe_mean', 'ranking': ranking, 'note': NOTE}
    __ai_json = json.dumps(out)

__model_out = None  # DERNIERE ligne, inconditionnelle : aucune persistance (ne jamais ecraser les bundles SL/RL/texte).
`;



  var CERVEAU_PY = `__model_out = None  # PREMIERE ligne executable : neutralise un __model_out global perime laisse par un run ia.py/agent.py precedent (le worker ne persiste que si __model_out est une chaine non vide).

import json, base64, pickle, math
import numpy as np
import pandas as pd

# ---------- libelles FR + formatteurs + groupes thematiques (clefs = NOM de variable) ----------
LABELS = {
    'ret1': "Rendement t-1", 'ret2': "Rendement t-2", 'ret3': "Rendement t-3",
    'mom3': "Momentum 3", 'mom5': "Momentum 5", 'mom10': "Momentum 10",
    'dsma20': "Ecart a la moyenne 20", 'dsma50': "Ecart a la moyenne 50",
    'emax': "Croisement EMA 9/21", 'rsi': "RSI (sur/sous-achat)",
    'macd': "MACD (ligne, norm.)", 'macdh': "MACD (histogramme)",
    'stok': "Stochastique %K", 'stod': "Stochastique %D",
    'atrn': "ATR (volatilite norm.)", 'bbw': "Largeur bandes Bollinger",
    'bbp': "Position dans Bollinger", 'dvwap': "Ecart au VWAP",
    'volr': "Volume relatif (vs 20)", 'rng': "Amplitude de la bougie",
    'body': "Corps de bougie (clot-ouvr)", 'ofdn': "Flux d'ordres net",
    'bsr': "Ratio acheteurs/vendeurs", 'spr': "Spread relatif (liquidite)",
    'imb': "Desequilibre du carnet", 'mom20': "Tendance 20 bougies",
    'mom50': "Tendance 50 bougies", 'pos50': "Position dans le range 50",
    'slope20': "Pente 20 (normalisee)", 'vof': "Vol x flux (interaction)",
    'ofdn1': "Flux d'ordres net (t-1)", 'ofdn2': "Flux d'ordres net (t-2)",
    'imb1': "Desequilibre carnet (t-1)", 'imb2': "Desequilibre carnet (t-2)",
    'sent': "Sentiment des news", 'sent_chg': "Variation du sentiment",
    'sent_x_mom': "Sentiment x momentum 5",
    'lret': "Rendement depuis le debut", 'pos_all': "Position dans le range total",
    'dath': "Distance au plus-haut hist.", 'datl': "Distance au plus-bas hist.",
    'dema100': "Ecart a la tendance longue (EMA100)",
}
FMT = {
    'ret1': 'sgn3', 'ret2': 'sgn3', 'ret3': 'sgn3',
    'mom3': 'pct2', 'mom5': 'pct2', 'mom10': 'pct2',
    'dsma20': 'sgn2', 'dsma50': 'sgn2', 'emax': 'sgn2', 'rsi': 'num0',
    'macd': 'sgn3', 'macdh': 'sgn3', 'stok': 'num0', 'stod': 'num0',
    'atrn': 'pct2', 'bbw': 'pct2', 'bbp': 'sgn2', 'dvwap': 'sgn2',
    'volr': 'num2', 'rng': 'pct2', 'body': 'sgn3', 'ofdn': 'flow',
    'bsr': 'flow', 'spr': 'pct2', 'imb': 'flow', 'mom20': 'pct2',
    'mom50': 'pct2', 'pos50': 'pct1', 'slope20': 'sgn3', 'vof': 'sgn3',
    'ofdn1': 'flow', 'ofdn2': 'flow', 'imb1': 'flow', 'imb2': 'flow',
    'sent': 'sent', 'sent_chg': 'sgn3', 'sent_x_mom': 'sgn3',
    'lret': 'pct2', 'pos_all': 'pct1', 'dath': 'sgn2', 'datl': 'sgn2', 'dema100': 'sgn2',
}
GROUPS = [
    ("Prix & tendance", ['dsma20', 'dsma50', 'emax', 'dvwap', 'mom20', 'mom50', 'pos50', 'slope20', 'macd', 'macdh']),
    ("Momentum", ['ret1', 'ret2', 'ret3', 'mom3', 'mom5', 'mom10', 'rsi', 'stok', 'stod']),
    ("Volatilite", ['atrn', 'bbw', 'bbp', 'rng', 'vof']),
    ("Microstructure & carnet", ['body', 'volr', 'ofdn', 'ofdn1', 'ofdn2', 'bsr', 'spr', 'imb', 'imb1', 'imb2']),
    ("Sentiment", ['sent', 'sent_chg', 'sent_x_mom']),
    ("Vue d'ensemble", ['lret', 'pos_all', 'dath', 'datl', 'dema100']),
]


def fin(x):
    try:
        v = float(x)
    except Exception:
        return 0.0
    if not math.isfinite(v):
        return 0.0
    return v


def lab(f):
    return LABELS.get(f, f)


def _last_closed_row(df, FEAT):
    """Reconstruit la rangee de variables de la DERNIERE bougie CLOTUREE (bougie T).

    features.build_features() decale la cible y = ret_{t+1} puis dropna sur 'y' :
    la toute derniere bougie cloturee (dont le successeur n'existe pas encore) est
    donc SUPPRIMEE de 'keep'. On rejoue ici le MEME pipeline causal que features.py
    mais on ne supprime PAS sur 'y' -> on garde la bougie T. Aucune fuite : 'y' n'est
    jamais utilise, on ne lit que des indicateurs passes/presents de la bougie T.
    Renvoie (t_ms:int, c:float, raw:np.ndarray[len(FEAT)], atrn_series) ou None si echec.
    """
    d = df.copy().reset_index(drop=True)
    if len(d) > 5:
        d = d.iloc[:-1].reset_index(drop=True)   # on enleve la bougie EN FORMATION
    if len(d) < 2:
        return None
    c = d['c']; o = d['o']; h = d['h']; l = d['l']; vv = d['v']
    d['t_ms'] = (df['t'].iloc[:len(d)].values.astype('int64') // 10**6)
    d['ret'] = np.log(c / c.shift(1))
    for k in (1, 2, 3): d['ret%d' % k] = d['ret'].shift(k)
    for k in (3, 5, 10): d['mom%d' % k] = c.pct_change(k)
    sma20 = c.rolling(20).mean(); sma50 = c.rolling(50).mean()
    d['dsma20'] = c / sma20 - 1; d['dsma50'] = c / sma50 - 1
    d['emax'] = c.ewm(span=9, adjust=False).mean() / c.ewm(span=21, adjust=False).mean() - 1
    delta = c.diff(); up = delta.clip(lower=0).ewm(alpha=1/14, adjust=False).mean(); dn = (-delta.clip(upper=0)).ewm(alpha=1/14, adjust=False).mean()
    d['rsi'] = 100 - 100 / (1 + up / dn.replace(0, 1e-9))
    macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    d['macd'] = macd / c; d['macdh'] = (macd - macd.ewm(span=9, adjust=False).mean()) / c
    lo14 = l.rolling(14).min(); hi14 = h.rolling(14).max()
    d['stok'] = 100 * (c - lo14) / (hi14 - lo14).replace(0, 1e-9); d['stod'] = d['stok'].rolling(3).mean()
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1/14, adjust=False).mean(); d['atrn'] = atr / c
    std20 = c.rolling(20).std(); d['bbw'] = 4 * std20 / sma20; d['bbp'] = (c - sma20) / (2 * std20).replace(0, 1e-9)
    vwap = (((h + l + c) / 3) * vv).cumsum() / vv.cumsum(); d['dvwap'] = c / vwap - 1
    d['volr'] = vv / vv.rolling(20).mean(); d['rng'] = (h - l) / c; d['body'] = (c - o) / c
    for _col in ('spread', 'imb', 'ofd', 'bvol', 'svol'):
        if _col not in d.columns: d[_col] = 0.0
    d['ofdn'] = d['ofd'] / (d['v'] + 1); d['bsr'] = (d['bvol'] - d['svol']) / (d['bvol'] + d['svol'] + 1); d['spr'] = d['spread'] / c
    d['mom20'] = c.pct_change(20); d['mom50'] = c.pct_change(50)
    _lo50 = c.rolling(50).min(); _hi50 = c.rolling(50).max()
    d['pos50'] = (c - _lo50) / (_hi50 - _lo50).replace(0, 1e-9); d['slope20'] = (c - c.shift(20)) / 20 / c
    d['vof'] = d['atrn'] * d['ofdn']
    d['ofdn1'] = d['ofdn'].shift(1); d['ofdn2'] = d['ofdn'].shift(2)
    d['imb1'] = d['imb'].shift(1); d['imb2'] = d['imb'].shift(2)
    if 'sent' in df.columns: d['sent'] = df['sent'].iloc[:len(d)].values
    else: d['sent'] = 0.0
    d['sent_chg'] = d['sent'].diff().fillna(0.0); d['sent_x_mom'] = d['sent'] * d['mom5']
    # --- VUE D'ENSEMBLE (identique a features.py / ia.py : contexte long terme causal) ---
    d['lret'] = np.log(c / c.iloc[0])
    _emx = c.expanding().max(); _emn = c.expanding().min()
    d['pos_all'] = (c - _emn) / (_emx - _emn).replace(0, 1e-9)
    d['dath'] = c / _emx - 1
    d['datl'] = c / _emn.replace(0, 1e-9) - 1
    d['dema100'] = c / c.ewm(span=100, adjust=False).mean() - 1
    d['c'] = c.values
    keep = d.dropna(subset=FEAT + ['t_ms', 'spr']).reset_index(drop=True)   # PAS de 'y' -> on garde la bougie T
    if len(keep) < 1:
        return None
    lagrow = keep.iloc[-1]
    t_ms = int(lagrow['t_ms'])
    cc = float(lagrow['c'])
    raw = lagrow[FEAT].values.astype(float)
    raw = np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)
    atrn_series = keep['atrn'].astype(float)   # serie atrn sur bougies cloturees -> vol_scale identique a ia.py
    return t_ms, cc, raw, atrn_series


# ---------- tout le corps est protege : on emet TOUJOURS __ai_json puis __model_out=None ----------
try:
    import sklearn
    from features import build_features

    # entrees injectees par le prelude / computeForecast : repli '' si absentes (cf agent.py l.310-313)
    try:
        __model_in
    except NameError:
        __model_in = ''
    try:
        __rl_in
    except NameError:
        __rl_in = ''
    try:
        __text_in
    except NameError:
        __text_in = ''
    try:
        __news_json
    except NameError:
        __news_json = '[]'

    keep, FEAT = build_features(df)
    if len(keep) < 1:
        raise ValueError("aucune bougie cloturee exploitable")

    # --- bougie T = derniere bougie CLOTUREE (corrige le decalage d'un pas du dropna sur 'y') ---
    lc = _last_closed_row(df, FEAT)
    candle_lag = False
    if lc is None:
        # repli : on retombe sur keep.iloc[-1] (bougie T-1) et on le signale honnetement
        candle_lag = True
        last_t = int(keep['t_ms'].iloc[-1])
        last_c = float(keep['c'].iloc[-1])
        raw = keep[FEAT].iloc[-1].values.astype(float)
        raw = np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)
        atrn_series = keep['atrn'].astype(float)
    else:
        last_t, last_c, raw, atrn_series = lc

    # facteur d'echelle de volatilite COURANTE, identique a ia.py l.213-214 (cone du graphe)
    try:
        _vn = float(atrn_series.iloc[-1]); _vm = float(atrn_series.tail(120).mean())
        vol_scale = min(3.0, max(0.3, _vn / _vm)) if _vm > 0 else 1.0
    except Exception:
        vol_scale = 1.0
    if not math.isfinite(vol_scale):
        vol_scale = 1.0

    # ============================ SECTION SUPERVISEE (SGDRegressor) ============================
    sl = None
    if not __model_in:
        sl = {'trained': False, 'reason': "modele supervise pas encore entraine - lance ia.py"}
    else:
        try:
            b = pickle.loads(base64.b64decode(__model_in))
        except Exception:
            b = None
            sl = {'trained': False, 'reason': "bundle supervise illisible - relance ia.py"}
        if sl is None and not isinstance(b, dict):
            sl = {'trained': False, 'reason': "bundle supervise non conforme - relance ia.py"}
        if sl is None:
            if b.get('feat') != FEAT:
                sl = {'trained': False, 'reason': "schema de variables different - relance ia.py"}
            elif b.get('meta', {}).get('skl') != sklearn.__version__:
                sl = {'trained': False, 'reason': "version scikit-learn differente - relance ia.py"}
            else:
                model = b.get('model'); scaler = b.get('scaler'); meta = b.get('meta', {})
                if model is None or scaler is None or not hasattr(model, 'coef_') or model.coef_ is None:
                    sl = {'trained': False, 'reason': "modele pas encore ajuste - lance ia.py"}
                else:
                    mean = np.asarray(scaler.mean_, dtype=float)
                    scale = np.asarray(scaler.scale_, dtype=float)
                    safe_scale = np.where((scale == 0) | (~np.isfinite(scale)), 1.0, scale)
                    z = (raw - mean) / safe_scale
                    z = np.nan_to_num(z, nan=0.0, posinf=0.0, neginf=0.0)
                    coef = np.asarray(model.coef_, dtype=float).ravel()
                    intercept = float(np.asarray(model.intercept_, dtype=float).ravel()[0])
                    contrib = coef * z
                    contrib = np.nan_to_num(contrib, nan=0.0, posinf=0.0, neginf=0.0)
                    yhat = intercept + float(contrib.sum())

                    # reconciliation EXACTE avec model.predict : verrouille le chiffre affiche sur celui de ia.py
                    reconcile = True
                    try:
                        yhat_chk = float(model.predict(scaler.transform([raw]))[0])
                        if not math.isfinite(yhat_chk):
                            yhat_chk = yhat
                        if abs(yhat - yhat_chk) > 1e-9:
                            reconcile = False
                            yhat = yhat_chk   # on fait foi du predict reel
                    except Exception:
                        reconcile = False

                    pt = max(1, int(meta.get('pq_total', 0)))
                    life_acc = meta.get('pq_correct', 0) / pt
                    life_base = max(meta.get('pq_base_up', 0), meta.get('pq_total', 0) - meta.get('pq_base_up', 0)) / pt
                    life_edge = life_acc - life_base
                    rn = meta.get('resid_n', 0)
                    sigma = (meta.get('resid_sum2', 0.0) / rn) ** 0.5 if rn else 0.0
                    band_pct = 1.28 * sigma * vol_scale * 100   # bande ~80% a 1 pas, a l'echelle de la vol courante (= cone ia.py)
                    n_oos = int(meta.get('pq_total', 0))
                    signif = bool(n_oos >= 100 and life_edge > 1.96 * (0.25 / pt) ** 0.5)

                    # "structurellement ignore" = poids par unite brute ~ 0 (|coef|/scale), INDEPENDANT de la bougie
                    perunit = np.abs(coef) / safe_scale
                    perunit = np.nan_to_num(perunit, nan=0.0, posinf=0.0, neginf=0.0)
                    pmax = float(np.max(perunit)) if len(perunit) else 0.0
                    ignored = [FEAT[i] for i in range(len(FEAT))
                               if pmax > 0 and perunit[i] < 0.01 * pmax]

                    contribs = []
                    for i in range(len(FEAT)):
                        contribs.append({'feat': FEAT[i], 'label': lab(FEAT[i]),
                                         'raw': fin(raw[i]), 'z': fin(z[i]),
                                         'coef': fin(coef[i]), 'contrib': fin(contrib[i])})
                    contribs.sort(key=lambda r: abs(r['contrib']), reverse=True)

                    sl = {'trained': True, 'seen': int(meta.get('seen', 0)), 'n_oos': n_oos,
                          'yhat': fin(yhat), 'yhat_pct': fin(yhat * 100), 'up': bool(yhat > 0),
                          'sigma': fin(sigma), 'band_pct': fin(band_pct), 'vol_scale': fin(vol_scale),
                          'life_acc': fin(life_acc), 'life_base': fin(life_base), 'life_edge': fin(life_edge),
                          'signif': signif, 'reconcile': bool(reconcile),
                          'intercept': fin(intercept), 'intercept_pct': fin(intercept * 100),
                          'contribs': contribs, 'ignored': ignored}

    # ============================ SECTION AGENT (SARSA lineaire) ============================
    rl = None
    if not __rl_in:
        rl = {'trained': False, 'reason': "agent pas encore entraine - lance agent.py"}
    else:
        try:
            b = pickle.loads(base64.b64decode(__rl_in))
        except Exception:
            b = None
            rl = {'trained': False, 'reason': "bundle agent illisible - relance agent.py"}
        if rl is None and not isinstance(b, dict):
            rl = {'trained': False, 'reason': "bundle agent non conforme - relance agent.py"}
        if rl is None:
            D = len(FEAT) + 2
            if b.get('kind') != 'rl' or b.get('feat') != FEAT:
                rl = {'trained': False, 'reason': "schema de variables different - relance agent.py"}
            elif b.get('meta', {}).get('skl') != sklearn.__version__:
                rl = {'trained': False, 'reason': "version scikit-learn differente - relance agent.py"}
            elif b.get('W') is None or np.asarray(b['W']).shape != (3, D):
                rl = {'trained': False, 'reason': "dimensions de l'agent incompatibles - relance agent.py"}
            elif b.get('scaler') is None:
                rl = {'trained': False, 'reason': "agent sans normaliseur - relance agent.py"}
            else:
                W = np.asarray(b['W'], dtype=float); scaler = b['scaler']
                meta = b.get('meta', {}); cfg = b.get('cfg') or {}
                eps0 = cfg.get('eps0', 0.30); eps_min = cfg.get('eps_min', 0.02)
                try:
                    xs = scaler.transform([raw])[0]
                except Exception:
                    xs = np.zeros(len(FEAT))
                xs = np.nan_to_num(np.asarray(xs, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
                pos_used = 0.0
                z = np.concatenate([xs, [pos_used, 1.0]])
                Q = W @ z
                Q = np.nan_to_num(Q, nan=0.0, posinf=0.0, neginf=0.0)
                ACTIONS = [-1, 0, 1]
                a = int(np.argmax(Q))
                if abs(Q[a] - Q[1]) < 1e-9:
                    a = 1
                chosen = ACTIONS[a]
                best = float(np.max(Q)); second = float(sorted(Q)[-2])
                margin = fin(best - second)
                eps = max(eps_min, eps0 * (0.9995 ** meta.get('updates', 0)))

                # decomposition EXACTE de (Q_long - Q_short) : 37 variables + colonne position + colonne biais
                idx_pos = len(FEAT)       # colonne position
                idx_bias = len(FEAT) + 1  # colonne biais (constante 1.0)
                drivers = []
                for i in range(len(FEAT)):
                    push = (W[2][i] - W[0][i]) * z[i]
                    drivers.append({'feat': FEAT[i], 'label': lab(FEAT[i]), 'push': fin(push)})
                drivers.sort(key=lambda r: abs(r['push']), reverse=True)
                pos_push = fin((W[2][idx_pos] - W[0][idx_pos]) * z[idx_pos])      # = 0 (pos_used=0) mais emis par honnetete
                bias_push = fin((W[2][idx_bias] - W[0][idx_bias]) * z[idx_bias])  # terme constant (colonne biais)
                # Reconciliation EXACTE : sum(drivers.push) + pos_push + bias_push == Q_long - Q_short
                recon = float(sum(r['push'] for r in drivers)) + pos_push + bias_push
                rl_reconcile = bool(abs(recon - (fin(Q[2]) - fin(Q[0]))) < 1e-7)

                rl = {'trained': True, 'seen': int(meta.get('seen', 0)), 'eps': fin(eps), 'pos_used': 0.0,
                      'Q': [fin(Q[0]), fin(Q[1]), fin(Q[2])], 'chosen': int(chosen), 'margin': margin,
                      'bias_push': bias_push, 'pos_push': pos_push, 'reconcile': rl_reconcile,
                      'drivers': drivers}

    # ============================ SECTION NLP (texte) ============================
    nlp = {'trained': False, 'seen': 0, 'market_sent': None, 'last_news': None}
    if __text_in:
        try:
            bt = pickle.loads(base64.b64decode(__text_in))
        except Exception:
            bt = None
        if isinstance(bt, dict) and bt.get('kind') == 'text' and bt.get('meta', {}).get('skl') == sklearn.__version__:
            tmeta = bt.get('meta', {})
            seen = int(tmeta.get('seen', 0))
            last_news = None; market_sent = None
            try:
                arr = json.loads(__news_json or '[]')
            except Exception:
                arr = []
            if isinstance(arr, list) and arr:
                cand = [n for n in arr if isinstance(n, dict)]
                if cand:
                    last = sorted(cand, key=lambda n: n.get('t', 0))[-1]
                    txt = last.get('text')
                    if txt:
                        last_news = str(txt)[:120]
                    # 's' = etiquette VRAIE du marche simule (PAS une sortie du modele) ; libelle honnetement cote UI
                    if 's' in last:
                        try:
                            market_sent = fin(last['s'])
                        except Exception:
                            market_sent = None
            nlp = {'trained': True, 'seen': seen, 'market_sent': market_sent, 'last_news': last_news}

    # ============================ GROUPES (37 valeurs brutes, 5 themes) ============================
    rawmap = {FEAT[i]: raw[i] for i in range(len(FEAT))}
    groups = []
    for name, feats in GROUPS:
        items = []
        for f in feats:
            items.append({'feat': f, 'label': lab(f), 'val': fin(rawmap.get(f, 0.0)), 'fmt': FMT.get(f, 'num2')})
        groups.append({'name': name, 'items': items})

    # ============================ "CE QU'ELLE NE FAIT PAS" ============================
    not_doing = []
    if isinstance(sl, dict) and sl.get('trained') and sl.get('ignored'):
        ig = [lab(f) for f in sl['ignored']]
        not_doing.append("Poids structurellement quasi nuls (|poids| par unite brute ~ 0, quelle que soit la bougie) : "
                         + ", ".join(ig[:6]) + ("..." if len(ig) > 6 else ""))
    not_doing.append("Ne TRICHE pas sur le futur : elle predit la bougie SUIVANTE sans la connaitre (cible decalee, zero fuite). C'est CE QUI REND la fiabilite affichee honnete -- un modele qui 'verrait' le futur ne predirait rien, il tricherait.")
    not_doing.append("Lit le passe a travers 37 indicateurs = des RESUMES de l'historique (tendances, momentum, position dans les ranges). Le mode 'analogues/kNN' compare en plus l'etat courant a TOUT l'historique. La 'vue d'ensemble' (depuis le debut du marche) peut s'elargir en ajoutant des variables long terme.")
    not_doing.append("Poids FIGES : ce panneau ne re-entraine RIEN. Les poids ne bougent que si tu relances ia.py / agent.py.")
    not_doing.append("Avantage minuscule par construction : apres frais, sur un marche quasi-efficient, l'edge reel reste proche de zero.")
    not_doing.append("La decision affichee est calculee DEPUIS UNE POSITION PLATE (pos=0) ; la vraie decision de l'agent depend de sa position en cours (non sauvegardee ici) et peut differer - notamment parce que changer de position coute des frais.")
    if candle_lag:
        not_doing.append("Repli technique : impossible de reconstruire la toute derniere bougie cloturee, la radiographie porte sur la bougie precedente.")

    note = "Tout ci-dessus est la decomposition EXACTE de modeles lineaires figes : transparent, mais l'avantage reel apres frais reste proche de zero."

    out = {'kind': 'mind', 't': int(last_t), 'price': fin(last_c), 'candle_lag': bool(candle_lag),
           'sl': sl, 'rl': rl, 'nlp': nlp, 'groups': groups,
           'not_doing': not_doing, 'note': note}
    __ai_json = json.dumps(out)
    print("> radiographie de l'IA : SL=%s RL=%s NLP=%s | prix %.5f" % (
        (sl or {}).get('trained'), (rl or {}).get('trained'), nlp.get('trained'), last_c))

except Exception as _e:
    __ai_json = json.dumps({'kind': 'mind', 'error': "radiographie impossible : " + str(_e)})
    print('> erreur radiographie :', str(_e))

__model_out = None  # DERNIERE ligne, inconditionnelle : lecture seule, aucune persistance.
`;


  var AUTO_PY = `__model_out = None  # PREMIERE ligne executable : neutralise un __model_out global perime (le worker ne persiste que si __model_out est une chaine non vide ; ici on ne persiste JAMAIS de modele -> on contourne le garde 1.5 Mo).

import json, time, math
import numpy as np

# __auto_in : etat accumule (journal + compteur de passes) reinjecte par le JS (voir js_other edit 4).
# Garde NameError : sur le tout premier run (ou si l'injection JS n'est pas encore posee), '' -> repart a vide.
try:
    __auto_in
except NameError:
    __auto_in = ''
try:
    prior = json.loads(__auto_in) if __auto_in else {}
    if not isinstance(prior, dict): prior = {}
except Exception:
    prior = {}
PRIOR_JOURNAL = prior.get('journal', []) if isinstance(prior.get('journal', []), list) else []
PASS = int(prior.get('pass_count', 0)) + 1

COST = 0.0006   # frais par rotation (defini AVANT la note pour eviter toute derive de texte)
NOTE = ("Mesure sur UNE seule histoire de marche (non reproductible entre re-tirages). Apres frais "
        "(%.4f/rotation) sur ce marche quasi-efficient, l'avantage attendu est ~0 par construction ; "
        "un candidat ne gagne que sur le rendement HORS ECHANTILLON net de frais, penalise par l'ecart "
        "train/OOS (mesure dans le MEME domaine que le score) et la rotation. Le Sharpe est PAR TRANSACTION "
        "(non annualise : la duree d'une barre est inconnue). Les tests de significativite sont approximatifs "
        "et anti-conservateurs (autocorrelation residuelle) -> a lire avec prudence. Aucune promesse de performance." % COST)

def _fin(v, d=0.0):
    try:
        v = float(v)
        return v if math.isfinite(v) else d
    except Exception:
        return d

def _jsafe(x):
    # encodeur de secours pour json.dumps : convertit numpy/bool/inf en types surs.
    if isinstance(x, (np.floating,)):
        x = float(x)
    if isinstance(x, float):
        return x if math.isfinite(x) else 0.0
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.bool_,)):
        return bool(x)
    if isinstance(x, np.ndarray):
        return [_jsafe(v) for v in x.tolist()]
    return str(x)

def _dumps(obj):
    # allow_nan=False + default=_jsafe : JSON TOUJOURS valide cote JS (sinon JSON.parse echoue -> carte vide).
    try:
        return json.dumps(obj, allow_nan=False, default=_jsafe)
    except Exception:
        # dernier recours : on reserialise une version assainie cle par cle
        safe = {}
        for k, v in (obj.items() if isinstance(obj, dict) else []):
            try:
                json.dumps(v, allow_nan=False, default=_jsafe); safe[k] = v
            except Exception:
                safe[k] = None
        return json.dumps(safe, allow_nan=False, default=_jsafe)

def emit_error(msg):
    global __ai_json
    __ai_json = _dumps({'kind': 'auto', 'error': str(msg), 'note': NOTE,
                        'ts': int(time.time() * 1000), 'journal': PRIOR_JOURNAL,
                        'pass_count': PASS})

try:
    from features import build_features
    from sklearn.preprocessing import StandardScaler
    from sklearn.decomposition import PCA
    from sklearn.linear_model import Ridge
    from sklearn.tree import DecisionTreeRegressor
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.neighbors import KNeighborsRegressor
    from sklearn.neural_network import MLPRegressor
    from sklearn.pipeline import Pipeline
    import sklearn

    try:
        from sklearn.ensemble import HistGradientBoostingRegressor
        def make_gbm():
            return HistGradientBoostingRegressor(max_depth=3, max_iter=60, learning_rate=0.08,
                                                 min_samples_leaf=20, random_state=0)
        GBM_IMPL = 'HistGradientBoosting'
    except Exception:
        from sklearn.ensemble import GradientBoostingRegressor
        def make_gbm():
            return GradientBoostingRegressor(n_estimators=40, max_depth=3, learning_rate=0.08,
                                             subsample=0.8, random_state=0)
        GBM_IMPL = 'GradientBoosting'
        print('[gbm] repli GradientBoosting (HistGradientBoosting indispo)')

    keep, FEAT = build_features(df)
    N = len(keep)

    if N < 80:
        emit_error('pas assez de bougies (%d) ; il en faut au moins 80.' % N)
    else:
        c = keep['c'].values.astype(float)
        ALL = list(FEAT)
        MICRO = ['ofdn', 'bsr', 'spr', 'imb', 'vof', 'ofdn1', 'ofdn2', 'imb1', 'imb2', 'volr', 'rng', 'body', 'atrn', 'bbw']
        TREND = ['ret1', 'ret2', 'ret3', 'mom3', 'mom5', 'mom10', 'mom20', 'mom50', 'dsma20', 'dsma50', 'emax', 'slope20', 'pos50', 'macd', 'macdh', 'rsi']
        MICRO = [f for f in MICRO if f in FEAT]   # robustesse : on ne garde que les noms reellement presents
        TREND = [f for f in TREND if f in FEAT]
        FS = {'ALL': ALL, 'MICRO': MICRO, 'TREND': TREND}

        # PCA bornee a min(7, n_feat-1) : evite l'erreur si un jeu a peu de colonnes (anti-crash kNN).
        N_PCA = max(2, min(7, len(ALL) - 1))

        # MODELES construits a la volee (fabrique par lambda) -> chaque pli a un estimateur NEUF.
        # Scaler / PCA / poids MLP sont DANS le Pipeline -> fit par-pli uniquement (anti-fuite structurel).
        # kNN : weights='uniform' (evite division par 0 si un point de test coincide avec un point d'entrainement).
        MODELS = {
            'ridge1':  ('light', lambda: Pipeline([('s', StandardScaler()), ('m', Ridge(alpha=1.0))])),
            'ridge10': ('light', lambda: Pipeline([('s', StandardScaler()), ('m', Ridge(alpha=10.0))])),
            'tree':    ('light', lambda: DecisionTreeRegressor(max_depth=4, min_samples_leaf=20, random_state=0)),
            'knn':     ('light', lambda: Pipeline([('s', StandardScaler()), ('p', PCA(n_components=N_PCA, random_state=0)), ('m', KNeighborsRegressor(n_neighbors=20, weights='uniform'))])),
            'forest':  ('heavy', lambda: RandomForestRegressor(n_estimators=40, max_depth=4, min_samples_leaf=20, n_jobs=1, random_state=0)),
            'gbm':     ('heavy', make_gbm),
            'mlp':     ('mlp',   lambda: Pipeline([('s', StandardScaler()), ('m', MLPRegressor(hidden_layer_sizes=(20,), alpha=1e-3, early_stopping=True, max_iter=150, n_iter_no_change=8, random_state=0))])),
        }
        MODEL_FR = {'ridge1': 'Ridge (alpha=1)', 'ridge10': 'Ridge (alpha=10)', 'tree': 'arbre de decision',
                    'knn': 'k plus proches voisins (analogues facon echiquier)', 'forest': 'foret aleatoire',
                    'gbm': 'gradient boosting', 'mlp': 'reseau de neurones (MLP)'}

        LAMBDA_GAP = 1.5      # penalite sur l'ecart de SHARPE train/OOS (meme domaine que le score -> commensurable)
        LAMBDA_ACC = 2.0      # penalite sur l'ecart de FIABILITE directionnelle train/OOS (en pts)
        LAMBDA_TURN = 0.5
        LAMBDA_N = 1.0
        N_MIN_OOS = 20
        GAP_MAX = 0.08        # garde dure : ecart directionnel train/OOS tolere (<=8 pts)
        BASE_MARGIN = 0.10    # un candidat doit battre la meilleure base de reference d'au moins 0.10 de score
        SOFT_BUDGET = 42.0
        H_MAIN = [1, 5, 20]
        t_start = time.time()

        # ---- CIBLES CAUSALES : r_{t->t+h} = log(c[t+h]/c[t]). Les h dernieres lignes n'ont pas de cible -> exclues.
        def build_targets(h):
            tgt = np.log(c[h:] / c[:-h])
            return tgt.astype(float), (N - h)

        # ---- WALK-FORWARD EXPANSIF + PURGE+EMBARGO (le garde de fuite que la revue traque) ----
        def fold_spans(neff, h):
            E = max(2, int(math.ceil(0.01 * neff)))
            GAP = h + E
            nf = 4 if neff >= 200 else 3
            core = int(0.55 * neff); rest = neff - core
            out = []
            for k in range(nf):
                te0 = core + (k * rest) // nf
                te1 = core + ((k + 1) * rest) // nf
                tr_end = te0 - GAP                      # (a) gap de frontiere : ces lignes ne sont NI train NI test
                if tr_end <= 0:
                    continue
                tr_idx = np.arange(0, tr_end)
                tr_idx = tr_idx[tr_idx + h < te0]       # (b) purge symetrique du chevauchement de cible
                te_idx = np.arange(te0, te1)
                if len(tr_idx) < 40 or len(te_idx) < 15:
                    continue
                assert tr_idx.max() + h < te_idx.min()  # garde anti-fuite STRUCTURELLE (raise -> cellule 'erreur')
                out.append((tr_idx, te_idx, GAP, nf, E))
            return out

        def positions_net(P, Y, db):
            # P/Y DEJA sous-echantillonnes au pas h (entrees disjointes) -> aucun rendement chevauchant compte plusieurs fois.
            # bande morte db -> 0 (pas de position). cout COST applique sur la variation de position.
            n = len(P); rs = []; turns = []; pos_prev = 0.0
            for i in range(n):
                pr = P[i]
                pos = 0.0 if abs(pr) < db else (1.0 if pr > 0 else -1.0)
                dpos = abs(pos - pos_prev)
                rs.append(pos * Y[i] - COST * dpos)
                turns.append(dpos / 2.0)
                pos_prev = pos
            return np.asarray(rs, dtype=float), np.asarray(turns, dtype=float)

        def per_trade_sharpe(rs):
            # SHARPE PAR TRANSACTION (horizon-neutre, NON annualise) : mu/sd des rendements de positions disjointes.
            if len(rs) == 0:
                return 0.0
            sd = float(np.std(rs))
            return float(np.mean(rs) / sd) if sd > 1e-12 else 0.0

        def eval_cell(model_key, fcols, h):
            mk_fn = MODELS[model_key][1]
            tgt, neff = build_targets(h)
            X = keep[fcols].values.astype(float)[:neff]
            spans = fold_spans(neff, h)
            if not spans:
                return {'status': 'insuffisant', 'note': 'aucun pli exploitable apres purge'}
            oos_p = []; oos_y = []
            tr_acc_list = []; tr_rs_list = []   # metriques TRAIN par-pli, sur le MEME pas h que l'OOS (apples-to-apples)
            GAPv = spans[0][2]; Ev = spans[0][4]; nfv = spans[0][3]
            for (tr, te, GAP, nf, E) in spans:
                est = mk_fn(); est.fit(X[tr], tgt[tr])
                # --- OOS : stride-h DANS le bloc de test (entrees non chevauchantes) ---
                te_s = te[::h]
                p = est.predict(X[te_s]); y = tgt[te_s]
                oos_p.append(np.asarray(p, dtype=float)); oos_y.append(np.asarray(y, dtype=float))
                # --- TRAIN mesure SUR LE MEME STRIDE h + deadband TRAIN-only (par-pli) ---
                tr_s = tr[::h]
                db_tr = 0.2 * float(np.std(tgt[tr])) if len(tr) else 0.0   # seuil derive du TRAIN seul (pas de fuite)
                tp = est.predict(X[tr_s]); ty = tgt[tr_s]
                tp = np.nan_to_num(np.asarray(tp, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
                tr_acc_list.append(float(np.mean(np.sign(tp) == np.sign(ty))) if len(tp) else 0.0)
                tr_rs, _ = positions_net(tp, ty, db_tr)
                tr_rs_list.append(tr_rs)
            P = np.concatenate(oos_p); Y = np.concatenate(oos_y)
            P = np.nan_to_num(P, nan=0.0, posinf=0.0, neginf=0.0)
            # deadband OOS = derive du TRAIN GLOBAL purge (pas du test) -> pas de fuite de volatilite future dans la regle.
            tr_all = spans[-1][0]                       # train le plus large (dernier pli expansif)
            db = 0.2 * float(np.std(tgt[tr_all])) if len(tr_all) else 0.0
            oos_dir_acc = float(np.mean(np.sign(P) == np.sign(Y))) if len(P) else 0.0
            up = float(np.mean(Y > 0)) if len(Y) else 0.5
            base_rate = max(up, 1.0 - up)
            rs, turns = positions_net(P, Y, db)
            n_oos = int(len(rs))
            net = float(np.exp(np.sum(rs)) - 1.0) if n_oos else 0.0
            sharpe = per_trade_sharpe(rs)               # PAR TRANSACTION, horizon-neutre
            winrate = float(np.mean(rs > 0)) if n_oos else 0.0
            turnover = float(np.mean(turns)) if len(turns) else 0.0
            # --- metriques TRAIN agregees (memes domaines que l'OOS) ---
            tr_acc = float(np.mean(tr_acc_list)) if tr_acc_list else 0.0
            tr_rs_all = np.concatenate(tr_rs_list) if tr_rs_list else np.array([])
            tr_net = float(np.exp(np.sum(tr_rs_all)) - 1.0) if len(tr_rs_all) else 0.0
            tr_sharpe = per_trade_sharpe(tr_rs_all)
            # --- ECARTS train/OOS dans LES DEUX domaines ---
            gap_acc = float(tr_acc - oos_dir_acc)                 # ecart de fiabilite directionnelle (pts)
            gap_sharpe = float(tr_sharpe - sharpe)                # ecart de Sharpe (MEME domaine que le score)
            # score robuste : Sharpe OOS PENALISE par l'ecart de Sharpe ET de fiabilite, la rotation, le faible n.
            score = (sharpe
                     - LAMBDA_GAP * max(0.0, gap_sharpe)
                     - LAMBDA_ACC * max(0.0, gap_acc)
                     - LAMBDA_TURN * turnover
                     - (LAMBDA_N if n_oos < N_MIN_OOS else 0.0))
            # significativite APPROXIMATIVE vs base_rate (pas vs 0.5) ; anti-conservatrice (autocorr residuelle).
            signif = bool((oos_dir_acc - base_rate) > 1.96 * math.sqrt(0.25 / max(n_oos, 1)))
            return {'status': 'ok',
                    'oos_net': _fin(net), 'oos_sharpe': _fin(sharpe), 'oos_dir_acc': _fin(oos_dir_acc),
                    'base_rate': _fin(base_rate), 'train_dir_acc': _fin(tr_acc), 'train_net': _fin(tr_net),
                    'train_sharpe': _fin(tr_sharpe),
                    'overfit_gap': _fin(gap_acc), 'gap_sharpe': _fin(gap_sharpe),
                    'winrate': _fin(winrate), 'turnover': _fin(turnover),
                    'n_oos': n_oos, 'score': _fin(score), 'signif': signif,
                    'gap_embargo': 'h+E (E=%d)' % Ev, 'n_folds_used': nfv}

        def baseline_rows(fcols, h):
            tgt, neff = build_targets(h)
            spans = fold_spans(neff, h)
            out = []
            for (name, kind) in (('base_zero', 'zero'), ('base_mom', 'mom')):
                oos_p = []; oos_y = []
                for (tr, te, GAP, nf, E) in spans:
                    te_s = te[::h]; y = tgt[te_s]
                    if kind == 'zero':
                        p = np.zeros(len(te_s))
                    else:
                        m5 = keep['mom5'].values.astype(float)[:neff]
                        p = m5[te_s]                                 # valeur (pas juste le signe) -> deadband applicable
                    oos_p.append(np.asarray(p, dtype=float)); oos_y.append(np.asarray(y, dtype=float))
                if spans:
                    tr_all = spans[-1][0]
                    db = 0.2 * float(np.std(tgt[tr_all])) if len(tr_all) else 0.0
                else:
                    db = 0.0
                if not oos_p:
                    out.append({'model': name, 'featureset': '—', 'horizon': h, 'status': 'baseline',
                                'keep': False, 'is_best': False, 'score': -1e9, 'note': 'insuffisant'})
                    continue
                P = np.concatenate(oos_p); Y = np.concatenate(oos_y)
                # MEME deadband (train-derive) que les candidats -> comparaison equitable de la rotation/cout.
                # (base_zero : pred=0 -> toujours plat ; base_mom : seuil identique aux modeles.)
                if kind == 'zero':
                    dbe = 1e18    # force le plat (predit 0 partout)
                else:
                    dbe = db
                rs, turns = positions_net(P, Y, dbe)
                n_oos = int(len(rs))
                net = float(np.exp(np.sum(rs)) - 1.0) if n_oos else 0.0
                sharpe = per_trade_sharpe(rs)
                turnover = float(np.mean(turns)) if len(turns) else 0.0
                dir_acc = float(np.mean(np.sign(P) == np.sign(Y))) if n_oos else 0.0
                score = sharpe - LAMBDA_TURN * turnover - (LAMBDA_N if n_oos < N_MIN_OOS else 0.0)
                out.append({'model': name, 'featureset': '—', 'horizon': h, 'status': 'baseline',
                            'oos_net': _fin(net), 'oos_sharpe': _fin(sharpe), 'oos_dir_acc': _fin(dir_acc),
                            'overfit_gap': None, 'gap_sharpe': None, 'winrate': None, 'turnover': _fin(turnover),
                            'n_oos': n_oos, 'score': _fin(score), 'signif': False, 'keep': False, 'is_best': False})
            return out

        # ---- PLAN explicite, journalise, plafonne a MAX_CELLS ----
        PLAN = []
        for m in ('ridge1', 'ridge10', 'tree', 'knn'):
            for cell in [('ALL', 1), ('ALL', 5), ('ALL', 20), ('MICRO', 5), ('TREND', 5)]:
                PLAN.append((m,) + cell)
        for m in ('forest', 'gbm'):
            for cell in [('ALL', 5), ('TREND', 5), ('ALL', 20)]:
                PLAN.append((m,) + cell)
        for cell in [('ALL', 5), ('TREND', 5)]:
            PLAN.append(('mlp',) + cell)
        MAX_CELLS = 26
        if len(PLAN) > MAX_CELLS:
            cut = [t for t in PLAN if t[0] == 'ridge10' and t[1] in ('MICRO', 'TREND')][:len(PLAN) - MAX_CELLS]
            for t in cut:
                PLAN.remove(t); print('[cap] cellule retiree (>%d):' % MAX_CELLS, t)

        rows = []; cells_cut = []; done = 0; seen_fsh = set()
        for (mk, fsk, h) in PLAN:
            if (fsk, h) not in seen_fsh:                       # 2 baselines par (jeu,h) distinct
                seen_fsh.add((fsk, h)); rows += baseline_rows(FS[fsk], h)
            # GARDE BUDGET pour TOUTES les classes (light comprises) : si on a depasse le budget mou, on ne lance plus de fit.
            if (time.time() - t_start) > SOFT_BUDGET:
                rows.append({'model': mk, 'featureset': fsk, 'horizon': h, 'status': 'budget',
                             'keep': False, 'is_best': False, 'score': -1e9, 'note': '>%.0fs' % SOFT_BUDGET})
                cells_cut.append('%s/%s/%d (budget)' % (mk, fsk, h))
                print('[budget] cellule retiree (>%.0fs):' % SOFT_BUDGET, mk, fsk, h); continue
            try:
                r = eval_cell(mk, FS[fsk], h)
                r['model'] = mk; r['featureset'] = fsk; r['horizon'] = h
                r.setdefault('status', 'ok'); r.setdefault('keep', False); r.setdefault('is_best', False)
            except Exception as e:
                r = {'model': mk, 'featureset': fsk, 'horizon': h, 'status': 'erreur',
                     'keep': False, 'is_best': False, 'score': -1e9, 'note': str(e)[:120]}
                print('[erreur]', mk, fsk, h, str(e)[:80])
            rows.append(r); done += 1
            _net = r.get('oos_net'); _gap = r.get('overfit_gap')
            print('[%d/%d] %s/%s h=%d | net %s | gap %s | n_oos %s' % (
                done, len(PLAN), mk, fsk, h,
                ('%.2f%%' % (_net * 100)) if _net is not None else '-',
                ('%.1fpts' % (_gap * 100)) if _gap is not None else '-',
                r.get('n_oos', '-')))

        elapsed_grid = time.time() - t_start

        # ---- garde-base : base_score = MEILLEURE base de reference SYNTHETIQUE (zero/mom), AUCUN modele appris dedans ----
        base_rows = [r for r in rows if r.get('status') == 'baseline' and isinstance(r.get('score'), (int, float))]
        base_score = max([_fin(r.get('score', -1e9), -1e9) for r in base_rows], default=-1e9)
        base_valid = bool(base_rows) and base_score > -1e8     # une base exploitable existe-t-elle ?
        # ---- selection (score robuste OOS, net de frais, penalise) ----
        for r in rows:
            if r.get('status') != 'ok':
                r.setdefault('keep', False); continue
            r['keep'] = bool(base_valid
                             and r['score'] > base_score + BASE_MARGIN   # bat la base AVEC marge
                             and r['oos_net'] > 0
                             and r['n_oos'] >= N_MIN_OOS
                             and r['oos_dir_acc'] > r['base_rate']
                             and r['overfit_gap'] < GAP_MAX)
        ok = [r for r in rows if r.get('status') == 'ok']
        kept = [r for r in ok if r.get('keep')]
        rows.sort(key=lambda r: _fin(r.get('score', -1e9), -1e9), reverse=True)
        if kept:
            best = sorted(kept, key=lambda r: r['score'])[-1]
        elif ok:
            best = sorted(ok, key=lambda r: r['score'])[-1]
        else:
            best = None
        for r in rows:
            r['is_best'] = bool(best is not None and r is best)

        # ---- Phase B : balayage d'horizon sur le couple gagnant (meme protocole purge) ----
        sweep_rows = []; HSW = [1, 3, 5, 10, 20, 50]; best_h = (best.get('horizon', 5) if best else 5)
        best_h_sure = False
        all_neg = True; sw_model = (best.get('model') if best else None); sw_fs = (best.get('featureset') if best else None)
        if best is not None and best.get('model') in MODELS:
            mk = best['model']; fsk = best['featureset']
            if MODELS[mk][0] == 'mlp':
                HSW = [1, 5, 20]; print('[sweep] MLP -> horizons reduits', HSW)
            for h in HSW:
                if (time.time() - t_start) > SOFT_BUDGET + 6.0:    # garde budget AUSSI sur le sweep
                    print('[sweep budget] h=%d ignore (>%.0fs)' % (h, SOFT_BUDGET + 6.0)); continue
                _, neff = build_targets(h)
                E = max(2, int(math.ceil(0.01 * neff))); GAP = h + E
                if neff < 4 * (40 + 15 + GAP):
                    print('[sweep] h=%d ignore (echantillon trop court)' % h); continue
                try:
                    sr = eval_cell(mk, FS[fsk], h)
                    if sr.get('status') != 'ok':
                        print('[sweep] h=%d ignore (%s)' % (h, sr.get('status'))); continue
                    sr['h'] = h; sweep_rows.append(sr)
                except Exception as e:
                    print('[sweep erreur] h=%d %s' % (h, str(e)[:60]))
            for sr in sweep_rows:
                sr['faible_n'] = bool(sr.get('n_oos', 0) < 40)
            cand = [sr for sr in sweep_rows if not sr['faible_n']]
            if cand:
                best_h = sorted(cand, key=lambda s: (s['score'], -s['h']))[-1]['h']   # score robuste ; egalite -> h plus court
                best_h_sure = True
            elif sweep_rows:
                # tous les h sont faible_n : on choisit quand meme mais on marque l'horizon comme INDETERMINE.
                best_h = sorted(sweep_rows, key=lambda s: (s['score'], -s['h']))[-1]['h']
                best_h_sure = False
            for sr in sweep_rows:
                sr['is_best'] = bool(sr['h'] == best_h)
            all_neg = all(sr.get('oos_net', 0.0) <= 0 for sr in sweep_rows) if sweep_rows else True

        sweep_disp = [{'h': sr['h'], 'oos_net': sr['oos_net'], 'oos_sharpe': sr['oos_sharpe'],
                       'dir_acc': sr['oos_dir_acc'], 'turnover': sr['turnover'], 'n_oos': sr['n_oos'],
                       'score': sr['score'], 'signif': sr['signif'], 'faible_n': sr['faible_n'],
                       'is_best': sr['is_best']} for sr in sweep_rows]
        best_sr = next((sr for sr in sweep_rows if sr['h'] == best_h), None)
        if all_neg or not sweep_rows:
            phrase = "Aucun horizon n'est rentable net de frais sur l'echantillon courant ; cela reste coherent avec un marche quasi-efficient."
        elif not best_h_sure:
            phrase = ("Indication d'horizon FRAGILE : tous les horizons testes ont trop peu de transactions hors echantillon "
                      "(n_oos<40). L'horizon ~%d ressort, mais sans fiabilite statistique." % best_h)
        else:
            bn = (best_sr['oos_net'] * 100) if best_sr else 0.0
            bs = (best_sr['oos_sharpe']) if best_sr else 0.0
            phrase = ("Sur ce marche, l'horizon le plus rentable apres frais est ~%d barres "
                      "(net OOS %+.2f %%, Sharpe/transac %.2f) — avantage faible, coherent avec un marche quasi-efficient." % (best_h, bn, bs))

        # ---- recommandation (face a la Stage 2) : refit sur tout l'echantillon valide, predire la derniere ligne CLOSE.
        # keep est deja sans bougie en formation (features.py fait d.iloc[:-1]) -> Xf[-1] est la derniere bougie CLOTUREE.
        # Pas de purge ici : une seule prediction VERS L'AVANT, il n'y a pas de test a proteger.
        # TAILLE = pilotee par l'EDGE OOS mesure (oos_dir_acc-0.5), PAS par l'amplitude d'une prediction in-sample (anti-optimisme).
        rec = {'sens': 0, 'taille_hint': 0.0, 'horizon': int(best_h),
               'confiance': 'tres faible', 'tradeable': False,
               'why': "Aucun avantage net detecte -> rester PLAT.",
               'model': sw_model, 'featureset': sw_fs}
        if best is not None and best.get('model') in MODELS:
            try:
                mk = best['model']; fsk = best['featureset']; h = int(best_h)
                tgt, neff = build_targets(h)
                Xf = keep[FS.get(fsk, ALL)].values.astype(float)
                est = MODELS[mk][1](); est.fit(Xf[:neff], tgt)
                pred_last = float(est.predict(Xf[-1:])[0])
                db = 0.2 * float(np.std(tgt[:neff])) if neff else 0.0
                sens = 1 if pred_last > db else (-1 if pred_last < -db else 0)
                gapb = _fin(best.get('overfit_gap', 0.0))
                keptbest = bool(best.get('keep')); signbest = bool(best.get('signif'))
                netbest = _fin(best.get('oos_net', 0.0)); accbest = _fin(best.get('oos_dir_acc', 0.5))
                # TAILLE heuristique : pilotee par l'avantage directionnel OOS (borne), penalisee par l'ecart train/OOS.
                edge = max(0.0, (accbest - 0.5) / 0.15)                  # 0 a 0.5 -> 0 ; +15 pts -> ~1
                size = max(0.0, min(1.0, edge * max(0.0, 1.0 - gapb / GAP_MAX)))
                tradeable = bool(keptbest and signbest and netbest > 0 and gapb < GAP_MAX and sens != 0)
                conf = 'faible' if (keptbest and signbest) else 'tres faible'
                if not keptbest:
                    why = ("Aucun candidat ne bat la base de reference (avec marge) apres frais avec un ecart train/OOS maitrise "
                           "-> rester PLAT. L'avantage attendu est ~0 sur ce marche quasi-efficient.")
                    sens = 0; size = 0.0; conf = 'tres faible'; tradeable = False
                else:
                    why = ("%s sur le jeu %s a h=%d : net OOS %+.2f %%, ecart fiabilite train/OOS %.1f pts, fiabilite %.1f %% "
                           "(base %.1f %%), n_oos %d, %s. Taille pilotee par l'avantage OOS (pas par une prediction in-sample). "
                           "Avantage faible%s." % (
                               MODEL_FR.get(mk, mk), fsk, h, netbest * 100, gapb * 100,
                               accbest * 100, _fin(best.get('base_rate')) * 100,
                               int(best.get('n_oos', 0)), 'significatif' if signbest else 'non significatif',
                               '' if tradeable else ", non exploitable en l'etat"))
                rec = {'sens': int(sens), 'taille_hint': _fin(size), 'horizon': int(best_h),
                       'confiance': conf, 'tradeable': tradeable, 'why': why,
                       'model': mk, 'featureset': fsk}
            except Exception as e:
                print('[reco erreur]', str(e)[:80])

        # ---- JOURNAL FR structure, accumule ----
        # n_folds reels : deduits d'un span representatif (h=5) ou du best -> evite d'afficher 4 a tort sur petit echantillon.
        try:
            _t5, _neff5 = build_targets(5)
            n_folds_eff = (best.get('n_folds_used') if best else None) or (len(fold_spans(_neff5, 5)) or 4)
        except Exception:
            n_folds_eff = 4
        entries = []
        entries.append({'type': 'ouverture', 'titre': 'Passe #%d' % PASS, 'hypothese': '',
                        'test': '%d bougies, %d cellules evaluees, walk-forward %d plis, purge>=h+embargo, Sharpe par transaction.' % (N, done, n_folds_eff),
                        'resultat': '%d candidat(s) garde(s) (base de reference %s).' % (len(kept), 'valide' if base_valid else 'INDISPONIBLE'),
                        'decision': 'INFO', 'pourquoi': ('' if base_valid else "Aucune base exploitable -> garde forcee a vide (la garantie « bat la base » ne peut etre verifiee).")})

        # entree d'honnetete : cellules coupees (budget/cap) listees DANS le journal (pas seulement la console).
        if cells_cut:
            entries.append({'type': 'coupe', 'titre': 'Cellules non evaluees', 'hypothese': '',
                            'test': 'Budget mou %.0fs / plafond %d cellules.' % (SOFT_BUDGET, MAX_CELLS),
                            'resultat': ', '.join(cells_cut[:12]) + (' …' if len(cells_cut) > 12 else ''),
                            'decision': 'INFO',
                            'pourquoi': "Coupe pour tenir le budget de calcul ; ces cellules ne comptent pas dans la selection (signalees, jamais silencieuses)."})

        def fr_cell(r):
            mk = r['model']; fsk = r.get('featureset', '—'); h = r.get('horizon')
            titre = '%s · %s · h=%d' % (mk, fsk, h)
            if mk == 'mlp':
                hyp = 'Le reseau de neurones regularise bat-il le lineaire hors echantillon ?'
            elif mk == 'knn':
                hyp = "L'appariement d'analogues (facon echiquier) capte-t-il une tendance ?"
            elif mk in ('forest', 'gbm', 'tree'):
                hyp = 'Un modele a arbres peu profond capte-t-il une structure non lineaire a h=%d ?' % h
            else:
                hyp = 'Le lineaire regularise evite-t-il de se degrader hors echantillon ?'
            test = '%d plis expansifs, purge %s, frais %.4f/rotation, Sharpe/transac.' % (n_folds_eff, r.get('gap_embargo', 'h+E'), COST)
            res = ('OOS net %+.2f %% (train fiab %.1f %%, OOS %.1f %%, ecart %+.1f pts ; ecart Sharpe %+.2f), Sharpe/transac %.2f, rotation %.2f, n_oos %d, significatif=%s.' % (
                _fin(r.get('oos_net')) * 100, _fin(r.get('train_dir_acc')) * 100, _fin(r.get('oos_dir_acc')) * 100,
                _fin(r.get('overfit_gap')) * 100, _fin(r.get('gap_sharpe')), _fin(r.get('oos_sharpe')), _fin(r.get('turnover')),
                int(r.get('n_oos', 0)), 'oui' if r.get('signif') else 'non'))
            if r.get('keep'):
                decision = 'GARDÉ'
                pourquoi = ("Bat la base de reference avec marge, ne se degrade quasiment pas hors echantillon "
                            "(ecart directionnel < %.0f pts) et reste net positif apres frais ; mais l'avantage est minuscule"
                            % (GAP_MAX * 100)) + ('' if r.get('signif') else ' et non significatif') + '.'
            else:
                decision = 'REJETÉ'
                if mk == 'mlp':
                    pourquoi = ("Marche quasi-efficient : le reseau de neurones memorise le bruit (fort en train, faible OOS) ; "
                                "c'est le role du controle de surapprentissage de le rejeter.")
                elif mk == 'knn':
                    pourquoi = ("Appariement d'analogues facon echiquier : retrouve les etats passes les plus proches et moyenne ce qui a "
                                "suivi ; marche stochastique/non-stationnaire => tendance statistique faible, pas une continuation garantie "
                                "(les arbres en font deja une version douce).")
                elif _fin(r.get('overfit_gap')) >= GAP_MAX:
                    pourquoi = "L'ecart de fiabilite train/OOS (%.1f pts) trahit du surapprentissage." % (_fin(r.get('overfit_gap')) * 100)
                elif _fin(r.get('oos_net')) <= 0:
                    pourquoi = "Le rendement est negatif apres frais (%.4f/rotation)." % COST
                else:
                    pourquoi = "Ne bat pas la base de reference de facon nette et fiable (marge insuffisante)."
            return {'type': 'cellule', 'titre': titre, 'hypothese': hyp, 'test': test,
                    'resultat': res, 'decision': decision, 'pourquoi': pourquoi}

        # cellules decisives : tous les gardes en premier, puis 1 representant par modele (MLP/kNN toujours inclus pour la pedagogie), cap 8.
        decisive = [r for r in rows if r.get('status') == 'ok']
        decisive = sorted(decisive, key=lambda r: (0 if r.get('keep') else 1, -_fin(r.get('score', -1e9))))
        seen_mk = set(); chosen = []
        for r in decisive:
            if r.get('keep') or r['model'] in ('mlp', 'knn') or r['model'] not in seen_mk:
                chosen.append(r); seen_mk.add(r['model'])
            if len(chosen) >= 8:
                break
        for r in chosen:
            entries.append(fr_cell(r))

        sweep_res = ('h=%d (meilleur score net-Sharpe penalise).' % best_h) if (sweep_rows and not all_neg and best_h_sure) \\
            else ('h=%d mais FRAGILE (trop peu de transactions OOS).' % best_h if (sweep_rows and not all_neg) else 'aucun horizon rentable net de frais.')
        entries.append({'type': 'sweep', 'titre': 'Terme le plus rentable',
                        'hypothese': 'Quel horizon maximise le rendement net penalise ?',
                        'test': 'Balayage {%s} du couple gagnant, meme protocole purge, Sharpe par transaction (horizon-neutre).' % ','.join(str(x) for x in HSW),
                        'resultat': sweep_res,
                        'decision': 'INFO',
                        'pourquoi': "On classe par score robuste (Sharpe par transaction penalise), horizon-neutre : pas d'annualisation sqrt(252/h) qui fausserait la comparaison entre horizons."})

        sens_fr = {1: 'LONG', -1: 'SHORT', 0: 'NEUTRE'}[rec['sens']]
        entries.append({'type': 'reco', 'titre': 'Recommandation Stage 2', 'hypothese': '', 'test': '',
                        'resultat': 'Sens %s, horizon %d, confiance %s, taille %.2f.' % (sens_fr, rec['horizon'], rec['confiance'], rec['taille_hint']),
                        'decision': 'INFO', 'pourquoi': rec['why']})

        new_pass = {'pass_id': PASS, 'ts': int(time.time() * 1000), 'n_keep': N,
                    'n_folds': n_folds_eff, 'n_cells': len(rows), 'entries': entries}
        journal = (PRIOR_JOURNAL + [new_pass])[-40:]    # accumulation : on garde les 40 dernieres passes

        out = {'kind': 'auto', 'ts': int(time.time() * 1000), 'pass_count': PASS,
               'skl_version': sklearn.__version__, 'gbm_impl': GBM_IMPL,
               'n_keep': int(N), 'n_folds': int(n_folds_eff), 'cost': COST,
               'gap_embargo': (best.get('gap_embargo') if best else 'h+E'),
               'sharpe_kind': 'par transaction (non annualise)',
               'h_main': H_MAIN, 'h_sweep': HSW,
               'max_cells': MAX_CELLS, 'cells_planned': len(PLAN), 'cells_run': done, 'cells_cut': cells_cut,
               'elapsed_s': round(time.time() - t_start, 1), 'elapsed_grid_s': round(elapsed_grid, 1),
               'base_valid': base_valid, 'base_score': (_fin(base_score, -1e9) if base_valid else None),
               'leaderboard': rows,
               'horizon_sweep': {'model': sw_model, 'featureset': sw_fs, 'rows': sweep_disp,
                                 'best_h': int(best_h), 'best_h_sure': bool(best_h_sure),
                                 'phrase': phrase, 'all_negative': bool(all_neg)},
               'recommendation': rec, 'journal': journal, 'note': NOTE, 'error': None}
        __ai_json = _dumps(out)
        print('== termine : best %s, h %s, tradeable %s (passe #%d, %d cellules, %.1fs) ==' % (
            (best.get('model') if best else 'aucun'), best_h, rec['tradeable'], PASS, done, time.time() - t_start))

except Exception as _e:
    try:
        emit_error('echec auto.py: ' + str(_e))
    except Exception:
        __ai_json = json.dumps({'kind': 'auto', 'error': 'echec', 'note': NOTE, 'journal': PRIOR_JOURNAL, 'pass_count': PASS})

__model_out = None  # DERNIERE ligne, inconditionnelle : ne JAMAIS persister de bundle modele (contourne le garde 1.5 Mo ; l'etat va dans localStorage 'tradlab_auto' via __ai_json, ecrit par le JS).`;

  var SHIPPED = { "ia.py": AI_PY, "features.py": FEATURES_PY, "agent.py": AGENT_PY, "nlp.py": NLP_PY, "phase3.py": PHASE3_PY, "cerveau.py": CERVEAU_PY, "auto.py": AUTO_PY };
  function applyShipped(fsObj) {
    var prev = {}; try { prev = JSON.parse(localStorage.getItem("tradlab_ship") || "{}"); } catch (e) {}
    for (var f in SHIPPED) { if (fsObj[f] == null || fsObj[f] === prev[f]) fsObj[f] = SHIPPED[f]; }
    try { localStorage.setItem("tradlab_ship", JSON.stringify(SHIPPED)); } catch (e) {}
  }

  /* =================== ESPACE DE TRAVAIL (FS virtuel) =================== */
  var fs = null, activeFile = null, forecastEntry = "ia.py";
  var cm = null, ta = null;
  function loadFS() {
    try { var o = JSON.parse(localStorage.getItem(FSKEY)); if (o && typeof o === "object" && Object.keys(o).length) return o; } catch (e) {}
    var old = null; try { old = localStorage.getItem("tradlab_ai_code_v3"); } catch (e) {}
    return { "ia.py": (old && old.trim()) ? old : AI_PY };
  }
  function saveFS() { try { localStorage.setItem(FSKEY, JSON.stringify(fs)); } catch (e) {} }
  function fileList() { return Object.keys(fs).sort(function (a, b) { if (a === "ia.py") return -1; if (b === "ia.py") return 1; return a.localeCompare(b); }); }

  /* =================== MÉMOIRE de l'IA =================== */
  function loadHist() { try { var a = JSON.parse(localStorage.getItem(HKEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveHist(a) { try { localStorage.setItem(HKEY, JSON.stringify(a.slice(-300))); } catch (e) {} }
  function logActivation(o) { var h = loadHist(); h.push({ t: Date.now(), up: !!o.up, acc: o.dir_acc, r2: o.r2 }); saveHist(h); return h; }
  function histSummary() { var h = loadHist(); if (!h.length) return null; var avg = h.reduce(function (a, x) { return a + (x.acc || 0); }, 0) / h.length; return { n: h.length, avg: avg }; }

  function drawForecast(o, t0) {
    if (!window.TradSim) return;
    if (o.kind === "rl") {
      window.TradSim.clearForecast();
      window.TradSim.setOverlay({ line: o.line || null, markers: o.markers || null });
      return;
    }
    if (o.kind === "nlp") { window.TradSim.clearForecast(); window.TradSim.clearOverlay(); return; }
    if (o.replay) window.TradSim.setOverlay({ line: o.replay });
    if (o.center) window.TradSim.setForecast({ center: o.center, bandLow: o.bandLow, bandHigh: o.bandHigh, t0: t0, anchor: o.last_c });
  }

  /* =================== IDE =================== */
  var host = null;
  var SHIPKEY = "tradlab_ia_shipped";
  function open() {
    if (host) close();
    fs = loadFS();
    applyShipped(fs); saveFS();
    activeFile = "ia.py";
    host = document.createElement("div"); host.id = "lab-panel"; document.body.appendChild(host);
    render();
  }
  function close() { clearMindTimer(); if (host && host.parentNode) host.parentNode.removeChild(host); host = null; }

  function render() {
    host.innerHTML =
      '<div class="lab-head">' +
        '<div class="lab-brand"><span class="lab-glyph"></span>Octopus 0.1 · Python</div>' +
        '<div class="lab-title">Environnement d\'Octopus 0.1</div>' +
        '<div class="lab-spacer"></div>' +
        '<button class="lab-run" id="ai-run">▶ Exécuter</button>' +
        '<button class="lab-ic" id="ai-quit" title="Retour au terminal">✕ Terminal</button>' +
      '</div>' +
      '<div class="lab-ide">' +
        '<div class="lab-explorer">' +
          '<div class="lab-exp-head"><span>Explorateur</span><span class="lab-spacer"></span>' +
            '<button class="lab-exp-btn" id="fs-new" title="Nouveau fichier">+</button></div>' +
          '<div class="lab-exp-list" id="fs-list"></div>' +
        '</div>' +
        '<div class="lab-main">' +
          '<div class="lab-tabbar" id="lab-tabbar"></div>' +
          '<div class="lab-edit-pane" id="lab-edit-pane"></div>' +
          '<div class="lab-term-pane">' +
            '<div class="lab-term-head"><span class="ltt">TERMINAL</span><span class="lab-stat" id="lab-status"></span><span class="lab-spacer"></span><button class="lab-ic" id="lab-clear">Effacer</button></div>' +
            '<div class="lab-out" id="lab-out"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.getElementById("ai-run").addEventListener("click", runActive);
    document.getElementById("ai-quit").addEventListener("click", function () { saveActive(); close(); });
    document.getElementById("lab-clear").addEventListener("click", clearLog);
    document.getElementById("fs-new").addEventListener("click", newFile);
    initEditor();
    renderExplorer();
    var hs = histSummary();
    if (hs) appendLog("mémoire IA : " + hs.n + " analyses · fiabilité moyenne " + (Math.round(hs.avg * 1000) / 10) + " %\n\n");
    else appendLog("Prêt. Édite ia.py puis « Exécuter ».\n\n");
  }

  function renderExplorer() {
    var list = document.getElementById("fs-list"); if (!list) return;
    list.innerHTML = fileList().map(function (n) {
      return '<div class="lab-file' + (n === activeFile ? " active" : "") + '" data-f="' + esc(n) + '">' +
        '<span class="fdot"></span><span class="fname">' + esc(n) + '</span>' +
        (n === "ia.py" ? "" : '<span class="fdel" data-del="' + esc(n) + '" title="Supprimer">✕</span>') +
        '</div>';
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll(".lab-file"), function (el) {
      el.addEventListener("click", function (e) {
        var del = e.target.getAttribute("data-del");
        if (del) { e.stopPropagation(); deleteFile(del); return; }
        saveActive(); openFile(el.getAttribute("data-f"));
      });
    });
    renderTabs();
  }
  function renderTabs() {
    var tb = document.getElementById("lab-tabbar"); if (!tb) return;
    tb.innerHTML = '<span class="lab-tab active">' + esc(activeFile) + '</span>';
  }


  function initEditor() {
    var pane = document.getElementById("lab-edit-pane"); if (!pane) return;
    cm = null; ta = null;
    if (typeof CodeMirror !== "undefined") {
      cm = CodeMirror(pane, {
        value: (fs[activeFile] != null ? fs[activeFile] : ""),
        mode: "python", lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
        matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true,
        extraKeys: { "Ctrl-Enter": runActive, "Cmd-Enter": runActive, Tab: function (c) { c.replaceSelection("    "); } }
      });
      cm.on("change", saveActive);
      setTimeout(function () { if (cm) cm.refresh(); }, 0);
    } else {
      pane.innerHTML = '<textarea id="lab-editor" spellcheck="false" style="width:100%;height:100%;border:none;outline:none;resize:none;padding:14px;background:#1e1e1e;color:#d4d4d4;font-family:ui-monospace,Consolas,monospace;font-size:13.5px;line-height:1.55;"></textarea>';
      ta = document.getElementById("lab-editor"); ta.value = (fs[activeFile] != null ? fs[activeFile] : "");
      ta.addEventListener("input", saveActive);
      ta.addEventListener("keydown", function (e) { if (e.key === "Tab") { e.preventDefault(); var s = ta.selectionStart, en = ta.selectionEnd; ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(en); ta.selectionStart = ta.selectionEnd = s + 4; saveActive(); } if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runActive(); } });
    }
  }
  function edGet() { return cm ? cm.getValue() : (ta ? ta.value : ""); }
  function edSet(v) { if (cm) cm.setValue(v || ""); else if (ta) ta.value = (v || ""); }

  function openFile(name) {
    if (!fs[name]) name = fileList()[0];
    activeFile = name;
    edSet(fs[name] != null ? fs[name] : "");
    renderExplorer();
  }
  function saveActive() { if (activeFile != null) { fs[activeFile] = edGet(); saveFS(); } }
  function newFile() {
    var name = window.prompt("Nom du fichier (ex. strategie.py) :", "nouveau.py"); if (name == null) return;
    name = name.trim(); if (!name) return; if (!/\./.test(name)) name += ".py";
    if (fs[name] != null) { openFile(name); return; }
    fs[name] = "# " + name + "\n"; saveFS(); saveActive(); openFile(name);
  }
  function deleteFile(name) {
    if (name === "ia.py") return;
    if (!window.confirm("Supprimer " + name + " ?")) return;
    delete fs[name]; saveFS();
    if (activeFile === name) activeFile = "ia.py";
    openFile(activeFile);
  }

  function status(m) { var s = document.getElementById("lab-status"); if (s) s.textContent = m || ""; }
  function busy(on) { var b = document.getElementById("ai-run"); if (b) { b.disabled = on; b.textContent = on ? "… en cours" : "▶ Exécuter"; } }
  function appendLog(text) { var o = document.getElementById("lab-out"); if (!o) return; o.appendChild(document.createTextNode(text)); o.scrollTop = o.scrollHeight; }
  function clearLog() { var o = document.getElementById("lab-out"); if (o) o.textContent = ""; }


  function computeForecast(entryName, onLog, paste, live) {
    var snap = (window.TradSim && window.TradSim.marketData) ? window.TradSim.marketData(600) : [];

    var t0 = live ? (snap.length ? snap[snap.length - 1].t : null)
                  : ((snap.length >= 2) ? snap[snap.length - 2].t : (snap.length ? snap[snap.length - 1].t : null));
    var entry = (fs && fs[entryName] != null) ? fs[entryName] : "";
    var modelLine = "__model_in = " + JSON.stringify(loadModel()) + "\n"
                  + "__rl_in = " + JSON.stringify(loadRL()) + "\n"
                  + "__text_in = " + JSON.stringify(loadTX()) + "\n"
                  + "__auto_in = " + JSON.stringify(loadAuto()) + "\n"
                  + "__live = " + (live ? "True" : "False") + "\n";
    if (paste != null && paste !== "") {
      modelLine += "__paste_text = _b64.b64decode('" + btoa(unescape(encodeURIComponent(String(paste)))) + "').decode('utf-8')\n";
    }
    var code = preludeFor(snap) + modelLine + "\n" + entry;
    var files = {}; for (var k in fs) files[k] = fs[k];
    if (workerReady) {
      return workerRun(code, files, onLog).then(function (m) { var o = null; if (m.ok && m.json) { try { o = JSON.parse(m.json); } catch (e) {} } if (m.ok && m.model && OCTOPUS_LEARN) saveModelByKind(o, m.model); if (o && o.kind === "auto" && m.json) saveAuto(m.json); return { o: o, t0: t0, err: m.ok ? null : (m.error || "erreur") }; });
    }
    return ensurePy().then(function () { return getRunner().ensurePackages(pkgsFor(code)); })
      .then(function () {
        try { var py = getRunner().pyodide; py.runPython("import os,sys\nos.makedirs('/work',exist_ok=True)\n(None if '/work' in sys.path else sys.path.insert(0,'/work'))"); for (var nm in files) { py.FS.writeFile("/work/" + nm, files[nm]); try { py.runPython("import sys; sys.modules.pop('" + nm.replace(/\.py$/, "") + "', None)"); } catch (e) {} } } catch (e) {}
        return getRunner().run(code);
      })
      .then(function (res) { var o = null, rawJson = null; if (!res.error) { var raw = res.getVar && res.getVar("__ai_json"); rawJson = (raw == null ? null : String(raw)); try { o = JSON.parse(rawJson); } catch (e) {} var mraw = res.getVar && res.getVar("__model_out"); if (mraw && OCTOPUS_LEARN) { try { saveModelByKind(o, String(mraw)); } catch (e) {} } if (o && o.kind === "auto" && rawJson) saveAuto(rawJson); } if (res.stdout && onLog) onLog(res.stdout); var err = res.error || null; if (res.cleanup) res.cleanup(); return { o: o, t0: t0, err: err }; });
  }

  function runActive() {
    if (!host || !activeFile) return;
    saveActive(); busy(true); clearLog();
    var entry = activeFile;
    ensureWorker(function (s) { status(s); appendLog(s + "\n"); })
      .then(function () { status(""); return computeForecast(entry, function (t) { appendLog(t); }); })
      .then(function (r) {
        busy(false); status("");
        if (r.err) { appendLog("\n✗ " + r.err + "\n"); return; }
        var o = r.o;
        if (o && o.kind === "mind") {
          showMind(o); appendLog("\n✓ radiographie prête — ferme ✕ Terminal pour la voir.\n");
        } else if (o && o.kind === "exp") {
          showExpReadout(o); appendLog("\n✓ expérience terminée (tableau ci-dessus + carte).\n");
        } else if (o && o.kind === "nlp") {
          showNlpReadout(o); appendLog("\n✓ sentiment calculé.\n");
        } else if (o && o.kind === "auto") {
          showAuto(o); appendLog("\n✓ optimisation terminée — ferme ✕ Terminal pour voir le banc.\n");
        } else if (o && (o.center || o.kind === "rl")) {
          forecastEntry = entry; drawForecast(o, r.t0); logActivation(o); showBanner(o); enableLive();
          appendLog("\n✓ " + (o.kind === "rl" ? "agent évalué" : "prévision tracée") + " — ferme ✕ Terminal pour voir le graphe\n");
        } else { appendLog("\n✓ exécuté.\n"); }
      })
      .catch(function (e) { busy(false); status(""); appendLog("\n✗ " + (e && e.message ? e.message : e) + "\n"); });
  }

  /* =================== mode LIVE =================== */
  var liveOn = false, liveTimer = null, liveBusy = false, liveLastT = null, liveLastC = null;
  var mindTimer = null, mindBusy = false, mindLastT = null;


  var OCTOPUS_VERSION = "0.1";
  var OCTOPUS_LEARN = false;
  function octopusVersion() { return OCTOPUS_VERSION; }
  function setOctopusVersion(v) {}
  var _lastAuto = null;
  var _lastAutoMid = null;
  var _predDir = 0;

  function autoAccount() { return (window.TradSim && window.TradSim.account) ? window.TradSim.account() : null; }

  function clearMindTimer() { if (mindTimer) { clearInterval(mindTimer); mindTimer = null; } }
  function lastClosedT() { var s = (window.TradSim && window.TradSim.marketData) ? window.TradSim.marketData(3) : []; return (s.length >= 2) ? s[s.length - 2].t : (s.length ? s[s.length - 1].t : null); }
  function liveActive() { var sv = document.getElementById("sim-view"); return liveOn && sv && !sv.classList.contains("hidden") && window.TradSim && window.TradSim.hasForecast(); }
  function enableLive() { liveOn = true; liveLastT = lastClosedT(); liveLastC = null; var lb = document.getElementById("aib-livebtn"); if (lb) lb.classList.add("on"); if (liveTimer) clearInterval(liveTimer); liveTimer = setInterval(liveTick, 300); }
  function disableLive() { liveOn = false; var lb = document.getElementById("aib-livebtn"); if (lb) lb.classList.remove("on"); if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
  function liveTick() {
    if (!liveActive() || liveBusy) return;
    var pc = (window.TradSim && window.TradSim.lastPrice) ? window.TradSim.lastPrice() : null;
    var t = lastClosedT();
    if (pc === liveLastC && t === liveLastT) return;
    liveBusy = true; var lb = document.getElementById("aib-livebtn"); if (lb) lb.classList.add("calc");
    computeForecast(forecastEntry, null, null, true).then(function (r) {
      liveBusy = false; liveLastC = pc; liveLastT = t; if (lb) lb.classList.remove("calc");
      if (liveActive() && r.o && (r.o.center || r.o.kind === "rl")) { drawForecast(r.o, r.t0); logActivation(r.o); updateBanner(r.o); _predDir = r.o.up ? 1 : -1; }
    }).catch(function () { liveBusy = false; if (lb) lb.classList.remove("calc"); });
  }

  /* =================== bandeau de résultat =================== */
  function showBanner(o) {
    var old = document.getElementById("ai-banner"); if (old) old.remove();
    var b = document.createElement("div"); b.id = "ai-banner";
    b.innerHTML =
      '<span class="aib-tag">OCTOPUS ' + OCTOPUS_VERSION + ' · PRÉDICTION</span>' +
      '<span class="aib-stat">SENS <b id="aib-sens"></b></span>' +
      '<span class="aib-stat">AVANTAGE <b id="aib-edge"></b></span>' +
      '<span class="aib-stat">FIABILITÉ <b id="aib-acc"></b></span>' +
      '<span class="aib-stat">VUS <b id="aib-seen"></b></span>' +
      '<span class="aib-stat">R² <b id="aib-r2"></b></span>' +
      '<span class="aib-stat">HORIZON <b id="aib-h"></b></span>' +
      '<span class="aib-sp"></span>' +
      '<button class="lab-ic" id="aib-mind" title="Rayon X : voir ce que l\'IA analyse — indicateurs lus, leur poids/contribution, et ce qu\'elle ignore">Analyse</button>' +
      '<button class="lab-ic aib-live" id="aib-livebtn"><i></i>Live</button>' +
      '<button class="lab-ic" id="aib-code">Code</button>' +
      '<button class="lab-ic" id="aib-clear">Effacer</button>';
    document.body.appendChild(b);
    updateBanner(o);
    _predDir = (o && o.up) ? 1 : -1;
    document.getElementById("aib-livebtn").addEventListener("click", function () { if (liveOn) disableLive(); else enableLive(); });
    document.getElementById("aib-mind").addEventListener("click", function () {
      var btn = this; if (btn.disabled) return; btn.disabled = true; btn.textContent = "…";
      computeForecast("cerveau.py", null, null, false).then(function (r) {
        btn.disabled = false; btn.textContent = "Analyse";
        if (r && r.o && r.o.kind === "mind") showMind(r.o);
        else appendLog("\n✗ analyse indisponible (lance d'abord ia.py).\n");
      }).catch(function () { btn.disabled = false; btn.textContent = "Analyse"; });
    });
    document.getElementById("aib-code").addEventListener("click", function () { disableLive(); b.remove(); open(); });
    document.getElementById("aib-clear").addEventListener("click", function () { disableLive(); if (window.TradSim) { window.TradSim.clearForecast(); window.TradSim.clearOverlay(); } b.remove(); });
  }

  /* =================== carte NLP (sentiment) =================== */
  function showNlpReadout(o) {
    var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
    var r2 = function (v) { return Math.round((v || 0) * 100) / 100; };
    var bar = function (v) {
      var pct = Math.round((Math.max(-1, Math.min(1, v || 0)) + 1) / 2 * 100);
      var col = v > 0.05 ? "#089981" : v < -0.05 ? "#f23645" : "#9aa3ad";
      return '<span class="nlp-bar"><i style="width:' + pct + '%;background:' + col + '"></i><b style="left:50%"></b></span>';
    };
    var old = document.getElementById("ai-nlp"); if (old) old.remove();
    var b = document.createElement("div"); b.id = "ai-nlp";
    var pasteHtml = o.paste ? ('<div class="nlp-row"><span class="nlp-lbl">Texte collé</span>' + bar(o.paste.score) + '<b class="nlp-val">' + r2(o.paste.score) + '</b>'
        + '<span class="nlp-sub">lexique ' + (o.paste.lex != null ? r2(o.paste.lex) : "—") + (o.paste.model != null ? " · modèle " + r2(o.paste.model) : " · modèle (≥30 news)") + '</span></div>') : '';
    b.innerHTML =
      '<div class="nlp-head"><span class="nlp-tag">OCTOPUS 0.1 · SENTIMENT</span><span class="aib-sp"></span><button class="lab-ic" id="nlp-close">Fermer</button></div>' +
      '<div class="nlp-row"><span class="nlp-lbl">Marché (dernière news)</span>' + bar(o.score) + '<b class="nlp-val">' + r2(o.score) + '</b><span class="nlp-sub">' + o.n_news + ' news vues</span></div>' +
      pasteHtml +
      '<div class="nlp-row nlp-sub">Classifieur texte : ' + Math.round((o.text_acc || 0) * 100) + ' % (base ' + Math.round((o.text_base || 0) * 100) + ' %) · ' + o.seen + ' exemples appris à vie</div>' +
      '<div class="nlp-paste"><textarea id="nlp-text" placeholder="Colle un titre ou un extrait de rapport (FR/EN)…"></textarea><button class="lab-run" id="nlp-go">Analyser</button></div>' +
      '<div class="nlp-note">' + esc(o.note) + '</div>';
    document.body.appendChild(b);
    document.getElementById("nlp-close").addEventListener("click", function () { b.remove(); });
    document.getElementById("nlp-go").addEventListener("click", function () {
      var ta = document.getElementById("nlp-text"); var t = ta ? ta.value : ""; if (!t.trim()) { if (ta) ta.focus(); return; }
      var btn = this; btn.disabled = true; btn.textContent = "…";
      computeForecast("nlp.py", null, t).then(function (r) {
        btn.disabled = false; btn.textContent = "Analyser";
        if (r && r.o && r.o.kind === "nlp") { showNlpReadout(r.o); var nt = document.getElementById("nlp-text"); if (nt) nt.value = t; }
        else if (r && r.err) { btn.textContent = "Analyser"; }
      });
    });
  }

  /* =================== carte EXPÉRIENCE Phase 3 =================== */
  function showExpReadout(o) {
    var old = document.getElementById("ai-exp"); if (old) old.remove();
    var b = document.createElement("div"); b.id = "ai-exp";
    if (o.error) {
      b.innerHTML = '<div class="nlp-head"><span class="nlp-tag">PHASE 3</span><span class="aib-sp"></span><button class="lab-ic" id="exp-close">Fermer</button></div><div class="exp-sub">' + esc(o.error) + '</div>';
      document.body.appendChild(b); document.getElementById("exp-close").addEventListener("click", function () { b.remove(); }); return;
    }
    var ms = function (m, s, dec, mul) { mul = mul || 1; dec = (dec == null ? 2 : dec); return (m * mul).toFixed(dec) + '<span class="exp-pm">±' + (s * mul).toFixed(dec) + '</span>'; };
    var best = (o.ranking && o.ranking[0]) || null;
    var rows = (o.table || []).map(function (r) {
      var hl = (r.name === best) ? ' class="exp-best"' : '';
      return '<tr' + hl + '><td class="exp-name">' + esc(r.name) + '</td>'
        + '<td>' + ms(r.net_mean, r.net_std, 2, 100) + '%</td>'
        + '<td>' + ms(r.sharpe_mean, r.sharpe_std, 2) + '</td>'
        + '<td>' + ms(r.win_mean, r.win_std, 1, 100) + '%</td>'
        + '<td>' + ms(r.turn_mean, r.turn_std, 2) + '</td>'
        + '<td>' + ms(r.edge_mean, r.edge_std, 3) + '</td></tr>';
    }).join("");
    b.innerHTML =
      '<div class="nlp-head"><span class="nlp-tag">PHASE 3 · A/B γ × STACKING</span><span class="aib-sp"></span><button class="lab-ic" id="exp-close">Fermer</button></div>'
      + '<div class="exp-sub">' + o.n_steps + ' pas mesurés · ' + o.n_seeds + ' graines · γ=' + o.gamma_on + ' · coût ' + o.cost + ' · rodage ' + o.burn + '</div>'
      + (o.low_n_warning ? '<div class="exp-warn">⚠ fenêtre courte (&lt;120 pas) : écarts-types peu fiables, lecture prudente.</div>' : '')
      + '<table class="exp-tbl"><thead><tr><th>variante</th><th>net&nbsp;%</th><th>Sharpe</th><th>win&nbsp;%</th><th>rotation</th><th>edge</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="exp-bh">B&amp;H (même fenêtre, déterministe) : <b>' + (o.bh_net * 100).toFixed(2) + '&nbsp;%</b></div>'
      + '<div class="exp-rank">classement par Sharpe moyen (descriptif) : ' + esc((o.ranking || []).join("  >  ")) + '</div>'
      + '<div class="nlp-note">' + esc(o.note) + '</div>';
    document.body.appendChild(b);
    document.getElementById("exp-close").addEventListener("click", function () { b.remove(); });
  }


  var mindTab = "sl", mindShowAll = false, mindFollow = false;
  function fmtVal(v, id) {
    if (v == null || !isFinite(v)) return "—";
    var sgn = v >= 0 ? "+" : "";
    switch (id) {
      case "pct2": return (v * 100).toFixed(2) + " %";
      case "pct1": return (v * 100).toFixed(1) + " %";
      case "num0": return String(Math.round(v));
      case "num1": return v.toFixed(1);
      case "num2": return v.toFixed(2);
      case "sgn3": return sgn + v.toFixed(3);
      case "sgn2": return sgn + (v * 100).toFixed(2) + " %";
      case "flow": return sgn + v.toFixed(3);
      case "sent": return v.toFixed(2);
      default: return v.toFixed(2);
    }
  }
  function mindClock(t) {
    if (t == null) return "—";
    var d = new Date(t);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function mindPctCell(c) {
    var v = c * 100;
    var cls = c > 0 ? "up" : c < 0 ? "dn" : "ze";
    var s = (c > 0 ? "+" : c < 0 ? "−" : "") + Math.abs(v).toFixed(3) + " %";
    return '<span class="mind-pc ' + cls + '">' + s + '</span>';
  }

  function mindNumCell(c) {
    var cls = c > 0 ? "up" : c < 0 ? "dn" : "ze";
    var s = (c > 0 ? "+" : c < 0 ? "−" : "") + Math.abs(c).toFixed(4) + " u";
    return '<span class="mind-pc ' + cls + '">' + s + '</span>';
  }


  function renderMindBars(o) {
    var host = document.getElementById("mind-bars"); if (!host) return;
    var capEl = document.getElementById("mind-cap"); var moreEl = document.getElementById("mind-more");
    var biaisEl = document.getElementById("mind-intercept"); var qcapEl = document.getElementById("mind-qcap");
    var legEl = document.getElementById("mind-legend");
    var sl = o.sl || {}, rl = o.rl || {};

    if (legEl) {
      if (mindTab === "rl") {
        legEl.innerHTML = '← penche <b style="color:#f23645">SHORT</b>&nbsp;&nbsp;|&nbsp;&nbsp;penche <b style="color:#089981">LONG</b> →'
          + '<div class="mind-legend2">longueur = importance relative (unités Q), pas un pourcentage de prix</div>';
      } else {
        legEl.innerHTML = '← pousse à la <b style="color:#f23645">BAISSE</b>&nbsp;&nbsp;|&nbsp;&nbsp;pousse à la <b style="color:#089981">HAUSSE</b> →'
          + '<div class="mind-legend2">longueur = importance relative, pas amplitude absolue</div>';
      }
    }

    var trained = mindTab === "sl" ? !!sl.trained : !!rl.trained;
    if (!trained) {
      var reason = mindTab === "sl" ? sl.reason : rl.reason;
      host.innerHTML = '<div class="mind-empty">' + esc(reason || "modèle non entraîné.") + '</div>';
      if (biaisEl) biaisEl.style.display = "none";
      if (qcapEl) qcapEl.style.display = "none";
      if (moreEl) moreEl.style.display = "none";
      if (capEl) capEl.textContent = "";
      return;
    }
    var rows, valKey, cellFn;
    if (mindTab === "sl") {
      rows = sl.contribs.slice(); valKey = "contrib"; cellFn = mindPctCell;
      if (biaisEl) {
        biaisEl.style.display = "";
        biaisEl.querySelector(".mind-rl").innerHTML = "<i>biais (départ)</i>";
        biaisEl.querySelector(".mind-bi-v").textContent = (sl.intercept_pct >= 0 ? "+" : "−") + Math.abs(sl.intercept_pct).toFixed(3) + " %";
      }
      if (qcapEl) qcapEl.style.display = "none";
      if (capEl) capEl.textContent = "ŷ = biais + Σ(barres) — décomposition EXACTE d'un modèle linéaire (aucune approximation type SHAP)."
        + (sl.reconcile === false ? "  ⚠ écart détecté avec le predict du modèle : chiffre verrouillé sur le predict réel." : "");
    } else {
      rows = rl.drivers.slice(); valKey = "push"; cellFn = mindNumCell;

      if (biaisEl) {
        biaisEl.style.display = "";
        biaisEl.querySelector(".mind-rl").innerHTML = "<i>biais agent (long−short)</i>";
        var bp = rl.bias_push || 0;
        biaisEl.querySelector(".mind-bi-v").textContent = (bp >= 0 ? "+" : "−") + Math.abs(bp).toFixed(4) + " u";
      }
      if (qcapEl) {
        qcapEl.style.display = "";
        var Q = rl.Q;
        qcapEl.textContent = "Q court/plat/long = " + Q[0].toFixed(4) + " / " + Q[1].toFixed(4) + " / " + Q[2].toFixed(4)
          + " · marge " + rl.margin.toFixed(4) + " · unités du modèle (pas un %)";
      }
      if (capEl) capEl.textContent = "Σ(barres) + biais agent = Q_long − Q_short — décomposition EXACTE (unités Q, pas un pourcentage de prix)."
        + (rl.reconcile === false ? "  ⚠ écart de réconciliation détecté." : "");
    }
    var visible = mindShowAll ? rows : rows.slice(0, 12);
    var maxAbs = 0;
    visible.forEach(function (r) { var a = Math.abs(r[valKey]); if (a > maxAbs) maxAbs = a; });

    var ignored = {};
    if (mindTab === "sl") (sl.ignored || []).forEach(function (f) { ignored[f] = 1; });
    if (maxAbs < 1e-12) {
      var empty = visible.map(function (r) {
        return '<div class="mind-row"><span class="mind-rl">' + esc(r.label) + '</span>'
          + '<span class="mind-rv"></span><span class="mind-track"></span>' + cellFn(r[valKey]) + '</div>';
      }).join("");
      host.innerHTML = empty + '<div class="mind-empty">modèle quasi à plat ce tic — aucune variable ne pousse fort.</div>';
    } else {
      host.innerHTML = visible.map(function (r) {
        var c = r[valKey];
        var w = Math.max(0, Math.min(50, Math.round(Math.abs(c) / maxAbs * 50)));
        var faint = (mindTab === "sl" && ignored[r.feat]) ? " faint" : "";
        var bar;
        if (c > 0) bar = '<i class="up" style="left:50%;width:' + w + '%"></i>';
        else if (c < 0) bar = '<i class="dn" style="right:50%;width:' + w + '%"></i>';
        else bar = '';
        var rawCell = "", title = "";
        if (mindTab === "sl") {
          rawCell = (r.raw >= 0 ? "+" : "") + r.raw.toFixed(3);
          title = "contribution = poids × valeur normalisée = " + r.coef.toFixed(4) + " × " + r.z.toFixed(3);
        } else {
          title = "contribution à Q_long − Q_short (unités du modèle)";
        }
        return '<div class="mind-row' + faint + '" title="' + esc(title) + '">'
          + '<span class="mind-rl">' + esc(r.label) + '</span>'
          + '<span class="mind-rv">' + esc(rawCell) + '</span>'
          + '<span class="mind-track">' + bar + '</span>'
          + cellFn(c) + '</div>';
      }).join("");
    }
    if (moreEl) { moreEl.style.display = (rows.length > 12 ? "" : "none"); moreEl.textContent = mindShowAll ? "réduire ▴" : "voir les 37 ▾"; }
  }

  function showMind(o) {
    clearMindTimer();
    var old = document.getElementById("ai-mind"); if (old) old.remove();
    var b = document.createElement("div"); b.id = "ai-mind";


    if (o && o.error) {
      b.innerHTML =
        '<div class="mind-head"><div><span class="nlp-tag">OCTOPUS 0.1 · CERVEAU (RAYON X)</span></div>'
        + '<span class="aib-sp"></span><button class="lab-ic" id="mind-close">Fermer</button></div>'
        + '<div class="mind-body"><div class="mind-empty">' + esc(o.error) + '</div></div>';
      document.body.appendChild(b);
      document.getElementById("mind-close").addEventListener("click", function () { clearMindTimer(); b.remove(); });
      return;
    }

    var sl = o.sl || {}, rl = o.rl || {}, nlp = o.nlp || {};


    var cellA;
    if (sl.trained) {
      cellA = '<div class="mind-vbig ' + (sl.up ? "up" : "dn") + '">' + (sl.up ? "▲ HAUSSE" : "▼ BAISSE") + '</div>'
        + '<div class="mind-vsub">' + (sl.yhat_pct >= 0 ? "+" : "−") + Math.abs(sl.yhat_pct).toFixed(3) + " % ±" + sl.band_pct.toFixed(2) + " %</div>";
    } else { cellA = '<div class="mind-vmuted">modèle non entraîné — lance ia.py</div>'; }
    var cellB;
    if (rl.trained) {
      var ch = rl.chosen > 0 ? '<span class="up">▲ LONG</span>' : rl.chosen < 0 ? '<span class="dn">▼ SHORT</span>' : "— PLAT";
      cellB = '<div class="mind-vbig">' + ch + '</div>'
        + '<div class="mind-vsub">marge ' + rl.margin.toFixed(4) + " · ε " + rl.eps.toFixed(3) + "</div>"
        + '<div class="mind-vtiny">(depuis une position PLATE)</div>';
    } else { cellB = '<div class="mind-vmuted">agent non entraîné — lance agent.py</div>'; }
    var cellC;
    if (sl.trained) {
      var ev = (sl.life_edge * 100).toFixed(1);
      var ecls = sl.life_edge > 0 ? "up" : sl.life_edge < 0 ? "dn" : "";
      if (!sl.signif) ecls = "mind-dim";
      cellC = '<div class="mind-vbig ' + ecls + '">' + (sl.life_edge >= 0 ? "+" : "") + ev + " pts</div>"
        + '<div class="mind-vsub">fiab ' + (sl.life_acc * 100).toFixed(0) + " % / base " + (sl.life_base * 100).toFixed(0) + " %</div>"
        + (sl.signif ? "" : '<div class="mind-vtiny">non significatif (échantillon court)</div>');
    } else { cellC = '<div class="mind-vmuted">modèle non entraîné — lance ia.py</div>'; }


    var igset = {}; (sl.ignored || []).forEach(function (f) { igset[f] = 1; });
    var groupsHtml = (o.groups || []).map(function (g) {
      var wide = (g.name === "Momentum") ? " wide" : "";
      var rows = (g.items || []).map(function (it) {
        var faint = igset[it.feat] ? " mind-faint" : "";
        var glyph = igset[it.feat] ? "◦ " : "";
        return '<div class="mind-grp-row' + faint + '"><span>' + glyph + esc(it.label) + '</span>'
          + '<b class="mind-grp-v">' + esc(fmtVal(it.val, it.fmt)) + '</b></div>';
      }).join("");
      return '<div class="mind-grp' + wide + '"><div class="mind-grp-h">' + esc(g.name) + '</div>' + rows + '</div>';
    }).join("");


    var nlpHtml = "";
    if (nlp.trained) {
      nlpHtml = '<div class="mind-nlp">Sentiment réel de la news (étiquette du marché simulé, pas une sortie du modèle) : '
        + (nlp.market_sent == null ? "n/d" : nlp.market_sent.toFixed(2))
        + " · textes vus : " + nlp.seen
        + (nlp.last_news ? " · dernière news : " + esc(nlp.last_news.slice(0, 90)) + (nlp.last_news.length > 90 ? "…" : "") : "") + "</div>";
    }


    var notList = (o.not_doing || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join("");
    var subLag = o.candle_lag
      ? "instantané à l'avant-dernière bougie (repli technique) · prix "
      : "instantané à la dernière bougie analysable (la bougie en cours et la toute dernière clôturée hors cible sont exclues, comme à l'entraînement) · prix ";

    b.innerHTML =
      '<div class="mind-head">' +
        '<div><span class="nlp-tag">OCTOPUS 0.1 · CERVEAU (RAYON X)</span>' +
          '<div class="mind-sub">' + subLag + (o.price != null ? Number(o.price).toPrecision(5) : "—") + ' · ' + mindClock(o.t) + '</div>' +
        '</div>' +
        '<span class="aib-sp"></span>' +
        '<label class="mind-follow"><input type="checkbox" id="mind-follow"' + (mindFollow ? " checked" : "") + '> suivre</label>' +
        '<button class="lab-ic" id="mind-refresh">Rafraîchir</button>' +
        '<button class="lab-ic" id="mind-code">Code</button>' +
        '<button class="lab-ic" id="mind-close">Fermer</button>' +
      '</div>' +
      '<div class="mind-body">' +
        '<div class="mind-verdict">' +
          '<div class="mind-vc"><div class="mind-vh">PRÉDICTION (1 pas)</div>' + cellA + '</div>' +
          '<div class="mind-vc"><div class="mind-vh">DÉCISION AGENT</div>' + cellB + '</div>' +
          '<div class="mind-vc"><div class="mind-vh">AVANTAGE À VIE</div>' + cellC + '</div>' +
        '</div>' +
        '<div class="mind-spine">' +
          '<div class="mind-h2">CE QU\'ELLE PENSE — ET POURQUOI</div>' +
          '<div class="mind-legend" id="mind-legend"></div>' +
          '<div class="mind-seg">' +
            '<button class="mind-seg-b' + (mindTab === "sl" ? " on" : "") + '" data-tab="sl">Modèle supervisé</button>' +
            '<button class="mind-seg-b' + (mindTab === "rl" ? " on" : "") + '" data-tab="rl">Agent (long−short)</button>' +
          '</div>' +
          '<div class="mind-row intercept" id="mind-intercept"><span class="mind-rl"><i>biais (départ)</i></span><span class="mind-rv"></span><span class="mind-track"></span><span class="mind-bi-v"></span></div>' +
          '<div class="mind-qcap" id="mind-qcap"></div>' +
          '<div id="mind-bars"></div>' +
          '<a class="mind-more" id="mind-more"></a>' +
          '<div class="mind-cap" id="mind-cap"></div>' +
        '</div>' +
        '<div class="mind-spine"><div class="mind-h2">TOUT CE QU\'ELLE REGARDE (37 entrées)</div>' +
          '<div class="mind-groups">' + groupsHtml + '</div></div>' +
        nlpHtml +
        '<div class="mind-not">' +
          '<div class="mind-not-h">CE QU\'ELLE NE FAIT PAS</div>' +
          '<ul class="mind-not-list">' + notList + '</ul>' +
          '<div class="mind-note">' + esc(o.note || "") + '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(b);

    renderMindBars(o);


    function mindFollowTick() {
      if (mindBusy) return;
      var t = lastClosedT(); if (t === mindLastT) return;
      mindLastT = t; mindBusy = true;
      computeForecast("cerveau.py", null).then(function (r) {
        mindBusy = false;
        if (r && r.o && r.o.kind === "mind") showMind(r.o);
      }).catch(function () { mindBusy = false; });
    }
    function startMindFollow() { clearMindTimer(); mindLastT = lastClosedT(); mindTimer = setInterval(mindFollowTick, 2000); }


    document.getElementById("mind-close").addEventListener("click", function () { clearMindTimer(); b.remove(); });
    document.getElementById("mind-code").addEventListener("click", function () { clearMindTimer(); b.remove(); open(); });
    var refBtn = document.getElementById("mind-refresh");
    refBtn.addEventListener("click", function () {
      if (mindBusy) return;
      mindBusy = true; refBtn.disabled = true; refBtn.textContent = "…";
      computeForecast("cerveau.py", null).then(function (r) {
        mindBusy = false;
        if (r && r.o && r.o.kind === "mind") { showMind(r.o); }
        else {
          refBtn.disabled = false; refBtn.textContent = "Rafraîchir";
          var hostBars = document.getElementById("mind-bars");
          if (hostBars) hostBars.innerHTML = '<div class="mind-empty">rafraîchissement impossible (cerveau.py absent ou en erreur).</div>';
        }
      }).catch(function () { mindBusy = false; refBtn.disabled = false; refBtn.textContent = "Rafraîchir"; });
    });
    var folBox = document.getElementById("mind-follow");
    folBox.addEventListener("change", function () {
      mindFollow = folBox.checked;
      if (mindFollow) startMindFollow(); else clearMindTimer();
    });

    if (mindFollow && folBox.checked) startMindFollow();
    Array.prototype.forEach.call(b.querySelectorAll(".mind-seg-b"), function (el) {
      el.addEventListener("click", function () {
        mindTab = el.getAttribute("data-tab"); mindShowAll = false;
        Array.prototype.forEach.call(b.querySelectorAll(".mind-seg-b"), function (x) { x.classList.toggle("on", x === el); });
        renderMindBars(o);
      });
    });
    document.getElementById("mind-more").addEventListener("click", function () { mindShowAll = !mindShowAll; renderMindBars(o); });
  }


  function showAuto(o) {
    var old = document.getElementById("ai-auto"); if (old) old.remove();
    var b = document.createElement("div"); b.id = "ai-auto";
    if (o && !o.error) {
      _lastAuto = o;
      var _accNow = autoAccount();
      _lastAutoMid = _accNow ? _accNow.mid : null;
    }
    function resetBtn() { var bb = document.getElementById("auto-run"); if (bb) { bb.disabled = false; bb.textContent = "Lancer l'optimisation"; } }
    function relaunch() {
      var btn = document.getElementById("auto-run");
      if (btn) { btn.disabled = true; btn.textContent = "… en cours"; }
      computeForecast("auto.py", function (t) { appendLog(t); }, null, false).then(function (r) {
        if (r && r.o && r.o.kind === "auto") { showAuto(r.o); }
        else { resetBtn(); appendLog("\n✗ " + ((r && r.err) ? r.err : "optimisation : resultat inattendu") + "\n"); }
      }).catch(function (e) { resetBtn(); appendLog("\n✗ " + (e && e.message ? e.message : e) + "\n"); });
    }

    if (o && o.error) {
      b.innerHTML =
        '<div class="nlp-head"><span class="nlp-tag">OCTOPUS 0.1 · AUTO-OPTIMISATION</span><span class="aib-sp"></span>'
        + '<button class="lab-run" id="auto-run">Lancer l\'optimisation</button>'
        + '<button class="lab-ic" id="auto-close">Fermer</button></div>'
        + '<div class="auto-sub auto-err">' + esc(o.error) + '</div>'
        + '<div class="nlp-note">' + esc(o.note || "") + '</div>';
      _lastAuto = null; _lastAutoMid = null;
      document.body.appendChild(b);
      document.getElementById("auto-close").addEventListener("click", function () { b.remove(); });
      document.getElementById("auto-run").addEventListener("click", relaunch);
      return;
    }
    var rec = o.recommendation || {}, sw = o.horizon_sweep || {}, lb = o.leaderboard || [];
    var pct = function (v, sgn) { if (v == null || !isFinite(v)) return "—"; var s = (v * 100).toFixed(2); return (sgn && v > 0 ? "+" : "") + s + " %"; };
    var bps = function (v) { return (v == null || !isFinite(v)) ? "—" : (v * 10000).toFixed(1) + " bps"; };
    var sensHtml = rec.sens > 0 ? '<span class="up">▲ LONG</span>'
                 : rec.sens < 0 ? '<span class="dn">▼ SHORT</span>'
                 : '<span class="auto-flat">— PLAT</span>';


    var recHtml = '<div class="auto-reco"><div class="auto-reco-main">' + sensHtml + '</div>'
      + '<div class="auto-reco-meta">HORIZON <b>' + esc(rec.horizon) + '</b> · CONFIANCE <b>' + esc(rec.confiance) + '</b>'
      + ' · TAILLE <b>' + (rec.taille_hint != null && isFinite(rec.taille_hint) ? (rec.taille_hint * 100).toFixed(0) + " %" : "—") + '</b>'
      + ' <span class="auto-pill ' + (rec.tradeable ? "on" : "off") + '">Stage 2 : ' + (rec.tradeable ? "exploitable" : "NON exploitable") + '</span></div>'
      + '<div class="auto-reco-why">' + esc(rec.why || "") + '</div></div>';


    var rowsHtml = lb.map(function (r) {
      var isBase = (r.status === "baseline");
      var cls = r.is_best ? ' class="auto-best"'
        : isBase ? ' class="auto-base"'
        : (r.status && r.status !== "ok") ? ' class="auto-dim"' : '';
      var net = r.oos_net, ncls = net > 0 ? "up" : net < 0 ? "dn" : "";
      var nm = isBase ? (r.model === "base_zero" ? "base · plat" : "base · momentum") : esc(r.model);
      return '<tr' + cls + ' title="' + esc(r.note || r.status || "") + '">'
        + '<td class="auto-name">' + nm + '</td><td>' + esc(r.featureset || "—") + '</td><td>' + esc(r.horizon) + '</td>'
        + '<td class="' + ncls + '">' + pct(r.oos_net, true) + '</td>'
        + '<td>' + (r.oos_sharpe != null && isFinite(r.oos_sharpe) ? r.oos_sharpe.toFixed(2) : "—") + '</td>'
        + '<td>' + (r.overfit_gap != null && isFinite(r.overfit_gap) ? (r.overfit_gap * 100).toFixed(1) + " pts" : "—") + '</td>'
        + '<td>' + (r.oos_dir_acc != null && isFinite(r.oos_dir_acc) ? (r.oos_dir_acc * 100).toFixed(1) + " %" : "—") + '</td>'
        + '<td>' + (r.n_oos != null ? r.n_oos : "—") + '</td>'
        + '<td>' + (isBase ? "·" : (r.keep ? '✓' : '✗')) + '</td></tr>';
    }).join("");
    var lbHtml = '<table class="auto-tbl"><thead><tr><th>modèle</th><th>jeu</th><th>h</th><th>net%</th><th>Sharpe/tx</th>'
      + '<th>écart</th><th>fiab%</th><th>n_oos</th><th>garde</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>';



    var srows = sw.rows || []; var maxNet = 0;
    srows.forEach(function (s) { var a = Math.abs(s.oos_net || 0); if (a > maxNet) maxNet = a; });
    var FLOOR = 0.002;
    var denom = Math.max(maxNet, FLOOR);
    var stripHtml = srows.map(function (s) {
      var up = (s.oos_net || 0) >= 0, w = Math.round(Math.min(1, Math.abs(s.oos_net || 0) / denom) * 100);
      var weak = s.faible_n ? ' <span class="auto-weak">n faible</span>' : '';
      var sig = s.signif ? '' : ' <span class="auto-weak">n.s.</span>';
      return '<div class="auto-hbar' + (s.is_best ? " best" : "") + '"><span class="auto-hlbl">h=' + esc(s.h) + '</span>'
        + '<span class="auto-htrack"><i class="' + (up ? "up" : "dn") + '" style="width:' + w + '%"></i></span>'
        + '<span class="auto-hval ' + (up ? "up" : "dn") + '">' + pct(s.oos_net, true) + weak + sig + '</span></div>';
    }).join("");
    var sureLbl = (sw.best_h_sure === false) ? ' <span class="auto-weak">(horizon fragile)</span>' : '';


    var jr = (o.journal || []).slice().reverse().map(function (p) {
      var ents = (p.entries || []).map(function (e) {
        var bcls = e.decision === "GARDÉ" ? "g" : e.decision === "REJETÉ" ? "r" : "i";
        return '<div class="auto-je"><div class="auto-jt">' + esc(e.titre) + ' <span class="auto-badge ' + bcls + '">' + esc(e.decision) + '</span></div>'
          + (e.hypothese ? '<div class="auto-jl"><b>Hypothèse :</b> ' + esc(e.hypothese) + '</div>' : '')
          + (e.test ? '<div class="auto-jl"><b>Test :</b> ' + esc(e.test) + '</div>' : '')
          + (e.resultat ? '<div class="auto-jl"><b>Résultat :</b> ' + esc(e.resultat) + '</div>' : '')
          + (e.pourquoi ? '<div class="auto-jl"><b>Pourquoi :</b> ' + esc(e.pourquoi) + '</div>' : '')
          + '</div>';
      }).join("");
      return '<div class="auto-jpass"><div class="auto-jph">Passe #' + esc(p.pass_id) + '</div>' + ents + '</div>';
    }).join("");

    var cutLbl = (o.cells_cut && o.cells_cut.length) ? ' · ' + o.cells_cut.length + ' coupée(s)' : '';
    b.innerHTML =
      '<div class="nlp-head"><span class="nlp-tag">OCTOPUS 0.1 · AUTO-OPTIMISATION</span><span class="aib-sp"></span>'
        + '<button class="lab-run" id="auto-run">Lancer l\'optimisation</button>'
        + '<button class="lab-ic" id="auto-close">Fermer</button></div>'
      + '<div class="auto-sub">' + esc(o.n_keep) + ' bougies · ' + esc(o.n_folds) + ' plis · purge ' + esc(o.gap_embargo)
        + ' · coût ' + bps(o.cost) + ' · Sharpe ' + esc(o.sharpe_kind || "par transaction")
        + ' · ' + esc(o.cells_run) + '/' + esc(o.cells_planned) + ' cellules' + cutLbl
        + ' · ' + esc(o.elapsed_s) + ' s · passe #' + esc(o.pass_count) + ' · skl ' + esc(o.skl_version) + '/' + esc(o.gbm_impl) + '</div>'
      + recHtml
      + '<div class="auto-sech">Classement (hors échantillon, net de frais)</div>' + lbHtml
      + '<div class="auto-sech">Terme le plus rentable' + sureLbl + '</div><div class="auto-strip">' + stripHtml + '</div>'
        + '<div class="auto-phrase">' + esc(sw.phrase || "") + '</div>'
      + '<div class="auto-sech">Journal de raisonnement</div><div class="auto-journal">' + jr + '</div>'
      + '<div class="nlp-note">' + esc(o.note || "") + '</div>';
    document.body.appendChild(b);
    document.getElementById("auto-close").addEventListener("click", function () { b.remove(); });
    document.getElementById("auto-run").addEventListener("click", relaunch);
  }

  function updateBanner(o) {
    var set = function (id, v, cls) { var e = document.getElementById(id); if (e) { e.textContent = v; if (cls != null) e.className = cls; } };
    if (o.kind === "rl") {
      set("aib-sens", o.lastAction > 0 ? "▲ LONG" : o.lastAction < 0 ? "▼ SHORT" : "— PLAT", o.lastAction > 0 ? "up" : o.lastAction < 0 ? "dn" : "");
      var er = Math.round((o.edge || 0) * 1000) / 10;
      set("aib-edge", (er >= 0 ? "+" : "") + er + " pts vs B&H", o.signif ? (er > 0 ? "up" : "dn") : "");
      set("aib-acc", (Math.round(o.dir_acc * 1000) / 10) + " % gagnants");
      set("aib-seen", (o.seen != null ? o.seen : "—"));
      set("aib-r2", "Sharpe " + (Math.round(o.r2 * 100) / 100));
      set("aib-h", "rotation " + Math.round((o.turnover || 0) * 100) + " %");
      return;
    }
    set("aib-sens", o.up ? "▲ HAUSSE" : "▼ BAISSE", o.up ? "up" : "dn");
    var ed = Math.round((o.edge || 0) * 1000) / 10;
    set("aib-edge", (ed >= 0 ? "+" : "") + ed + " pts", o.signif ? (ed > 0 ? "up" : "dn") : "");
    set("aib-acc", (Math.round(o.dir_acc * 1000) / 10) + " % / base " + (Math.round((o.base != null ? o.base : 0.5) * 1000) / 10) + " %");
    set("aib-seen", (o.seen != null ? o.seen : "—"));
    set("aib-r2", (Math.round(o.r2 * 100) / 100));
    set("aib-h", o.K);
  }

  /* =================== Octopus : lancement direct (onglet Terminal) =================== */
  var _launchBusy = false;
  function launch() {
    if (_launchBusy) return; _launchBusy = true;
    try { fs = loadFS(); applyShipped(fs); saveFS(); } catch (e) {}
    var lb = document.getElementById("octo-launch");
    var setLbl = function (t) { if (lb) { var l = lb.querySelector(".tt-label"); if (l) l.textContent = t; } };
    if (lb) lb.classList.add("busy"); setLbl("Démarrage…");
    try { if (window.TradSim && window.TradSim.showView) window.TradSim.showView("sim"); } catch (e) {}
    ensureWorker(function (s) { setLbl(s || "Démarrage…"); })
      .then(function () { setLbl("Analyse…"); return computeForecast("ia.py", null, null, false); })
      .then(function (r) {
        _launchBusy = false; if (lb) lb.classList.remove("busy"); setLbl("Lancer Octopus");
        if (r && r.o && r.o.center) { forecastEntry = "ia.py"; drawForecast(r.o, r.t0); logActivation(r.o); showBanner(r.o); enableLive(); }
        else if (r && r.err && window.TradSim && window.TradSim.flash) window.TradSim.flash("Octopus : " + r.err, false);
      })
      .catch(function () { _launchBusy = false; if (lb) lb.classList.remove("busy"); setLbl("Lancer Octopus"); });
  }

  /* =================== Octopus : panneau Historique (optimisations) =================== */
  function showHistory() {
    var old = document.getElementById("ai-hist"); if (old) old.remove();
    var b = document.createElement("div"); b.id = "ai-hist";
    var passes = [], passCount = 0; try { var a = JSON.parse(localStorage.getItem("tradlab_auto") || "{}"); passes = (a && a.journal) ? a.journal : []; passCount = a.pass_count || passes.length; } catch (e) {}
    var jrHtml = passes.length ? passes.slice().reverse().map(function (p) {
      var ents = (p.entries || []).map(function (e) {
        var bcls = e.decision === "GARDÉ" ? "g" : e.decision === "REJETÉ" ? "r" : "i";
        return '<div class="hist-je"><b>' + esc(e.titre || "") + '</b> <span class="auto-badge ' + bcls + '">' + esc(e.decision || "") + '</span>' + (e.resultat ? '<div class="hist-jl">' + esc(e.resultat) + '</div>' : "") + '</div>';
      }).join("");
      return '<div class="hist-pass"><div class="hist-ph">Passe #' + esc(p.pass_id) + '</div>' + ents + '</div>';
    }).join("") : '<div class="hist-empty">Aucune optimisation lancée — clique « Lancer Octopus » puis lance une optimisation.</div>';
    b.innerHTML =
      '<div class="nlp-head"><span class="nlp-tag">OCTOPUS 0.1 · HISTORIQUE</span><span class="aib-sp"></span><button class="lab-ic" id="hist-close">Fermer</button></div>'
      + '<div class="hist-cols hist-one">'
      + '<div class="hist-col"><div class="hist-h2">Optimisations (' + passCount + ' passe' + (passCount > 1 ? "s" : "") + ')</div><div class="hist-journal">' + jrHtml + '</div></div>'
      + '</div>'
      + '<div class="nlp-note">Le raisonnement d\'auto-optimisation d\'Octopus, passe par passe. Données locales à ce navigateur.</div>';
    document.body.appendChild(b);
    document.getElementById("hist-close").addEventListener("click", function () { b.remove(); });
  }

  window.TradLab = { open: open, close: close, launch: launch, showHistory: showHistory, setVersion: setOctopusVersion, getVersion: octopusVersion };
})();
