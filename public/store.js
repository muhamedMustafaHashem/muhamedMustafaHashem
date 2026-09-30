/* Store: the subjects a user uploaded, kept on the phone in IndexedDB (never sent to a server).
 * meta store    key = subject number -> {number, name, count, version, file, added}
 * items store   key = subject number -> {number, items: [{id, q, a, n}]}
 * counter store key 'next' -> next subject number (starts at FIRST_NUMBER, so it never collides with
 *               the numbers of subjects built into the app by tools/build_data.py) */
window.Store = (function () {
  'use strict';
  const DB_NAME = 'answer-app', DB_VERSION = 1, FIRST_NUMBER = 1001;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((ok, no) => {
      if (!window.indexedDB) return no(new Error('indexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('meta', { keyPath: 'number' });
        db.createObjectStore('items', { keyPath: 'number' });
        db.createObjectStore('counter', { keyPath: 'key' });
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => no(req.error);
      req.onblocked = () => no(new Error('indexedDB blocked'));
    }).catch((e) => { dbPromise = null; throw e; });
    return dbPromise;
  }
  function done(tx) { return new Promise((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error); }); }
  const wrap = (req) => new Promise((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error); });

  return {
    /** True when this browser can store data (false in some private modes). */
    async available() { try { await open(); return true; } catch { return false; } },
    /** Subjects without their questions: [{number, name, count, version, file, added}], oldest first. */
    async list() {
      const db = await open();
      const all = await wrap(db.transaction('meta').objectStore('meta').getAll());
      return all.sort((a, b) => a.number - b.number);
    },
    /** One subject with its questions: {number, name, items} or undefined. */
    async get(number) {
      const db = await open();
      const [meta, body] = await Promise.all([
        wrap(db.transaction('meta').objectStore('meta').get(number)),
        wrap(db.transaction('items').objectStore('items').get(number)),
      ]);
      return meta && body ? { number, name: meta.name, version: meta.version, items: body.items } : undefined;
    },
    /** The next free subject number (reserved atomically). */
    async nextNumber() {
      const db = await open();
      const tx = db.transaction('counter', 'readwrite');
      const store = tx.objectStore('counter');
      const cur = await wrap(store.get('next'));
      const n = cur ? cur.value : FIRST_NUMBER;
      store.put({ key: 'next', value: n + 1 });
      await done(tx);
      return n;
    },
    /** Save (or replace) a subject: its metadata and its questions together, in one transaction. */
    async put(meta, items) {
      const db = await open();
      const tx = db.transaction(['meta', 'items'], 'readwrite');
      tx.objectStore('meta').put(meta);
      tx.objectStore('items').put({ number: meta.number, items });
      await done(tx);
    },
    async rename(number, name) {
      const db = await open();
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const cur = await wrap(store.get(number));
      if (cur) { cur.name = name; store.put(cur); }
      await done(tx);
    },
    async remove(number) {
      const db = await open();
      const tx = db.transaction(['meta', 'items'], 'readwrite');
      tx.objectStore('meta').delete(number);
      tx.objectStore('items').delete(number);
      await done(tx);
    },
  };
})();
