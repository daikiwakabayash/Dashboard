import { describe, it, expect } from 'vitest';
import { DEFAULT_FLAGS, normalizeFlags, isOn, applyFlagChange, killAll, enabledFeatures, BOOLEAN_FLAGS } from '../lib/ccflags.js';

describe('ccflags - 既定は全機能OFF', () => {
  it('新機能フラグは既定で全て false', () => {
    for (const k of BOOLEAN_FLAGS) {
      if (k === 'cc_all') continue;
      expect(DEFAULT_FLAGS[k]).toBe(false);
    }
  });
  it('未設定・null・配列でも既定へ落ちる（fail closed）', () => {
    for (const bad of [null, undefined, [], 'x', 42]) {
      expect(normalizeFlags(bad).cc_approval).toBe(false);
    }
  });
  it('未知のキーは isOn で常に false', () => {
    expect(isOn({ cc_all: true, evil: true }, 'evil')).toBe(false);
  });
  it('未知のキーは normalize で捨てられる', () => {
    expect(normalizeFlags({ evil: true }).evil).toBeUndefined();
  });
});

describe('ccflags - キルスイッチ', () => {
  it('cc_all=false なら個別がONでも全てOFF', () => {
    const f = { cc_all: false, cc_approval: true, cc_agentlog: true };
    expect(isOn(f, 'cc_approval')).toBe(false);
    expect(isOn(f, 'cc_agentlog')).toBe(false);
    expect(enabledFeatures(f)).toEqual([]);
  });
  it('killAll は個別フラグの値を保持したまま全停止する', () => {
    const f = applyFlagChange(DEFAULT_FLAGS, 'cc_approval', true, { name: 'root' });
    const k = killAll(f, { name: 'root' });
    expect(k.cc_all).toBe(false);
    expect(k.cc_approval).toBe(true);        // 値は残る
    expect(isOn(k, 'cc_approval')).toBe(false); // でも効かない
  });
});

describe('ccflags - 変更', () => {
  it('boolean フラグを更新できる', () => {
    const f = applyFlagChange(DEFAULT_FLAGS, 'cc_approval', true, { name: '若林' });
    expect(f.cc_approval).toBe(true);
    expect(f._updatedBy).toBe('若林');
    expect(f._updatedAt).toBeGreaterThan(0);
  });
  it('型が違う値は拒否する', () => {
    expect(applyFlagChange(DEFAULT_FLAGS, 'cc_approval', 'true', {})).toBeNull();
    expect(applyFlagChange(DEFAULT_FLAGS, 'cc_approval', 1, {})).toBeNull();
  });
  it('未知のキーは作らせない', () => {
    expect(applyFlagChange(DEFAULT_FLAGS, 'cc_evil', true, {})).toBeNull();
  });
  it('列挙型は許可値のみ', () => {
    expect(applyFlagChange(DEFAULT_FLAGS, 'cc_source', 'platform', {}).cc_source).toBe('platform');
    expect(applyFlagChange(DEFAULT_FLAGS, 'cc_source', 'ftp', {})).toBeNull();
    expect(applyFlagChange(DEFAULT_FLAGS, 'cc_authz', 'enforce', {}).cc_authz).toBe('enforce');
    expect(applyFlagChange(DEFAULT_FLAGS, 'cc_authz', 'yolo', {})).toBeNull();
  });
});
