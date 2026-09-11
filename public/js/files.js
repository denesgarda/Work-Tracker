// Receipt capture. Photos are shrunk before upload — a phone photo is 3–5 MB —
// but only as far as keeps small print legible. PDFs go up untouched.

import { newId } from './store.js';

const LONG_EDGE = 2000;                         // px; receipt text stays readable
const THUMB_EDGE = 360;
const KEEP_ORIGINAL_UNDER = 1.5 * 1024 * 1024;  // screenshots of statements: never re-encode text

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/heif': 'heic', 'application/pdf': 'pdf',
};
const BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf' };

export const isImage = (type) => /^image\//.test(type || '');
export const fileUrl = (key) => '/api/files/' + key.split('/').map(encodeURIComponent).join('/');

// Some platforms hand over HEIC files with an empty MIME type.
const typeOf = (file) =>
  (file.type || BY_EXT[(file.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] || '').toLowerCase();

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('undecodable')); };
    img.src = url;
  });
}

function drawScaled(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';            // a transparent PNG would otherwise turn black as JPEG
  g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
}

/** What will actually be uploaded: { blob, type, thumb | null }. */
export async function prepareFile(file) {
  const type = typeOf(file);
  if (!EXT[type]) throw new Error(`${file.name}: only photos, screenshots and PDFs can be attached`);
  if (!isImage(type)) return { blob: file, type, thumb: null };

  let img;
  try {
    img = await loadImage(file);
  } catch {
    // HEIC on a browser that can't decode it: keep the original rather than lose it.
    return { blob: file, type, thumb: null };
  }

  const thumb = await drawScaled(img, THUMB_EDGE, 0.72);
  const heic = type === 'image/heic' || type === 'image/heif';   // convert: most browsers can't display it
  if (!heic && (file.size <= KEEP_ORIGINAL_UNDER || type === 'image/gif')) return { blob: file, type, thumb };

  const big = await drawScaled(img, LONG_EDGE, 0.86);
  return big && (heic || big.size < file.size) ? { blob: big, type: 'image/jpeg', thumb } : { blob: file, type, thumb };
}

async function put(key, blob, type) {
  const res = await fetch(fileUrl(key), { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
  if (!res.ok) {
    let msg = `Upload failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
}

/** Uploads one picked file for an expense and returns its attachment record. */
export async function uploadAttachment(expenseId, file) {
  const p = await prepareFile(file);
  const stem = `exp/${expenseId}/${newId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const key = `${stem}.${EXT[p.type]}`;
  await put(key, p.blob, p.type);

  let thumb = null;
  if (p.thumb) {
    thumb = `${stem}.thumb.jpg`;
    try { await put(thumb, p.thumb, 'image/jpeg'); } catch { thumb = null; }   // a missing thumbnail is cosmetic
  }
  return { key, thumb, name: file.name.slice(0, 120), type: p.type, size: p.blob.size };
}

export async function deleteAttachment(a) {
  for (const k of [a.key, a.thumb].filter(Boolean)) {
    try { await fetch(fileUrl(k), { method: 'DELETE' }); } catch {}
  }
}
