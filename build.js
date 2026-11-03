// node build.js  ->  index.html (page.html with mqtt.js, net.js and engine.js inlined; the page GitHub Pages serves)
const fs = require('fs'), path = require('path');
const P = (...p) => path.join(__dirname, ...p);
const page = fs.readFileSync(P('page.html'), 'utf8');
const mqtt = fs.readFileSync(P('node_modules', 'mqtt', 'dist', 'mqtt.min.js'), 'utf8');
const out = page.replace('/*MQTT*/', () => mqtt).replace('/*NET*/', () => fs.readFileSync(P('net.js'), 'utf8')).replace('/*ENGINE*/', () => fs.readFileSync(P('engine.js'), 'utf8'));
for (const m of out.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
fs.writeFileSync(P('index.html'), out);
console.log('index.html', out.length);
