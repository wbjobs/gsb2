/* IndexedDB 封装：配置(KV) 与 录制条目(recordings) */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DebugDB = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB_NAME = 'gsb-debug-db';
  const DB_VERSION = 1;
  const KV_STORE = 'kv';
  const REC_STORE = 'recordings';
  const KV_CONFIG = 'config';
  const KV_META = 'meta';

  let cachedDb = null;

  function open() {
    if (cachedDb) return Promise.resolve(cachedDb);
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
        if (!db.objectStoreNames.contains(REC_STORE)) {
          const store = db.createObjectStore(REC_STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = function () {
        cachedDb = req.result;
        cachedDb.onclose = function () { cachedDb = null; };
        resolve(cachedDb);
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(storeName, mode) {
    return open().then(function (db) {
      const t = db.transaction(storeName, mode);
      return { tx: t, store: t.objectStore(storeName) };
    });
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function getKV(key, fallback) {
    return tx(KV_STORE, 'readonly').then(function (ctx) {
      return reqToPromise(ctx.store.get(key));
    }).then(function (v) {
      return v === undefined ? fallback : v;
    });
  }

  function setKV(key, value) {
    return tx(KV_STORE, 'readwrite').then(function (ctx) {
      ctx.store.put(value, key);
      return new Promise(function (resolve, reject) {
        ctx.tx.oncomplete = function () { resolve(); };
        ctx.tx.onerror = function () { reject(ctx.tx.error); };
      });
    });
  }

  function getConfig() {
    return getKV(KV_CONFIG, { rules: [], recording: false, replay: false, configVersion: 0 });
  }

  function setConfig(config) { return setKV(KV_CONFIG, config); }

  function putRecording(rec) {
    return tx(REC_STORE, 'readwrite').then(function (ctx) {
      ctx.store.put(rec);
      return new Promise(function (resolve, reject) {
        ctx.tx.oncomplete = function () { resolve(); };
        ctx.tx.onerror = function () { reject(ctx.tx.error); };
      });
    });
  }

  function getRecording(id) {
    return tx(REC_STORE, 'readonly').then(function (ctx) {
      return reqToPromise(ctx.store.get(id));
    });
  }

  function listRecordings() {
    return tx(REC_STORE, 'readonly').then(function (ctx) {
      return reqToPromise(ctx.store.getAll());
    }).then(function (all) {
      return (all || []).sort(function (a, b) { return a.createdAt - b.createdAt || a.seq - b.seq; });
    });
  }

  function countRecordings() {
    return tx(REC_STORE, 'readonly').then(function (ctx) {
      return reqToPromise(ctx.store.count());
    });
  }

  function clearRecordings() {
    return tx(REC_STORE, 'readwrite').then(function (ctx) {
      ctx.store.clear();
      return new Promise(function (resolve, reject) {
        ctx.tx.oncomplete = function () { resolve(); };
        ctx.tx.onerror = function () { reject(ctx.tx.error); };
      });
    });
  }

  return {
    DB_NAME: DB_NAME,
    KV_CONFIG: KV_CONFIG,
    KV_META: KV_META,
    getKV: getKV,
    setKV: setKV,
    getConfig: getConfig,
    setConfig: setConfig,
    putRecording: putRecording,
    getRecording: getRecording,
    listRecordings: listRecordings,
    countRecordings: countRecordings,
    clearRecordings: clearRecordings,
  };

});
