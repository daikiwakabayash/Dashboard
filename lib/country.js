// ── 店舗の国分類（日本 / オーストラリア / マレーシア） ──────────────────
// SalonOne の shops は timezone を持つ（Asia/Tokyo / Australia/Brisbane / Asia/Kuala_Lumpur）。
// これを唯一の一次情報として国コードを判定し、日本タブから海外を除外・海外タブを国別に分けるのに使う。
// timezone が無い場合のみ 住所/店舗名 からフォールバック推定する。tests/country.test.js でカバー。

export const COUNTRIES = ['jp', 'au', 'my'];
export const COUNTRY_LABELS = { jp: '日本', au: 'オーストラリア', my: 'マレーシア' };
export const COUNTRY_SHORT = { jp: '日本', au: '豪州', my: '馬来' };
export const COUNTRY_FLAGS = { jp: '🇯🇵', au: '🇦🇺', my: '🇲🇾' };

// SalonOne の海外 area_id（既存コードと一致させる。timezone が無いフロント店舗オブジェクトでも判定できる強シグナル）。
export const AREA_ID_COUNTRY = { '900000341': 'my', '900000342': 'au' };

// 店舗オブジェクト（{area_id,timezone,address,name,...}）から国コード 'jp'|'au'|'my' を返す。既定は 'jp'。
export function shopCountry(shop) {
  const aid = String((shop && shop.area_id) || '').trim();
  if (AREA_ID_COUNTRY[aid]) return AREA_ID_COUNTRY[aid];   // 海外 area_id は最優先（既存の全体管理シートと同基準）
  const tz = String((shop && (shop.timezone || shop.tz)) || '').trim();
  if (/^Australia\//i.test(tz)) return 'au';
  if (tz === 'Asia/Kuala_Lumpur' || tz === 'Asia/Kuching') return 'my';
  if (tz === 'Asia/Tokyo' || tz === 'Japan') return 'jp';
  // ── timezone が無い/未知のときのフォールバック（住所・店舗名から推定）──
  const s = `${(shop && shop.address) || ''} ${(shop && shop.name) || ''}`;
  if (/Malaysia|Kuala\s*Lumpur|Selangor|Petaling|Damansara|Mont\s*Kiara|Bukit\s*Jalil|Desa\s*Park|Sunway|Jalan/i.test(s)) return 'my';
  if (/Australia|Brisbane|\bQLD\b|\bNSW\b|\bVIC\b|Ascot|Gravatt|Racecourse/i.test(s)) return 'au';
  // 日本語（漢字・かな）を含む住所/名前は日本。判定不能も日本を既定にする（既存挙動＝日本中心）。
  if (/[぀-ヿ㐀-鿿]/.test(s)) return 'jp';
  return 'jp';
}

export function isOverseas(shop) { return shopCountry(shop) !== 'jp'; }

// 国コードの表示ラベル（不明は空）
export function countryLabel(cc) { return COUNTRY_LABELS[cc] || ''; }

// アクセス店舗（配列）から「そのユーザーの主な国」を推定。海外のみのユーザーはその国、混在/日本は 'jp'。
//   海外スタッフ（自国のみ）を自動でその国スコープに寄せるために使う。
export function primaryCountry(shops) {
  const list = Array.isArray(shops) ? shops : [];
  if (!list.length) return 'jp';
  const set = new Set(list.map(shopCountry));
  if (set.size === 1) return [...set][0];      // 単一国のユーザー＝その国
  return set.has('jp') ? 'jp' : [...set][0];   // 混在は日本優先
}
