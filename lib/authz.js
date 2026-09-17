// ── サーバー側 認可（Authorization）──────────────────────────────
// 「誰が・何に対して・何をしてよいか」を1箇所に集約する。
//
// 設計の要点:
//  1. **既定拒否（default deny）**。表にない組み合わせは必ず拒否。
//  2. **AIエージェントは人間の承認者になれない**。role が root でも、
//     principal が agent なら承認系は全て拒否する（naoru-ai-platform/AGENTS.md §5）。
//  3. **止める方向は緩く、解除する方向は厳しく**。キルスイッチは owner/manager でも
//     引けるが、解除できるのは root/admin だけ。事故のとき誰も止められない状況を作らない。
//  4. **段階導入**。mode='off'→'log'→'warn'→'enforce' の順に上げる。
//     off/log/warn は拒否しない（＝既存の動きを一切変えない）。
//  5. ここは**純粋な判定だけ**。誰であるかの確定（トークン検証）は resolveActor 側の責務。

// ── 役割 ──
// 既存ダッシュボードの role（root/hq/owner/staff）を含みつつ、admin/manager を追加する。
// 'hq' は 'admin' の別名として受理する（既存アカウントを作り直さないため）。
export const ROLES = Object.freeze({
  root:    { label: '管理者',     rank: 100, scoped: false },  // 共有PASS・全権
  admin:   { label: '本部',       rank: 90,  scoped: false },  // 個人名の本部アカウント（旧 hq）
  owner:   { label: 'オーナー',   rank: 60,  scoped: true  },  // 管轄店舗のみ
  manager: { label: 'マネージャー', rank: 40, scoped: true  },  // 所属店舗のみ
  staff:   { label: 'スタッフ',   rank: 20,  scoped: true  },  // 本人と所属店舗のみ
  guest:   { label: '未認証',     rank: 0,   scoped: true  },
});

// 'hq' / 'headquarters' は 'admin'（本部）の別名。既存アカウントを作り直さずに済ませるため。
export const ROLE_ALIASES = Object.freeze({
  hq: 'admin', headquarters: 'admin', 本部: 'admin',
  brand_admin: 'root', shop_admin: 'owner', shop_staff: 'staff',
});

// ── 主体の種別（role とは独立）──
// 同じ role を名乗っていても、人間か・cronか・AIかで許せることが違う。
export const SOURCES = Object.freeze(['ui', 'api', 'cron', 'agent', 'system']);

// テナント。既定は 'naoru'（＝現在の単一テナント）。ホワイトラベル提供時にここが分かれる。
export const DEFAULT_TENANT = 'naoru';

// テナントIDは大小文字を無視して比較する。'ClientX' と 'clientx' が
// 別テナント扱いになると、同じ会社のデータが分断される／逆に越境判定をすり抜ける。
function normTenant(v) {
  const s = String(v == null || v === '' ? DEFAULT_TENANT : v).trim().toLowerCase();
  return s.slice(0, 64) || DEFAULT_TENANT;
}

export function normalizeActor(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  let role = String(a.role || '').trim();
  if (ROLE_ALIASES[role]) role = ROLE_ALIASES[role];
  if (!ROLES[role]) role = 'guest';
  const source = SOURCES.includes(a.source) ? a.source : 'ui';
  return {
    id: String(a.id || '').slice(0, 60),
    name: String(a.name || '').slice(0, 80),
    role,
    source,
    shops: Array.isArray(a.shops) ? a.shops.map(s => String(s)).slice(0, 500) : null, // null = 全店
    tenantId: normTenant(a.tenantId),                // マルチテナント/ホワイトラベル用（大小文字を無視して比較）
    verified: a.verified === true,   // トークン検証を通ったか（resolveActor が立てる）
  };
}

export const isAgent = (actor) => normalizeActor(actor).source === 'agent';
export const isHuman = (actor) => ['ui', 'api'].includes(normalizeActor(actor).source);
export const roleRank = (actor) => (ROLES[normalizeActor(actor).role] || ROLES.guest).rank;

// ── 操作の定義 ──
// minRank       … この位以上の役割が必要
// humanOnly     … AIエージェント・cron は不可（承認系）
// agentAllowed  … エージェントに明示的に許す（提案の作成など）
// scoped        … 対象店舗が actor の管轄内であることを要求
// riskGated     … 対象の risk によって必要な役割が上がる
export const ACTIONS = Object.freeze({
  'approval.create':   { minRank: 20, humanOnly: false, agentAllowed: true,  scoped: true  },
  'approval.approve':  { minRank: 40, humanOnly: true,  agentAllowed: false, scoped: true, riskGated: true },
  'approval.reject':   { minRank: 40, humanOnly: true,  agentAllowed: false, scoped: true, riskGated: true },
  'approval.request_changes': { minRank: 40, humanOnly: true, agentAllowed: false, scoped: true },
  'approval.read':     { minRank: 20, humanOnly: false, agentAllowed: true,  scoped: true  },
  'approval.execute':  { minRank: 90, humanOnly: false, agentAllowed: true,  scoped: true  }, // 承認済みの実行のみ

  'flag.read':         { minRank: 0,  humanOnly: false, agentAllowed: true,  scoped: false },
  'flag.change':       { minRank: 90, humanOnly: true,  agentAllowed: false, scoped: false },
  'killswitch.engage': { minRank: 40, humanOnly: true,  agentAllowed: false, scoped: false }, // 止めるのは緩く
  'killswitch.release':{ minRank: 90, humanOnly: true,  agentAllowed: false, scoped: false }, // 解除は厳しく

  'agentlog.read':     { minRank: 40, humanOnly: false, agentAllowed: false, scoped: true  },
  'agentlog.write':    { minRank: 20, humanOnly: false, agentAllowed: true,  scoped: true  },
  'audit.read':        { minRank: 90, humanOnly: true,  agentAllowed: false, scoped: false }, // 全社横断の情報を含む
  'audit.write':       { minRank: 0,  humanOnly: false, agentAllowed: true,  scoped: false }, // 追記は誰の操作でも残す

  // ── チャット（staff/owner へ開放するために server-side で制御する） ──
  'chat.send':          { minRank: 20, humanOnly: false, agentAllowed: true,  scoped: true  },
  'chat.dm':            { minRank: 20, humanOnly: false, agentAllowed: false, scoped: false },
  'chat.group_create':  { minRank: 20, humanOnly: false, agentAllowed: false, scoped: true  },
  'chat.member_add':    { minRank: 40, humanOnly: false, agentAllowed: false, scoped: true  },
  'chat.member_remove': { minRank: 40, humanOnly: false, agentAllowed: false, scoped: true  },
  'chat.broadcast':     { minRank: 60, humanOnly: false, agentAllowed: false, scoped: true, maxRecipients: 200 },
  'chat.broadcast_all': { minRank: 90, humanOnly: false, agentAllowed: false, scoped: false },
  'chat.schedule':      { minRank: 40, humanOnly: false, agentAllowed: false, scoped: true  },
  'chat.resend_unread': { minRank: 40, humanOnly: false, agentAllowed: false, scoped: true  },
  'chat.room_archive':  { minRank: 60, humanOnly: true,  agentAllowed: false, scoped: true  },

  // 将来の外向き操作。いずれも「承認済みであること」を別途 requireApproval で要求する。
  'meta.budget_change':{ minRank: 60, humanOnly: false, agentAllowed: true,  scoped: true,  requiresApproval: true },
  'meta.pause':        { minRank: 60, humanOnly: false, agentAllowed: true,  scoped: true,  requiresApproval: true },
  'meta.resume':       { minRank: 60, humanOnly: false, agentAllowed: true,  scoped: true,  requiresApproval: true },
  'meta.creative_replace': { minRank: 60, humanOnly: false, agentAllowed: true, scoped: true, requiresApproval: true },
  'sns.post':          { minRank: 90, humanOnly: false, agentAllowed: false, scoped: false, requiresApproval: true },
  'lp.change':         { minRank: 90, humanOnly: false, agentAllowed: false, scoped: false, requiresApproval: true },
  'knowledge.publish': { minRank: 90, humanOnly: false, agentAllowed: false, scoped: false, requiresApproval: true },
});

// ── Bearer 検証キャッシュを使ってはいけない操作 ──
// トークンを失効させても最大60秒は有効に見えてしまうため、
// 「取り返しがつかない操作」だけは毎回上流へ問い合わせて確かめる。
export const REVERIFY_ACTIONS = Object.freeze([
  'approval.approve', 'approval.execute',
  'flag.change', 'killswitch.release',
  'meta.budget_change', 'meta.pause', 'meta.resume', 'meta.creative_replace',
  'sns.post', 'lp.change', 'knowledge.publish',
  'chat.broadcast_all',
]);
export function needsReverify(action) { return REVERIFY_ACTIONS.includes(String(action)); }

// リスク別に必要な役割を引き上げる（高リスクは本部以上しか承認できない）
export const RISK_MIN_RANK = Object.freeze({ low: 40, medium: 60, high: 90 });

// 店舗スコープの判定。actor.shops が null なら全店。
// 既存の店舗フィルタと同じく「部分一致」で判定する（アカウントには店舗名の一部が入る運用のため）。
export function inScope(actor, shop) {
  const a = normalizeActor(actor);
  if (!ROLES[a.role].scoped) return true;      // root / admin は全店
  if (!shop) return true;                       // 対象店舗が無い操作（全社設定など）はスコープ判定しない
  if (!Array.isArray(a.shops)) return false;    // 店舗限定の役割なのに一覧が無い＝拒否
  const s = String(shop);
  return a.shops.some(p => p && (s.includes(String(p)) || String(p).includes(s)));
}

// ── 判定本体 ──
// 戻り値 { allow, reason, code }
export function can(actor, action, target) {
  const a = normalizeActor(actor);
  const t = (target && typeof target === 'object') ? target : {};
  const spec = ACTIONS[action];
  if (!spec) return deny('unknown_action', `未定義の操作です: ${action}`);

  // 1) 未認証は読み取りすら通さない（flag.read だけは例外＝画面を描くのに必要）
  if (!a.verified && action !== 'flag.read') return deny('unauthenticated', '認証が必要です');

  // 2) テナント越境（ホワイトラベル提供時にここが効く）
  if (t.tenantId && normTenant(t.tenantId) !== a.tenantId) {
    return deny('cross_tenant', '別テナントのデータは操作できません');
  }

  // 3) AIエージェントの禁止（最優先。role では回避できない）
  if (a.source === 'agent') {
    if (spec.humanOnly) return deny('agent_forbidden', 'AIエージェントはこの操作を行えません（人の判断が必要です）');
    if (!spec.agentAllowed) return deny('agent_forbidden', 'AIエージェントにはこの操作が許可されていません');
  }
  // 4) cron は承認・設定変更を行えない
  if (a.source === 'cron' && (spec.humanOnly || spec.requiresApproval)) {
    return deny('cron_forbidden', '定期実行からはこの操作を行えません');
  }

  // 5) 役割の高さ
  let need = spec.minRank;
  if (spec.riskGated) {
    const risk = ['low', 'medium', 'high'].includes(t.risk) ? t.risk : 'medium';
    need = Math.max(need, RISK_MIN_RANK[risk]);
  }
  if (roleRank(a) < need) {
    return deny('role_too_low', `この操作には${labelForRank(need)}以上の権限が必要です`);
  }

  // 6) 店舗スコープ
  if (spec.scoped && !inScope(a, t.shop)) {
    return deny('out_of_scope', 'この店舗を操作する権限がありません');
  }

  // 7) 作成者と承認者の分離（高リスクのみ）
  if ((action === 'approval.approve') && t.risk === 'high' && t.proposedByActorId
      && String(t.proposedByActorId) === String(a.id)) {
    return deny('self_approval_forbidden', '高リスクの提案は、提案者本人が承認できません');
  }

  // 8) 一斉送信の宛先数の上限（誤爆の歯止め）
  const spec2 = ACTIONS[action];
  if (spec2.maxRecipients && Number(t.recipientCount) > spec2.maxRecipients && roleRank(a) < ROLES.admin.rank) {
    return deny('too_many_recipients', `一度に送れるのは${spec2.maxRecipients}件までです（本部の承認が必要）`);
  }

  // 9) 外向き操作は承認済みであることを要求
  if (spec.requiresApproval && t.approvalStatus !== 'approved') {
    return deny('approval_required', 'この操作には承認が必要です');
  }

  return { allow: true, reason: '', code: '' };
}

const deny = (code, reason) => ({ allow: false, code, reason });
function labelForRank(rank) {
  const hit = Object.values(ROLES).filter(r => r.rank >= rank).sort((x, y) => x.rank - y.rank)[0];
  return hit ? hit.label : '管理者';
}

// ── 段階導入 ──
// mode: 'off' | 'log' | 'warn' | 'enforce'
// 'off'/'log'/'warn' は **決してブロックしない**（既存の動きを変えないため）。
export function enforce(mode, decision) {
  const m = ['off', 'log', 'warn', 'enforce'].includes(mode) ? mode : 'off';
  const allowed = !!(decision && decision.allow);
  return {
    mode: m,
    allowed,
    blocked: m === 'enforce' && !allowed,
    shouldLog: m !== 'off' && !allowed,
    shouldWarn: (m === 'warn' || m === 'enforce') && !allowed,
    code: (decision && decision.code) || '',
    reason: (decision && decision.reason) || '',
  };
}

// 便宜関数: 判定 → 段階適用をまとめて行う
export function check(actor, action, target, mode) {
  return enforce(mode, can(actor, action, target));
}


// ── 監査ログ用の1行 ──
// log モードでは **ALLOW も DENY も** 記録する。
// 「本来どちらになるはずか」を貯めてから enforce に上げるのが目的なので、
// 拒否だけを見ていると「正しく通っていた量」が分からない。
export function decisionRecord(actor, action, target, decision, mode) {
  const a = normalizeActor(actor);
  const t = (target && typeof target === 'object') ? target : {};
  return {
    mode,
    actorId: a.id, actorName: a.name, role: a.role, source: a.source,
    tenantId: a.tenantId,
    verified: a.verified,
    shop: String(t.shop || ''),
    action: String(action),
    decision: decision && decision.allow ? 'ALLOW' : 'DENY',
    code: (decision && decision.code) || '',
    reason: (decision && decision.reason) || '',
  };
}
