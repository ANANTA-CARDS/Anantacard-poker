// node build.js  ->  dist/poker.html (page.html with engine.js inlined)
const fs = require('fs'), path = require('path');
const P = (...p) => path.join(__dirname, ...p);
const page = fs.readFileSync(P('page.html'), 'utf8'), eng = fs.readFileSync(P('engine.js'), 'utf8');
const out = page.replace('/*ENGINE*/', () => eng);
for (const m of out.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
fs.mkdirSync(P('dist'), { recursive: true });
fs.writeFileSync(P('dist', 'poker.html'), out);
console.log('dist/poker.html', out.length);
