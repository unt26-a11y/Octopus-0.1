
var pyodide = null, ready = false;
function post(m) { self.postMessage(m); }

self.onmessage = async function (e) {
  var msg = e.data || {};
  if (msg.type === "init") {
    if (ready) { post({ type: "ready" }); return; }
    try {
      importScripts(msg.indexURL + "pyodide.js");
      post({ type: "status", text: "Chargement du moteur Python…" });
      pyodide = await loadPyodide({ indexURL: msg.indexURL });

      pyodide.setStdout({ batched: function (s) { post({ type: "log", text: s + "\n" }); } });
      pyodide.setStderr({ batched: function (s) { post({ type: "log", text: s + "\n" }); } });
      post({ type: "status", text: "Chargement de scikit-learn…" });
      await pyodide.loadPackage(["numpy", "pandas", "scikit-learn"]);
      ready = true;
      post({ type: "ready" });
    } catch (err) {
      post({ type: "fatal", error: String(err && err.message ? err.message : err) });
    }
    return;
  }
  if (msg.type === "run") {
    if (!ready) { post({ type: "result", reqId: msg.reqId, ok: false, error: "moteur non prêt" }); return; }
    try {
      if (msg.files) {
        pyodide.runPython("import os, sys\nos.makedirs('/work', exist_ok=True)\n(None if '/work' in sys.path else sys.path.insert(0, '/work'))");
        for (var nm in msg.files) {
          try { pyodide.FS.writeFile("/work/" + nm, msg.files[nm]); } catch (e3) {}
          if (/\.py$/.test(nm)) { try { pyodide.runPython("import sys; sys.modules.pop('" + nm.replace(/\.py$/, "") + "', None)"); } catch (e4) {} }
        }
      }
      await pyodide.runPythonAsync(msg.code);
      var json = null;
      try { var v = pyodide.globals.get("__ai_json"); json = (v == null) ? null : String(v); if (v && v.destroy) v.destroy(); } catch (e2) {}
      var model = null;
      try { var mv = pyodide.globals.get("__model_out"); model = (mv == null) ? null : String(mv); if (mv && mv.destroy) mv.destroy(); } catch (e5) {}
      post({ type: "result", reqId: msg.reqId, ok: true, json: json, model: model });
    } catch (err) {
      post({ type: "result", reqId: msg.reqId, ok: false, error: String(err && err.message ? err.message : err) });
    }
    return;
  }
};
