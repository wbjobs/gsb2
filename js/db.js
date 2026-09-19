/*
 * 共享 IndexedDB 封装 —— 页面与 Service Worker 都通过 importScripts / <script> 引入。
 *
 * 存储内容：
 *   state  : SW 规则、全局开关等配置（key/value）
 *   records: 录制下来的真实请求/响应（完整二进制 body，可重放）
 *   meta   : 版本等元数据，用于 SW 升级时检测与清理
 */
(function (global) {
  'use strict';

  const DB_NAME = 'debug-console-db';
  const DB_VERSION = 1;
  const STATE_KEY = 'sw-state';
  const TAB_KEY = 'tabs';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('state')) {
          db.createObjectStore('state');
        }
        if (!db.objectStoreNames.contains('records')) {
          const store = db.createObjectStore('records', { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function reqAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getKey(storeName, key) {
    const db = await openDB();
    try {
      return await reqAsPromise(tx(db, storeName, 'readonly').get(key));
    } finally {
      db.close();
    }
  }

  async function putKey(storeName, key, value) {
    const db = await openDB();
    try {
      await reqAsPromise(tx(db, storeName, 'readwrite').put(value, key));
    } finally {
      db.close();
    }
  }

  async function deleteKey(storeName, key) {
    const db = await openDB();
    try {
      await reqAsPromise(tx(db, storeName, 'readwrite').delete(key));
    } finally {
      db.close();
    }
  }

  async function clearStore(storeName) {
    const db = await openDB();
    try {
      await reqAsPromise(tx(db, storeName, 'readwrite').clear());
    } finally {
      db.close();
    }
  }

  async function getAllRecords() {
    const db = await openDB();
    try {
      return await reqAsPromise(
        tx(db, 'records', 'readonly').index('createdAt').getAll()
      );
    } finally {
      db.close();
    }
  }

  async function putRecord(record) {
    const db = await openDB();
    try {
      await reqAsPromise(tx(db, 'records', 'readwrite').put(record));
    } finally {
      db.close();
    }
  }

  async function getRecord(id) {
    const db = await openDB();
    try {
      return await reqAsPromise(tx(db, 'records', 'readonly').get(id));
    } finally {
      db.close();
    }
  }

  function defaultState() {
    return {
      enabled: false,        // 总开关：故障注入是否生效
      offline: false,        // 全局离线模拟
      recording: false,      // 是否录制真实请求
      rules: [],             // 规则列表，按顺序首条命中
      updatedAt: 0,
      updatedBy: null
    };
  }

  async function loadState() {
    const stored = await getKey('state', STATE_KEY);
    return Object.assign(defaultState(), stored || {});
  }

  async function saveState(state) {
    await putKey('state', STATE_KEY, state);
  }

  async function loadTabs() {
    return (await getKey('state', TAB_KEY)) || {};
  }

  async function saveTabs(tabs) {
    await putKey('state', TAB_KEY, tabs);
  }

  const api = {
    DB_NAME,
    STATE_KEY,
    defaultState,
    loadState,
    saveState,
    loadTabs,
    saveTabs,
    putRecord,
    getRecord,
    getAllRecords,
    clearStore,
    putKey,
    getKey,
    deleteKey
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.DebugDB = api;
})(typeof self !== 'undefined' ? self : this);
