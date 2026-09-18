import { describe, it, expect } from 'vitest';
import {
  ALG, CHUNK, IV_LEN, TAG_LEN, CT_CHUNK,
  toB64, fromB64, concatBytes, chunkCount, cipherLength, chunkPlainRange, chunkCipherRange,
  chunksForRange, newDataKey, masterKeyFrom, wrapKey, unwrapKey,
  encryptChunk, decryptChunk, encryptBytes, decryptBytes, sha256Hex, parseRange,
} from '../lib/creative-crypto.js';

const bytes = (n, seed = 0) => new Uint8Array(n).map((_, i) => (i * 7 + seed) % 251);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

describe('base64（Node・ブラウザのどちらでも同じ結果）', () => {
  it('往復しても変わらない', () => {
    const b = bytes(1000);
    expect(same(fromB64(toB64(b)), b)).toBe(true);
  });
  it('空でも落ちない', () => {
    expect(toB64(new Uint8Array(0))).toBe('');
    expect(fromB64('').length).toBe(0);
  });
});

describe('区切りの位置（Range 対応の土台）', () => {
  it('平文の長さから暗号文の長さが決まる', () => {
    expect(cipherLength(0)).toBe(IV_LEN + TAG_LEN);
    expect(cipherLength(100)).toBe(100 + IV_LEN + TAG_LEN);
    expect(cipherLength(CHUNK)).toBe(CHUNK + IV_LEN + TAG_LEN);
    expect(cipherLength(CHUNK + 1)).toBe(CHUNK + 1 + 2 * (IV_LEN + TAG_LEN));
  });
  it('最後以外の区切りは同じ長さ（位置を計算できる）', () => {
    const len = CHUNK * 2 + 500;
    expect(chunkCount(len)).toBe(3);
    expect(chunkCipherRange(0, len)).toEqual({ start: 0, end: CT_CHUNK });
    expect(chunkCipherRange(1, len)).toEqual({ start: CT_CHUNK, end: 2 * CT_CHUNK });
    expect(chunkCipherRange(2, len)).toEqual({ start: 2 * CT_CHUNK, end: 2 * CT_CHUNK + 500 + IV_LEN + TAG_LEN });
  });
  it('平文の範囲から必要な区切りだけを選ぶ（全体を復号しない）', () => {
    const len = CHUNK * 3;
    expect(chunksForRange(0, 10, len)).toEqual([0]);
    expect(chunksForRange(CHUNK - 1, CHUNK, len)).toEqual([0, 1]);
    expect(chunksForRange(0, len - 1, len)).toEqual([0, 1, 2]);
  });
  it('範囲外を指しても落ちない', () => {
    expect(chunksForRange(0, 99, 0)).toEqual([]);
    expect(chunksForRange(-5, 999999, 100)).toEqual([0]);
  });
  it('区切りが覆う平文の範囲', () => {
    expect(chunkPlainRange(0, 500)).toEqual({ start: 0, end: 500 });
    expect(chunkPlainRange(1, CHUNK + 5)).toEqual({ start: CHUNK, end: CHUNK + 5 });
  });
});

describe('データ鍵を親鍵で包む', () => {
  it('🔴 弱い親鍵（32文字未満）では暗号化したことにしない', async () => {
    expect(await masterKeyFrom('short')).toBe(null);
    expect(await masterKeyFrom('')).toBe(null);
    expect(await masterKeyFrom(null)).toBe(null);
    expect((await masterKeyFrom('x'.repeat(32))).length).toBe(32);
  });
  it('包んで開けば元の鍵に戻る', async () => {
    const master = await masterKeyFrom('m'.repeat(40));
    const k = newDataKey();
    expect(same(await unwrapKey(master, await wrapKey(master, k, 'as_1:f_1'), 'as_1:f_1'), k)).toBe(true);
  });
  it('🔴 包んだ鍵に平文の鍵が見えない', async () => {
    const master = await masterKeyFrom('m'.repeat(40));
    const k = newDataKey();
    const w = await wrapKey(master, k, 'l');
    expect(w).not.toContain(toB64(k));
  });
  it('🔴 別のファイル・別の親鍵では開けない（取り違え・流用を防ぐ）', async () => {
    const master = await masterKeyFrom('m'.repeat(40));
    const other = await masterKeyFrom('o'.repeat(40));
    const k = newDataKey();
    const w = await wrapKey(master, k, 'as_1:f_1');
    expect(await unwrapKey(master, w, 'as_1:f_2')).toBe(null);
    expect(await unwrapKey(other, w, 'as_1:f_1')).toBe(null);
    expect(await unwrapKey(master, 'AAAA', 'as_1:f_1')).toBe(null);
  });
});

describe('暗号化と復号', () => {
  it('往復しても中身が変わらない（複数区切りにまたがっても）', async () => {
    const k = newDataKey();
    for (const n of [0, 1, 1000, CHUNK, CHUNK + 1, CHUNK * 2 + 77]) {
      const p = bytes(n);
      const ct = await encryptBytes(k, 'f_1', p);
      expect(ct.length, `len=${n}`).toBe(cipherLength(n));
      expect(same(await decryptBytes(k, 'f_1', ct, n), p), `roundtrip len=${n}`).toBe(true);
    }
  });
  it('🔴 保存先に平文が残らない', async () => {
    const k = newDataKey();
    const p = new TextEncoder().encode('施術前後の写真データ'.repeat(50));
    const ct = await encryptBytes(k, 'f_1', p);
    expect(new TextDecoder().decode(ct)).not.toContain('施術前後');
  });
  it('🔴 鍵が違えば取り出せない（URLだけ知っていても読めない）', async () => {
    const p = bytes(5000);
    const ct = await encryptBytes(newDataKey(), 'f_1', p);
    expect(await decryptBytes(newDataKey(), 'f_1', ct, 5000)).toBe(null);
  });
  it('🔴 別ファイルの区切りに差し替えられない', async () => {
    const k = newDataKey();
    const a = await encryptBytes(k, 'f_1', bytes(100));
    expect(await decryptBytes(k, 'f_2', a, 100)).toBe(null);
  });
  it('🔴 区切りの順番を入れ替えられない', async () => {
    const k = newDataKey();
    const len = CHUNK * 2;
    const ct = await encryptBytes(k, 'f_1', bytes(len));
    const swapped = concatBytes([ct.subarray(CT_CHUNK), ct.subarray(0, CT_CHUNK)]);
    expect(await decryptBytes(k, 'f_1', swapped, len)).toBe(null);
  });
  it('🔴 1byteでも書き換えられていれば返さない（一部だけ正しいふりをしない）', async () => {
    const k = newDataKey();
    const ct = await encryptBytes(k, 'f_1', bytes(2000));
    ct[100] ^= 0xff;
    expect(await decryptBytes(k, 'f_1', ct, 2000)).toBe(null);
  });
  it('長さが合わない暗号文は受け取らない', async () => {
    const k = newDataKey();
    const ct = await encryptBytes(k, 'f_1', bytes(1000));
    expect(await decryptBytes(k, 'f_1', ct.subarray(0, ct.length - 1), 1000)).toBe(null);
  });
  it('必要な区切りだけを復号しても中身が合う（動画のシーク）', async () => {
    const k = newDataKey();
    const len = CHUNK * 2 + 300;
    const p = bytes(len);
    const ct = await encryptBytes(k, 'f_1', p);
    const want = { start: CHUNK + 10, end: CHUNK + 20 };
    const idx = chunksForRange(want.start, want.end, len);
    expect(idx).toEqual([1]);
    const r = chunkCipherRange(1, len);
    const dec = await decryptChunk(k, 'f_1', 1, ct.subarray(r.start, r.end));
    const off = want.start - idx[0] * CHUNK;
    expect(same(dec.subarray(off, off + 11), p.subarray(want.start, want.end + 1))).toBe(true);
  });
  it('1区切りだけの暗号化・復号', async () => {
    const k = newDataKey();
    const p = bytes(50);
    const c = await encryptChunk(k, 'f_1', 0, p);
    expect(c.length).toBe(50 + IV_LEN + TAG_LEN);
    expect(same(await decryptChunk(k, 'f_1', 0, c), p)).toBe(true);
    expect(await decryptChunk(k, 'f_1', 1, c)).toBe(null);
    expect(await decryptChunk(k, 'f_1', 0, new Uint8Array(3))).toBe(null);
  });
  it('毎回ちがう暗号文になる（同じ平文でも見分けられない）', async () => {
    const k = newDataKey();
    const p = bytes(100);
    expect(toB64(await encryptBytes(k, 'f_1', p))).not.toBe(toB64(await encryptBytes(k, 'f_1', p)));
  });
  it('形式名を持つ（あとで方式を変えられるように）', () => {
    expect(ALG).toBe('A256GCM-CHUNK1M');
  });
});

describe('中身の照合値', () => {
  it('SHA-256 が16進64桁で出る', async () => {
    expect(await sha256Hex(new Uint8Array(0)))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex(new TextEncoder().encode('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('Range ヘッダ（動画の再生・シーク）', () => {
  it('範囲指定が無ければ null', () => {
    expect(parseRange('', 100)).toBe(null);
    expect(parseRange(undefined, 100)).toBe(null);
  });
  it('bytes=0- は先頭から最後まで', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
  });
  it('末尾からの指定も読める', () => {
    expect(parseRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
  });
  it('末尾を越える指定は最後で止める', () => {
    expect(parseRange('bytes=90-999', 100)).toEqual({ start: 90, end: 99 });
  });
  it('🔴 おかしな指定は通さない（416 を返すため）', () => {
    for (const h of ['bytes=100-', 'bytes=50-10', 'bytes=-', 'bytes=abc', 'items=0-10', 'bytes=-0']) {
      expect(parseRange(h, 100), h).toBe('invalid');
    }
  });
});
