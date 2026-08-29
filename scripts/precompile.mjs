// ビルド時にブラウザ内Babelコンパイルを排除して初回表示を高速化する。
// index.html の <script type="text/babel"> をesbuildでJSX→JSに事前変換し、
// プレーンな <script>（DOMContentLoaded後に実行）へ置換。@babel/standalone CDNも除去する。
// Vercelのビルド(npm run build)で実行される。失敗時はビルドが落ちるだけで、
// Vercelは直前の正常デプロイを配信し続けるため本番は壊れない。
import { readFileSync, writeFileSync } from 'fs';
import { transformSync } from 'esbuild';

const FILE = process.argv[2] || 'index.html';
let html = readFileSync(FILE, 'utf8');

const re = /<script type="text\/babel">([\s\S]*?)<\/script>/;
const m = re.exec(html);
if (!m) { console.log('[precompile] no text/babel block found; leaving as-is'); process.exit(0); }

// JSX → JS（構文変換のみ・識別子minifyはしない＝挙動をBabel版と一致させる）
const out = transformSync(m[1], {
  loader: 'jsx',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  target: 'es2019',
  minifyWhitespace: true,   // 空白/コメント除去でサイズ削減（識別子・構文はそのまま）
  legalComments: 'none',
});

// インライン<script>を早期終了させないよう </script> を退避
const code = out.code.replace(/<\/(script)/gi, '<\\/$1');

// deferしたReact/ReactDOMのロード後(DOMContentLoaded)に実行する
const inlined = '<script>\ndocument.addEventListener("DOMContentLoaded",function(){\n' + code + '\n});\n</script>';
html = html.replace(re, inlined);

// @babel/standalone のCDN行を除去（コメント含む）
html = html.replace(/[ \t]*<!--[^\n]*Babel Standalone[^\n]*-->\n/gi, '');
html = html.replace(/[ \t]*<script[^>]*@babel\/standalone[^>]*><\/script>\n/gi, '');

writeFileSync(FILE, html);
console.log(`[precompile] done: ${FILE} (compiled JS ${Math.round(code.length / 1024)}KB, babel-standalone removed)`);
