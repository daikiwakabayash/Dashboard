// ビルド時にブラウザ内Babelコンパイルを排除して初回表示を高速化する。
// index.html の <script type="text/babel"> をesbuildでJSX→JSに事前変換し、
// プレーンな <script>（DOMContentLoaded後に実行）へ置換。@babel/standalone CDNも除去。
// さらに Tailwind をビルド時にCSS化（cdn.tailwindcss.com のブラウザ内JITを排除）。
// 出力は public/（vercel.json の outputDirectory）へ。静的アセットもコピーする。
// Vercelのビルド(buildCommand)で実行。失敗時はビルドが落ちるだけで、Vercelは直前の
// 正常デプロイを配信し続けるため本番は壊れない。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { transformSync } from 'esbuild';

const OUT = 'public';
mkdirSync(OUT, { recursive: true });

// ── Tailwind を事前ビルド（失敗しても Play CDN のまま動くようフォールバック） ──
let tailwindOk = false;
try {
  execSync(`npx tailwindcss -c tailwind.config.js -i styles/tailwind.css -o ${OUT}/tailwind.css --minify`, { stdio: 'inherit' });
  if (existsSync(`${OUT}/tailwind.css`) && readFileSync(`${OUT}/tailwind.css`, 'utf8').length > 1000) {
    tailwindOk = true;
    console.log(`[precompile] tailwind.css built (${Math.round(readFileSync(`${OUT}/tailwind.css`, 'utf8').length / 1024)}KB)`);
  }
} catch (e) {
  console.warn('[precompile] tailwind build failed; keeping Play CDN fallback:', (e && e.message) || e);
}

// Play CDN の <script src="cdn.tailwindcss.com"> と直後の inline tailwind.config を
// 事前ビルドCSSへの <link> に置換。tailwindOk のときだけ実行。
function swapTailwind(html) {
  if (!tailwindOk) return html;
  html = html.replace(/[ \t]*<script>\s*tailwind\.config[\s\S]*?<\/script>\n?/, '');
  html = html.replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/, '<link rel="stylesheet" href="/tailwind.css">');
  return html;
}

// ── index.html: JSX事前変換 + Tailwind差し替え ──
let html = readFileSync('index.html', 'utf8');
const re = /<script type="text\/babel">([\s\S]*?)<\/script>/;
const m = re.exec(html);
if (m) {
  const out = transformSync(m[1], {
    loader: 'jsx',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    target: 'es2019',
    charset: 'utf8',          // 日本語を\uXXXXにエスケープせずUTF-8のまま出力（サイズ削減・可読性）
    minifyWhitespace: true,   // 空白/コメント除去のみ（識別子・構文は保持＝挙動一致）
    legalComments: 'none',
  });
  const code = out.code.replace(/<\/(script)/gi, '<\\/$1'); // インライン<script>の早期終了防止
  const inlined = '<script>\ndocument.addEventListener("DOMContentLoaded",function(){\n' + code + '\n});\n</script>';
  // ⚠️ 置換文字列に $& / $1 等が含まれると String.replace が特殊パターンとして展開してしまう
  //    （コード中の /.../.replace(re,'\\$&') 等が壊れる）。関数リプレーサで $ を無害化する。
  html = html.replace(re, () => inlined);
  html = html.replace(/[ \t]*<!--[^\n]*Babel Standalone[^\n]*-->\n/gi, '');
  html = html.replace(/[ \t]*<script[^>]*@babel\/standalone[^>]*><\/script>\n/gi, '');
  html = html.replace('</head>', '<!--precompiled--></head>');
  console.log(`[precompile] index.html compiled (JS ${Math.round(code.length / 1024)}KB, babel-standalone removed)`);
} else {
  console.log('[precompile] no text/babel block; copying index.html as-is');
}
html = swapTailwind(html);
writeFileSync(`${OUT}/index.html`, html);

// ── owner.html: Tailwind差し替えのみ（JSXなし） ──
if (existsSync('owner.html')) {
  const owner = swapTailwind(readFileSync('owner.html', 'utf8'));
  writeFileSync(`${OUT}/owner.html`, owner);
}

// 静的アセットを public/ へコピー（画像・PWA）。owner.html は上で処理済みなので除外。
for (const f of ['logo.png', 'Naoru_landscape.png', 'mascot.png', 'naoru_heart.png',
  'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png']) {
  if (existsSync(f)) copyFileSync(f, `${OUT}/${f}`);
}
console.log('[precompile] output ready in public/');
