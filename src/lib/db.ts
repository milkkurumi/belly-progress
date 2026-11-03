import { openDB, type IDBPDatabase } from 'idb'

// 写真は端末内の IndexedDB にだけ保存する。外部サーバーへは送信しない。
export interface PhotoRecord {
  id: string
  blob: Blob
  takenAt: number // epoch ms
}

let dbPromise: Promise<IDBPDatabase> | null = null

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB('belly-progress', 1, {
      upgrade(d) {
        d.createObjectStore('photos', { keyPath: 'id' })
      },
    })
  }
  return dbPromise
}

export async function listPhotos(): Promise<PhotoRecord[]> {
  const d = await db()
  const all = (await d.getAll('photos')) as PhotoRecord[]
  return all.sort((a, b) => a.takenAt - b.takenAt)
}

export async function addPhoto(blob: Blob, takenAt: number): Promise<PhotoRecord> {
  const rec: PhotoRecord = { id: crypto.randomUUID(), blob, takenAt }
  const d = await db()
  await d.put('photos', rec)
  return rec
}

export async function deletePhoto(id: string): Promise<void> {
  const d = await db()
  await d.delete('photos', id)
}

export async function updatePhotoTakenAt(id: string, takenAt: number): Promise<void> {
  const d = await db()
  const rec = (await d.get('photos', id)) as PhotoRecord | undefined
  if (!rec) return
  rec.takenAt = takenAt
  await d.put('photos', rec)
}
