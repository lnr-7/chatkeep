// IndexedDB wrapper. One store, keyed by conversation id.

const DB_NAME = "chatkeep";
const STORE = "conversations";

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function run(mode, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        result = work(store);
      }),
  );
}

export function getAll() {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }),
  );
}

export function putMany(conversations) {
  return run("readwrite", (store) => {
    for (const conv of conversations) store.put(conv);
  });
}

export function remove(id) {
  return run("readwrite", (store) => store.delete(id));
}

export function clear() {
  return run("readwrite", (store) => store.clear());
}
