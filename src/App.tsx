import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addPhoto,
  deletePhoto,
  listPhotos,
  updatePhotoTakenAt,
  type PhotoRecord,
} from './lib/db'
import { readPhotoDate } from './lib/photoDate'
import { exportBackup, importBackup } from './lib/backup'

export interface PhotoItem extends PhotoRecord {
  url: string
}

type Tab = 'shoot' | 'compare' | 'list'
type Cadence = 'weekly' | 'monthly' | 'free'

interface Settings {
  cadence: Cadence
  dueDate: string // 'YYYY-MM-DD' or ''
  autoSaveLocal: boolean
}

const SETTINGS_KEY = 'belly-progress-settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Settings>
      return {
        cadence: p.cadence === 'monthly' || p.cadence === 'free' ? p.cadence : 'weekly',
        dueDate: typeof p.dueDate === 'string' ? p.dueDate : '',
        autoSaveLocal: p.autoSaveLocal === true,
      }
    }
  } catch {
    // ignore
  }
  return { cadence: 'weekly', dueDate: '', autoSaveLocal: false }
}

/** 写真を端末のダウンロードフォルダへ保存する（外部送信はしない） */
function downloadPhoto(blob: Blob, takenAt: number) {
  const d = new Date(takenAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const ext = blob.type.includes('png') ? 'png' : 'jpg'
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `belly-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`
  a.click()
  URL.revokeObjectURL(a.href)
}

const DAY = 86400000

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function daysSince(from: number, to: number): number {
  return Math.round((to - from) / DAY)
}

/** 出産予定日から逆算した妊娠週数ラベル（例: 18週3日） */
function gestationalLabel(takenAt: number, dueDate: string): string | null {
  if (!dueDate) return null
  const due = new Date(`${dueDate}T00:00:00`).getTime()
  if (Number.isNaN(due)) return null
  const gestDays = 280 - Math.round((due - takenAt) / DAY)
  if (gestDays < 0 || gestDays > 300) return null
  return `${Math.floor(gestDays / 7)}週${gestDays % 7}日`
}

function nextDueAt(last: number, cadence: Cadence): number | null {
  if (cadence === 'free') return null
  const d = new Date(last)
  if (cadence === 'weekly') d.setDate(d.getDate() + 7)
  else d.setMonth(d.getMonth() + 1)
  return d.getTime()
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

// ---------- App ----------

export default function App() {
  const [photos, setPhotos] = useState<PhotoItem[]>([])
  const [tab, setTab] = useState<Tab>('shoot')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)
  const itemsRef = useRef<PhotoItem[]>([])

  const reload = useCallback(async () => {
    const recs = await listPhotos()
    const items = recs.map((r) => ({ ...r, url: URL.createObjectURL(r.blob) }))
    itemsRef.current.forEach((p) => URL.revokeObjectURL(p.url))
    itemsRef.current = items
    setPhotos(items)
  }, [])

  useEffect(() => {
    void reload()
    // ブラウザに「消さないでほしいデータ」として保持を要求する（自動削除の抑止）
    try {
      void navigator.storage?.persist?.()
    } catch {
      // ignore
    }
  }, [reload])

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // ignore
    }
  }, [settings])

  const notify = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }, [])

  return (
    <div className="app">
      <header className="header">
        <h1>お腹の経過観察</h1>
        <p className="header-sub">写真はこの端末の中だけに保存されます</p>
      </header>

      <main className="main">
        {tab === 'shoot' && (
          <ShootView photos={photos} onChanged={reload} notify={notify} settings={settings} />
        )}
        {tab === 'compare' && <CompareView photos={photos} notify={notify} />}
        {tab === 'list' && (
          <ListView
            photos={photos}
            settings={settings}
            onSettings={setSettings}
            onChanged={reload}
            notify={notify}
          />
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}

      <nav className="tabbar">
        <button className={tab === 'shoot' ? 'active' : ''} onClick={() => setTab('shoot')}>
          撮影
        </button>
        <button className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}>
          比較
        </button>
        <button className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>
          一覧・設定
        </button>
      </nav>
    </div>
  )
}

// ---------- 撮影（ゴースト撮影） ----------

function ShootView({
  photos,
  onChanged,
  notify,
  settings,
}: {
  photos: PhotoItem[]
  onChanged: () => Promise<void>
  notify: (m: string) => void
  settings: Settings
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [ghostId, setGhostId] = useState<string>('') // '' = 前回（最新）
  const [ghostOpacity, setGhostOpacity] = useState(0.45)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [timerSec, setTimerSec] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  const [lastShot, setLastShot] = useState<{ id: string; url: string } | null>(null)

  const ghost = ghostId ? photos.find((p) => p.id === ghostId) : photos[photos.length - 1]
  const last = photos[photos.length - 1]

  useEffect(() => {
    let cancelled = false
    setCamError(null)
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported')
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      } catch {
        if (!cancelled) {
          setCamError(
            'ブラウザ内でカメラを起動できませんでした。下の「ギャラリー／カメラアプリから選ぶ」から追加できます。',
          )
        }
      }
    }
    void start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [facing])

  const doCapture = () => {
    const v = videoRef.current
    if (!v || v.videoWidth === 0) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')
    if (!ctx) return
    if (facing === 'user') {
      // 自撮りプレビュー（鏡像）に合わせて保存も左右反転する
      ctx.translate(c.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(v, 0, 0)
    c.toBlob(
      async (b) => {
        if (!b) return
        const ts = Date.now()
        const rec = await addPhoto(b, ts)
        if (settings.autoSaveLocal) downloadPhoto(b, ts)
        setLastShot((prev) => {
          if (prev) URL.revokeObjectURL(prev.url)
          return { id: rec.id, url: URL.createObjectURL(b) }
        })
        notify('保存しました')
        await onChanged()
      },
      'image/jpeg',
      0.92,
    )
  }

  const capture = () => {
    if (countdown !== null) return
    if (timerSec > 0) setCountdown(timerSec)
    else doCapture()
  }

  useEffect(() => {
    if (countdown === null) return
    if (countdown === 0) {
      setCountdown(null)
      doCapture()
      return
    }
    const id = window.setTimeout(() => setCountdown((c) => (c !== null ? c - 1 : null)), 1000)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown])

  const discardLastShot = async () => {
    if (!lastShot) return
    await deletePhoto(lastShot.id)
    URL.revokeObjectURL(lastShot.url)
    setLastShot(null)
    notify('削除しました。撮り直してください')
    await onChanged()
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    for (const f of files) {
      await addPhoto(f, await readPhotoDate(f))
    }
    notify(files.length > 1 ? `${files.length}枚追加しました` : '追加しました')
    await onChanged()
  }

  return (
    <section>
      {photos.length === 0 && (
        <div className="card guide-card">
          <h2>使い方</h2>
          <ol className="guide-steps">
            <li>同じ場所で、横向き（横からの姿）で撮ると比べやすくなります</li>
            <li>2回目からは、前回の写真が半透明に重なって見えます。位置を合わせて撮ってください</li>
            <li>写真はこのスマホの中だけに保存されます（外部に送られません）</li>
          </ol>
        </div>
      )}

      <div className="viewfinder">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="vf-video"
          style={facing === 'user' ? { transform: 'scaleX(-1)' } : undefined}
        />
        {ghost && <img src={ghost.url} alt="" className="vf-ghost" style={{ opacity: ghostOpacity }} />}
        {showGuide && (
          <div className="vf-grid">
            <span className="gl-v" style={{ left: '33.33%' }} />
            <span className="gl-v" style={{ left: '66.66%' }} />
            <span className="gl-h" style={{ top: '33.33%' }} />
            <span className="gl-h" style={{ top: '66.66%' }} />
          </div>
        )}
        {countdown !== null && countdown > 0 && <div className="vf-count">{countdown}</div>}
        {camError && <div className="vf-error">{camError}</div>}
      </div>

      <div className="chips vf-tools">
        <button className="chip" onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}>
          {facing === 'environment' ? '自撮りカメラに切替' : '外カメラに切替'}
        </button>
        <button className={showGuide ? 'chip active' : 'chip'} onClick={() => setShowGuide((s) => !s)}>
          ガイド線
        </button>
        <button className={timerSec === 0 ? 'chip active' : 'chip'} onClick={() => setTimerSec(0)}>
          タイマーなし
        </button>
        <button className={timerSec === 3 ? 'chip active' : 'chip'} onClick={() => setTimerSec(3)}>
          3秒
        </button>
        <button className={timerSec === 10 ? 'chip active' : 'chip'} onClick={() => setTimerSec(10)}>
          10秒
        </button>
      </div>

      {ghost ? (
        <div className="control">
          <label>
            ゴーストの濃さ <span>{Math.round(ghostOpacity * 100)}%</span>
          </label>
          <input
            type="range"
            min={0}
            max={0.9}
            step={0.05}
            value={ghostOpacity}
            onChange={(e) => setGhostOpacity(Number(e.target.value))}
          />
          <label>重ねる写真</label>
          <div className="chips">
            <button className={ghostId === '' ? 'chip active' : 'chip'} onClick={() => setGhostId('')}>
              前回
            </button>
            {photos.map((p) => (
              <button
                key={p.id}
                className={ghostId === p.id ? 'chip active' : 'chip'}
                onClick={() => setGhostId(p.id)}
              >
                {fmtDate(p.takenAt)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="note">まだ写真がありません。1枚目を撮ると、次回からゴーストで重ねて撮れます。</p>
      )}

      <button className="shutter" onClick={capture} disabled={!!camError || countdown !== null}>
        {countdown !== null ? `${countdown}…` : '● 撮影する'}
      </button>

      {lastShot && (
        <div className="lastshot">
          <img src={lastShot.url} alt="今撮った写真" />
          <span>今撮った写真</span>
          <button className="mini-btn" onClick={discardLastShot}>
            削除して撮り直す
          </button>
        </div>
      )}

      <button className="sub-btn" onClick={() => fileRef.current?.click()}>
        ギャラリー／カメラアプリから選ぶ（複数OK）
      </button>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFile} />

      {last && (
        <p className="note">
          前回の撮影：{fmtDate(last.takenAt)}（{daysSince(last.takenAt, Date.now())}日前）
        </p>
      )}
    </section>
  )
}

// ---------- 比較 ----------

type CompareMode = 'overlay' | 'wipe' | 'flicker'

function CompareView({ photos, notify }: { photos: PhotoItem[]; notify: (m: string) => void }) {
  const [baseId, setBaseId] = useState<string>('')
  const [overId, setOverId] = useState<string>('')
  const [mode, setMode] = useState<CompareMode>('overlay')
  const [opacity, setOpacity] = useState(0.5)
  const [wipe, setWipe] = useState(50)
  const [scale, setScale] = useState(1)
  const [rot, setRot] = useState(0)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [flickOn, setFlickOn] = useState(true)
  const [baseNat, setBaseNat] = useState<{ w: number; h: number } | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef({ active: false, startX: 0, startY: 0, tx: 0, ty: 0 })

  useEffect(() => {
    if (photos.length === 0) return
    if (!photos.some((p) => p.id === baseId)) setBaseId(photos[0].id)
    if (!photos.some((p) => p.id === overId)) setOverId(photos[photos.length - 1].id)
  }, [photos, baseId, overId])

  useEffect(() => {
    if (mode !== 'flicker') return
    const id = window.setInterval(() => setFlickOn((v) => !v), 700)
    return () => window.clearInterval(id)
  }, [mode])

  const base = photos.find((p) => p.id === baseId)
  const over = photos.find((p) => p.id === overId)

  if (photos.length < 2) {
    return <p className="note">比較には写真が2枚以上必要です。撮影タブから写真を増やしてください。</p>
  }
  if (!base || !over) return null

  const effOpacity = mode === 'overlay' ? opacity : mode === 'flicker' ? (flickOn ? 1 : 0) : 1

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, tx, ty }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d.active) return
    setTx(d.tx + (e.clientX - d.startX))
    setTy(d.ty + (e.clientY - d.startY))
  }
  const endDrag = () => {
    dragRef.current.active = false
  }

  const resetTransform = () => {
    setScale(1)
    setRot(0)
    setTx(0)
    setTy(0)
  }

  const exportPNG = async () => {
    try {
      const stage = stageRef.current
      if (!stage) return
      const baseImg = await loadImage(base.url)
      const overImg = await loadImage(over.url)
      const W = baseImg.naturalWidth
      const H = baseImg.naturalHeight
      const rect = stage.getBoundingClientRect()
      const sx = W / rect.width
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.drawImage(baseImg, 0, 0, W, H)
      ctx.save()
      ctx.globalAlpha = mode === 'overlay' ? opacity : 1
      if (mode === 'wipe') {
        ctx.beginPath()
        ctx.rect(0, 0, (W * wipe) / 100, H)
        ctx.clip()
      }
      ctx.translate(W / 2 + tx * sx, H / 2 + ty * sx)
      ctx.rotate((rot * Math.PI) / 180)
      ctx.scale(scale, scale)
      ctx.drawImage(overImg, -W / 2, -H / 2, W, H)
      ctx.restore()
      c.toBlob((b) => {
        if (!b) return
        const a = document.createElement('a')
        a.href = URL.createObjectURL(b)
        a.download = 'compare.png'
        a.click()
        URL.revokeObjectURL(a.href)
        notify('画像を書き出しました')
      }, 'image/png')
    } catch {
      notify('書き出しに失敗しました')
    }
  }

  return (
    <section>
      <div className="pickers">
        <label>
          下の写真（基準）
          <select value={baseId} onChange={(e) => setBaseId(e.target.value)}>
            {photos.map((p) => (
              <option key={p.id} value={p.id}>
                {fmtDate(p.takenAt)}
              </option>
            ))}
          </select>
        </label>
        <label>
          上の写真（重ねる）
          <select value={overId} onChange={(e) => setOverId(e.target.value)}>
            {photos.map((p) => (
              <option key={p.id} value={p.id}>
                {fmtDate(p.takenAt)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className="stage"
        ref={stageRef}
        style={baseNat ? { aspectRatio: `${baseNat.w} / ${baseNat.h}` } : undefined}
      >
        <img
          src={base.url}
          alt=""
          className="stage-img"
          draggable={false}
          onLoad={(e) =>
            setBaseNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
        />
        <div
          className="stage-over"
          style={{
            opacity: effOpacity,
            clipPath: mode === 'wipe' ? `inset(0 ${100 - wipe}% 0 0)` : undefined,
            transform: `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rot}deg)`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img src={over.url} alt="" className="stage-img" draggable={false} />
        </div>
        {mode === 'wipe' && <div className="wipe-line" style={{ left: `${wipe}%` }} />}
      </div>
      <p className="note">上の写真はドラッグで動かせます。おへそや腰の位置など、目印で合わせてください。</p>

      <div className="chips">
        <button className={mode === 'overlay' ? 'chip active' : 'chip'} onClick={() => setMode('overlay')}>
          重ねる
        </button>
        <button className={mode === 'wipe' ? 'chip active' : 'chip'} onClick={() => setMode('wipe')}>
          ワイプ
        </button>
        <button className={mode === 'flicker' ? 'chip active' : 'chip'} onClick={() => setMode('flicker')}>
          フリッカー
        </button>
      </div>

      {mode === 'overlay' && (
        <div className="control">
          <label>
            透明度 <span>{Math.round(opacity * 100)}%</span>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
          />
        </div>
      )}
      {mode === 'wipe' && (
        <div className="control">
          <label>
            境界 <span>{wipe}%</span>
          </label>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={wipe}
            onChange={(e) => setWipe(Number(e.target.value))}
          />
        </div>
      )}
      <div className="control">
        <label>
          大きさ <span>{scale.toFixed(2)}x</span>
        </label>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.01}
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
        />
        <label>
          回転 <span>{rot.toFixed(1)}°</span>
        </label>
        <input
          type="range"
          min={-30}
          max={30}
          step={0.5}
          value={rot}
          onChange={(e) => setRot(Number(e.target.value))}
        />
      </div>
      <div className="btn-row">
        <button className="sub-btn" onClick={resetTransform}>
          位置をリセット
        </button>
        <button className="sub-btn" onClick={exportPNG}>
          この状態を画像で保存
        </button>
      </div>
    </section>
  )
}

// ---------- 一覧・設定 ----------

function ListView({
  photos,
  settings,
  onSettings,
  onChanged,
  notify,
}: {
  photos: PhotoItem[]
  settings: Settings
  onSettings: (s: Settings) => void
  onChanged: () => Promise<void>
  notify: (m: string) => void
}) {
  const last = photos[photos.length - 1]
  const next = last ? nextDueAt(last.takenAt, settings.cadence) : null
  const now = Date.now()
  const [editingId, setEditingId] = useState<string>('')
  const [editDate, setEditDate] = useState<string>('')
  const [backupBusy, setBackupBusy] = useState(false)
  const restoreRef = useRef<HTMLInputElement | null>(null)

  const remove = async (p: PhotoItem) => {
    if (!window.confirm(`${fmtDate(p.takenAt)} の写真を削除しますか？`)) return
    await deletePhoto(p.id)
    await onChanged()
  }

  const startEdit = (p: PhotoItem) => {
    const d = new Date(p.takenAt)
    const pad = (n: number) => String(n).padStart(2, '0')
    setEditDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    setEditingId(p.id)
  }

  const saveEdit = async (p: PhotoItem) => {
    if (!editDate) return
    const ts = new Date(`${editDate}T12:00:00`).getTime()
    if (Number.isNaN(ts)) return
    await updatePhotoTakenAt(p.id, ts)
    setEditingId('')
    notify('日付を変更しました')
    await onChanged()
  }

  const doExport = async () => {
    if (photos.length === 0) return
    setBackupBusy(true)
    try {
      const n = await exportBackup()
      notify(`${n}枚をZIPに書き出しました`)
    } catch {
      notify('書き出しに失敗しました')
    } finally {
      setBackupBusy(false)
    }
  }

  const onRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setBackupBusy(true)
    try {
      const r = await importBackup(f)
      notify(`復元しました（追加 ${r.added}枚／既にある ${r.skipped}枚はスキップ）`)
      await onChanged()
    } catch {
      notify('復元に失敗しました。バックアップZIPを選んでください')
    } finally {
      setBackupBusy(false)
    }
  }

  return (
    <section>
      <div className="card">
        <h2>設定</h2>
        <label className="field">
          撮影ペース
          <select
            value={settings.cadence}
            onChange={(e) => onSettings({ ...settings, cadence: e.target.value as Cadence })}
          >
            <option value="weekly">週に1回</option>
            <option value="monthly">月に1回</option>
            <option value="free">自由（目安なし）</option>
          </select>
        </label>
        <label className="field">
          出産予定日（週数ラベル用・任意）
          <input
            type="date"
            value={settings.dueDate}
            onChange={(e) => onSettings({ ...settings, dueDate: e.target.value })}
          />
        </label>
        <label className="field check">
          <input
            type="checkbox"
            checked={settings.autoSaveLocal}
            onChange={(e) => onSettings({ ...settings, autoSaveLocal: e.target.checked })}
          />
          アプリで撮影したら、端末のダウンロードフォルダにも保存する
        </label>
        {last && (
          <p className="note">
            前回の撮影：{fmtDate(last.takenAt)}（{daysSince(last.takenAt, now)}日前）
            {next &&
              (now >= next ? (
                <>
                  <br />
                  そろそろ次の撮影の頃です。
                </>
              ) : (
                <>
                  <br />
                  次の目安：{fmtDate(next)}
                </>
              ))}
          </p>
        )}
      </div>

      <div className="card card-spaced">
        <h2>バックアップ</h2>
        <p className="note">
          写真はこの端末のブラウザ内にだけあります。ときどきZIPで書き出して、端末の好きな場所（プライベートアルバムやPCなど）に保管しておくと、ブラウザのデータを消しても復元できます。書き出し・復元とも、外部に送信はされません。
        </p>
        <div className="btn-row">
          <button className="sub-btn" onClick={doExport} disabled={backupBusy || photos.length === 0}>
            全写真をZIPで書き出す
          </button>
          <button className="sub-btn" onClick={() => restoreRef.current?.click()} disabled={backupBusy}>
            バックアップから復元
          </button>
        </div>
        <input
          ref={restoreRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={onRestore}
        />
      </div>

      <h2 className="list-title">写真一覧（{photos.length}枚）</h2>
      {photos.length === 0 && <p className="note">まだ写真がありません。</p>}
      <div className="grid">
        {photos
          .map((p, i) => ({ p, i }))
          .reverse()
          .map(({ p, i }) => {
            const g = gestationalLabel(p.takenAt, settings.dueDate)
            const prev = photos[i - 1]
            return (
            <figure key={p.id} className="cell">
              <img src={p.url} alt={fmtDate(p.takenAt)} />
              <figcaption>
                <span>{fmtDate(p.takenAt)}</span>
                {g && <span className="badge">{g}</span>}
                <span className="cell-sub">
                  {prev ? `前回から${daysSince(prev.takenAt, p.takenAt)}日` : '1枚目'}
                </span>
                {editingId === p.id ? (
                  <span className="date-edit">
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                    />
                    <button className="mini-btn" onClick={() => saveEdit(p)}>
                      保存
                    </button>
                    <button className="mini-btn" onClick={() => setEditingId('')}>
                      取消
                    </button>
                  </span>
                ) : (
                  <>
                    <button className="save-btn" onClick={() => downloadPhoto(p.blob, p.takenAt)}>
                      端末に保存
                    </button>
                    <button className="edit-btn" onClick={() => startEdit(p)}>
                      日付変更
                    </button>
                    <button className="del" onClick={() => remove(p)}>
                      削除
                    </button>
                  </>
                )}
              </figcaption>
            </figure>
          )
        })}
      </div>
    </section>
  )
}
