import exifr from 'exifr'

/**
 * 写真ファイルから撮影日時を取得する。
 * EXIF の撮影日時を最優先し、無ければファイルの更新日時にフォールバックする。
 * （ギャラリーで移動・コピーすると更新日時が変わるため、EXIF を見るのが確実）
 */
export async function readPhotoDate(file: File): Promise<number> {
  try {
    const out = (await exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'ModifyDate'])) as
      | Record<string, unknown>
      | undefined
    const d = out?.DateTimeOriginal ?? out?.CreateDate ?? out?.ModifyDate
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.getTime()
  } catch {
    // EXIF が読めない形式（PNG等）はフォールバックへ
  }
  return file.lastModified || Date.now()
}
