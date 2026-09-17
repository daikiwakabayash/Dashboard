// ── Command Center フィーチャーフラグ ───────────────────────────────
// 新機能のON/OFFを「環境変数ではなくKV」で持つ。理由:
//   ・Vercelの環境変数はビルド時注入のため、値を変えても再デプロイしないと反映されない
//     （＝Instant Rollbackにならない）。
//   ・本番Environment Variablesを触らずに運用側で止められる必要がある。
// 保存先は plan-store の共有ストア（?type=ccflags / キー naoru:cc:flags:v1）。
//
// 安全既定（重要）:
//   ・未知のキー・未設定・ストア障害 → すべて false（fail closed）。
//   ・cc_all=false は キルスイッチ。個別フラグの値に関わらず全新機能を止める。
//   ・既存機能はこのフラグを一切参照しない（＝フラグが壊れても既存は動く）。

export const FLAGS_KEY = 'naoru:cc:flags:v1';

// 既定値。**全新機能は false（OFF）から始める。**
// cc_all だけ true（キルスイッチは「引かれていない」状態が既定）。
export const DEFAULT_FLAGS = Object.freeze({
  cc_all: true,              // キルスイッチ: false で全新機能を即停止
  cc_approval: false,        // 承認センター
  cc_agentlog: false,        // AI Agent Activity
  cc_meta_overview: false,   // Meta Overview
  cc_meta_alerts: false,     // Meta Alert
  cc_meta_reco: false,       // AI Recommendation
  cc_creative_library: false,// Creative Library
  cc_autopilot: false,       // Autopilot Settings
  cc_source: 'local',        // 'local' | 'platform'（データ源の切替）
  cc_authz: 'off',           // 'off' | 'log' | 'warn' | 'enforce'（認可の段階導入）
});

// boolean フラグのキー（cc_all を含む）
export const BOOLEAN_FLAGS = Object.freeze(
  Object.keys(DEFAULT_FLAGS).filter(k => typeof DEFAULT_FLAGS[k] === 'boolean')
);

export const SOURCE_VALUES = Object.freeze(['local', 'platform']);
export const AUTHZ_VALUES = Object.freeze(['off', 'log', 'warn', 'enforce']);

// 保存済みの値を既定へマージし、型を矯正する。
// 未知キーは捨てる（＝ストアに何が入っていても想定外のフラグは生えない）。
export function normalizeFlags(raw) {
  const out = { ...DEFAULT_FLAGS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of BOOLEAN_FLAGS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  if (SOURCE_VALUES.includes(raw.cc_source)) out.cc_source = raw.cc_source;
  if (AUTHZ_VALUES.includes(raw.cc_authz)) out.cc_authz = raw.cc_authz;
  if (typeof raw._updatedAt === 'number' && raw._updatedAt > 0) out._updatedAt = raw._updatedAt;
  if (typeof raw._updatedBy === 'string' && raw._updatedBy) out._updatedBy = String(raw._updatedBy).slice(0, 80);
  return out;
}

// 機能が有効か。キルスイッチと fail closed をここに集約する。
export function isOn(flags, key) {
  const f = normalizeFlags(flags);
  if (f.cc_all === false) return false;        // キルスイッチ
  if (key === 'cc_all') return f.cc_all === true;
  if (!BOOLEAN_FLAGS.includes(key)) return false; // 未知キーは常にOFF
  return f[key] === true;
}

// 1つのフラグを更新した結果を返す（呼び出し側が保存する）。
// 戻り値 null = 不正な指定（＝保存しない）。
export function applyFlagChange(current, key, value, actor) {
  const f = normalizeFlags(current);
  if (BOOLEAN_FLAGS.includes(key)) {
    if (typeof value !== 'boolean') return null;
    f[key] = value;
  } else if (key === 'cc_source') {
    if (!SOURCE_VALUES.includes(value)) return null;
    f.cc_source = value;
  } else if (key === 'cc_authz') {
    if (!AUTHZ_VALUES.includes(value)) return null;
    f.cc_authz = value;
  } else {
    return null;                                // 未知キーは作らせない
  }
  f._updatedAt = Date.now();
  f._updatedBy = String((actor && (actor.name || actor.id)) || '').slice(0, 80);
  return f;
}

// キルスイッチを引いた状態（個別フラグの値は保持したまま全停止）。
export function killAll(current, actor) {
  return applyFlagChange(current, 'cc_all', false, actor);
}

// 現在ONになっている機能フラグ名（cc_all を除く）。監査ログ・表示用。
export function enabledFeatures(flags) {
  const f = normalizeFlags(flags);
  if (f.cc_all === false) return [];
  return BOOLEAN_FLAGS.filter(k => k !== 'cc_all' && f[k] === true);
}
