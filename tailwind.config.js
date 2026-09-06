/** Tailwind 設定（ビルド時にCSSを事前生成 → cdn.tailwindcss.com のブラウザ内JITを排除して初回表示を高速化）
 *  content: index.html / owner.html のソース（className文字列リテラルを全て走査）。
 *  safelist: `bg-${x.color}-500` のように文字列補間で動的生成されるクラスは静的走査で拾えないため、
 *            色×シェード×ユーティリティのパターンを明示的に含める。
 *  ⚠️ 見た目を Play CDN と一致させるため theme.extend は index.html 内の tailwind.config と同一に保つ。
 */
// 文字列補間 `${x.color}` で動的にクラス名を作っている色ファミリのみ（静的走査で拾えないため safelist で明示）。
// 実データの color 値: amber/blue/cyan/emerald/orange/pink/purple/red/rose/slate/teal + brand。
// 予備で近縁の green/indigo/sky/violet/gray も含める。変種(hover等)付きの動的生成は無いため base のみ。
const DYNAMIC_COLOR_FAMILIES = [
  'slate', 'gray', 'red', 'orange', 'amber', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'pink', 'rose', 'brand',
];

export default {
  content: ['./index.html', './owner.html'],
  safelist: [
    {
      pattern: new RegExp(`^(bg|text|border|ring|from|to|via)-(${DYNAMIC_COLOR_FAMILIES.join('|')})-(50|100|200|300|400|500|600|700|800|900)$`),
    },
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#FFF4EE', 100: '#FFE4D6', 200: '#FFC4A8', 300: '#FF9D70', 400: '#FF6B35',
          500: '#E53F03', 600: '#C43000', 700: '#9A2600', 800: '#6F1C00', 900: '#451200',
        },
        // セカンダリ（高級感の効いた深いネイビー）。オレンジ(brand)と対に使う構造色。
        ink: {
          50: '#F4F6FB', 100: '#E6EAF3', 200: '#CAD3E5', 300: '#9FAFCB', 400: '#6B80A6',
          500: '#455680', 600: '#334364', 700: '#26334E', 800: '#1B2539', 900: '#111827',
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out both',
        'fade-in-up': 'fadeInUp 0.5s ease-out both',
        'slide-in-left': 'slideInLeft 0.4s ease-out both',
        'slide-in-right': 'slideInRight 0.4s ease-out both',
        'scale-in': 'scaleIn 0.3s ease-out both',
        'shimmer': 'shimmer 2s linear infinite',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        'float': 'float 3s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        fadeInUp: { from: { opacity: '0', transform: 'translateY(16px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        slideInLeft: { from: { opacity: '0', transform: 'translateX(-16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        slideInRight: { from: { opacity: '0', transform: 'translateX(16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        scaleIn: { from: { opacity: '0', transform: 'scale(0.95)' }, to: { opacity: '1', transform: 'scale(1)' } },
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        pulseGlow: { '0%, 100%': { boxShadow: '0 0 0 0 rgba(229, 63, 3, 0)' }, '50%': { boxShadow: '0 0 20px 4px rgba(229, 63, 3, 0.15)' } },
        float: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-6px)' } },
      },
    },
  },
};
