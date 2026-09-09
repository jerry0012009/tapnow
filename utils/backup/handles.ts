async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("tapnow-local-directories", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function directoryHandle(key: string, value?: unknown): Promise<any> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", value ? "readwrite" : "readonly");
      const store = tx.objectStore("handles");
      const request = value ? store.put(value, key) : store.get(key);
      tx.oncomplete = () => resolve(value || request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("目录授权存储被中止"));
    });
  } finally { db.close(); }
}
