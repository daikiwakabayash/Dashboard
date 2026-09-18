// ── 素材・制作物の暗号化保存と、認証付き配信 ────────────────────────────
//
// なぜ必要か:
//   Vercel Blob は公開URLしか発行できない（@vercel/blob 0.27.3 は access:'public' のみ）。
//   「URLを推測されにくくするだけ」は非公開保存ではない。長いURLが1度でも漏れれば、
//   ログインしていない誰でも中身を取れてしまう。
//   そこで **保存先には暗号文しか置かない**。復号鍵は保存先に無く、
//   ①のサーバーだけが持つ。画面へはバイト列を**認証付きの配信口**からだけ渡す。
//
// 守る約束:
//   1. 保存先URLを画面・③へ渡さない（publicFile が落とす）。
//   2. 平文を保存先に書かない。暗号文だけを書く。
//   3. 復号鍵(データ鍵)は、環境変数の親鍵で包んでから保存する。**平文のまま保存しない。**
//   4. 途中の一部だけを返せるようにする（動画の再生・シークのため Range に対応する）。
//      そのため **1MiB ごとに区切って個別に暗号化**する。全体を一度に復号しない。
//   5. 区切りの入れ替え・他ファイルからの差し替えを検知する（AAD に fileId と番号を入れる）。
//
// 形式 A256GCM-CHUNK1M:
//   平文を 1MiB ごとに区切り、区切りごとに [IV 12byte][暗号文][認証タグ 16byte] を並べる。
//   最後の区切り以外は必ず同じ長さなので、平文の位置から暗号文の位置を計算できる。
//
// tests/creative-crypto.test.js でカバー。

export const ALG = 'A256GCM-CHUNK1M';
export const CHUNK = 1024 * 1024;        // 平文1区切り
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const CT_CHUNK = IV_LEN + CHUNK + TAG_LEN;   // 暗号文1区切り（最後以外）

const subtle = () => {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('webcrypto_unavailable');
  return c.subtle;
};
const randomBytes = (n) => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
};

// ── base64（Node / ブラウザのどちらでも動く）────────────────────────────
export function toB64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s) {
  const t = String(s || '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(t, 'base64'));
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── 区切りの位置計算（Range 対応の土台）──────────────────────────────
export function chunkCount(plainLen) {
  const n = Math.max(0, Math.floor(Number(plainLen) || 0));
  return n === 0 ? 1 : Math.ceil(n / CHUNK);         // 0byte でも1区切り（空の暗号文を作る）
}
export function cipherLength(plainLen) {
  const n = Math.max(0, Math.floor(Number(plainLen) || 0));
  return n + chunkCount(n) * (IV_LEN + TAG_LEN);
}
/** 区切り i が覆う平文の範囲 [start, end)。 */
export function chunkPlainRange(i, plainLen) {
  const n = Math.max(0, Math.floor(Number(plainLen) || 0));
  const start = i * CHUNK;
  return { start, end: Math.min(n, start + CHUNK) };
}
/** 区切り i の暗号文の範囲 [start, end)。最後の区切りだけ短い。 */
export function chunkCipherRange(i, plainLen) {
  const p = chunkPlainRange(i, plainLen);
  const start = i * CT_CHUNK;
  return { start, end: start + IV_LEN + (p.end - p.start) + TAG_LEN };
}
/** 平文の [start, end]（両端を含む）を返すのに必要な区切りの番号。 */
export function chunksForRange(start, end, plainLen) {
  const n = Math.max(0, Math.floor(Number(plainLen) || 0));
  if (!n) return [];
  const s = Math.max(0, Math.min(n - 1, Math.floor(start)));
  const e = Math.max(s, Math.min(n - 1, Math.floor(end)));
  const out = [];
  for (let i = Math.floor(s / CHUNK); i <= Math.floor(e / CHUNK); i++) out.push(i);
  return out;
}

// 区切りの入れ替え・他ファイルからの差し替えを検知するための付加データ。
export function aadFor(fileId, index) {
  return new TextEncoder().encode(`${ALG}|${String(fileId || '')}|${Math.floor(index)}`);
}

// ── 鍵 ────────────────────────────────────────────────────────────────
async function importKey(raw, usages) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error('bad_key');
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
}
export function newDataKey() { return randomBytes(32); }

/** 環境変数の文字列から親鍵(32byte)を作る。**短い秘密は受け付けない。** */
export async function masterKeyFrom(secret) {
  const s = String(secret || '');
  if (s.length < 32) return null;                    // 弱い親鍵で暗号化したことにしない
  const d = await subtle().digest('SHA-256', new TextEncoder().encode(s));
  return new Uint8Array(d);
}

/** データ鍵を親鍵で包む。**平文の鍵を保存しないため。** */
export async function wrapKey(master, dataKey, label) {
  const k = await importKey(master, ['encrypt']);
  const iv = randomBytes(IV_LEN);
  const aad = new TextEncoder().encode(`wrap|${String(label || '')}`);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad }, k, dataKey));
  return toB64(concatBytes([iv, ct]));
}
export async function unwrapKey(master, wrapped, label) {
  const raw = fromB64(wrapped);
  if (raw.length <= IV_LEN) return null;
  const k = await importKey(master, ['decrypt']);
  const aad = new TextEncoder().encode(`wrap|${String(label || '')}`);
  try {
    const out = await subtle().decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, IV_LEN), additionalData: aad }, k, raw.subarray(IV_LEN));
    const b = new Uint8Array(out);
    return b.length === 32 ? b : null;
  } catch (_) { return null; }                       // 鍵が違う・改ざんされている
}

// ── 本体 ──────────────────────────────────────────────────────────────
/** 1区切りを暗号化して [IV][暗号文][タグ] を返す。 */
export async function encryptChunk(dataKey, fileId, index, plain) {
  const k = await importKey(dataKey, ['encrypt']);
  const iv = randomBytes(IV_LEN);
  const ct = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(fileId, index) }, k, plain));
  return concatBytes([iv, ct]);
}
/** 1区切りを復号する。改ざん・取り違えなら null。 */
export async function decryptChunk(dataKey, fileId, index, cipher) {
  if (!(cipher instanceof Uint8Array) || cipher.length < IV_LEN + TAG_LEN) return null;
  const k = await importKey(dataKey, ['decrypt']);
  try {
    const out = await subtle().decrypt(
      { name: 'AES-GCM', iv: cipher.subarray(0, IV_LEN), additionalData: aadFor(fileId, index) },
      k, cipher.subarray(IV_LEN));
    return new Uint8Array(out);
  } catch (_) { return null; }
}

/** ファイル全体を暗号化する（アップロード前にブラウザで実行する）。 */
export async function encryptBytes(dataKey, fileId, plain) {
  const p = plain instanceof Uint8Array ? plain : new Uint8Array(plain || []);
  const parts = [];
  const n = chunkCount(p.length);
  for (let i = 0; i < n; i++) {
    const r = chunkPlainRange(i, p.length);
    parts.push(await encryptChunk(dataKey, fileId, i, p.subarray(r.start, r.end)));
  }
  return concatBytes(parts);
}

/** ファイル全体を復号する。1区切りでも壊れていれば null（部分的に正しいふりをしない）。 */
export async function decryptBytes(dataKey, fileId, cipher, plainLen) {
  const c = cipher instanceof Uint8Array ? cipher : new Uint8Array(cipher || []);
  if (c.length !== cipherLength(plainLen)) return null;
  const parts = [];
  for (let i = 0; i < chunkCount(plainLen); i++) {
    const r = chunkCipherRange(i, plainLen);
    const d = await decryptChunk(dataKey, fileId, i, c.subarray(r.start, r.end));
    if (!d) return null;
    parts.push(d);
  }
  return concatBytes(parts);
}

export async function sha256Hex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const d = new Uint8Array(await subtle().digest('SHA-256', b));
  return [...d].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Range ヘッダを読む。動画のシークで使う。
 *   返り値 null（範囲指定なし）/ 'invalid'（範囲外）/ { start, end }（両端を含む）
 */
export function parseRange(header, totalLen) {
  const h = String(header || '').trim();
  if (!h) return null;
  const n = Math.max(0, Math.floor(Number(totalLen) || 0));
  const m = /^bytes=(\d*)-(\d*)$/.exec(h);
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start, end;
  if (!m[1]) {                                   // bytes=-500 … 末尾500byte
    const len = Number(m[2]);
    if (!len) return 'invalid';
    start = Math.max(0, n - len); end = n - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : n - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= n) return 'invalid';
  return { start, end: Math.min(end, n - 1) };
}
