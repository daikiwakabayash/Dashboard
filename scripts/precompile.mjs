// ビルド時にブラウザ内Babelコンパイルを排除して初回表示を高速化する。
// index.html の <script type="text/babel"> をesbuildでJSX→JSに事前変換し、
// プレーンな <script>（DOMContentLoaded後に実行）へ置換。@babel/standalone CDNも除去。
// 出力は public/（vercel.json の outputDirectory）へ。静的アセットもコピーする。
// Vercelのビルド(buildCommand)で実行。失敗時はビルドが落ちるだけで、Vercelは直前の
// 正常デプロイを配信し続けるため本番は壊れない。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { transformSync } from 'esbuild';

const OUT = 'public';
mkdirSync(OUT, { recursive: true });

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
  html = html.replace(re, inlined);
  html = html.replace(/[ \t]*<!--[^\n]*Babel Standalone[^\n]*-->\n/gi, '');
  html = html.replace(/[ \t]*<script[^>]*@babel\/standalone[^>]*><\/script>\n/gi, '');
  html = html.replace('</head>', '<!--precompiled--></head>');
  console.log(`[precompile] index.html compiled (JS ${Math.round(code.length / 1024)}KB, babel-standalone removed)`);
} else {
  console.log('[precompile] no text/babel block; copying index.html as-is');
}
writeFileSync(`${OUT}/index.html`, html);

// 静的アセットを public/ へコピー（HTMLと画像）
for (const f of ['owner.html', 'logo.png', 'Naoru_landscape.png']) {
  if (existsSync(f)) copyFileSync(f, `${OUT}/${f}`);
}
console.log('[precompile] output ready in public/');
