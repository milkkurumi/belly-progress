import JSZip from 'jszip'
import { addPhoto, listPhotos } from './db'
import { readPhotoDate } from './photoDate'

// バックアップは端末へ ZIP で書き出すだけ。どこにもアップロードしない。

interface ManifestEntry {
  file: string
  takenAt: number
}
interface Manifest {
  app: 'belly-progress'
  version: 1
  photos: ManifestEntry[]
}

function stamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function extFor(blob: Blob): string {
  if (blob.type.includes('png')) return 'png'
  if (blob.type.includes('webp')) return 'webp'
  return 'jpg'
}

export async function exportBackup(): Promise<number> {
  const photos = await listPhotos()
  const zip = new JSZip()
  const manifest: Manifest = { app: 'belly-progress', version: 1, photos: [] }
  photos.forEach((p, i) => {
    const name = `${stamp(p.takenAt)}_${i}.${extFor(p.blob)}`
    zip.file(name, p.blob)
    manifest.photos.push({ file: name, takenAt: p.takenAt })
  })
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  const blob = await zip.generateAsync({ type: 'blob' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `belly-progress-backup-${stamp(Date.now())}.zip`
  a.click()
  URL.revokeObjectURL(a.href)
  return photos.length
}

export async function importBackup(file: File): Promise<{ added: number; skipped: number }> {
  const zip = await JSZip.loadAsync(file)
  const existing = await listPhotos()
  const seen = new Set(existing.map((p) => `${p.takenAt}:${p.blob.size}`))

  let manifest: Manifest | null = null
  const mf = zip.file('manifest.json')
  if (mf) {
    try {
      manifest = JSON.parse(await mf.async('string')) as Manifest
    } catch {
      manifest = null
    }
  }
  const byName = new Map((manifest?.photos ?? []).map((m) => [m.file, m.takenAt]))

  let added = 0
  let skipped = 0
  const names = Object.keys(zip.files).filter(
    (n) => !zip.files[n].dir && n !== 'manifest.json' && /\.(jpe?g|png|webp)$/i.test(n),
  )
  for (const name of names) {
    const raw = await zip.files[name].async('blob')
    const typed = raw.type
      ? raw
      : new Blob([raw], { type: name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' })
    let takenAt = byName.get(name)
    if (!takenAt) {
      takenAt = await readPhotoDate(new File([typed], name))
    }
    const key = `${takenAt}:${typed.size}`
    if (seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)
    await addPhoto(typed, takenAt)
    added++
  }
  return { added, skipped }
}
