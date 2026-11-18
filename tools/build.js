// Builds ../index.html from template.html + bus.json.
// Usage: node tools/build.js [YYYY-MM-DD]   (date shown in the footer, default today)
const fs = require("fs"), path = require("path");
const d = JSON.parse(fs.readFileSync(path.join(__dirname, "bus.json"), "utf8"));
const r6 = x => +(+x).toFixed(6);
const out = { school: [37.557647, 127.050332], courses: {} };
for (const [c, v] of Object.entries(d)) out.courses[c] = Object.fromEntries(["on", "off"].map(k => [k, v[k].map(s => {
  const o = { n: s.n, t: s.t, lat: r6(s.lat), lng: r6(s.lng), u: s.href }; if (s.how === "est") o.est = 1; return o; })]));
const missing = Object.entries(d).flatMap(([c, v]) => [...v.on, ...v.off].filter(s => s.lat == null).map(s => `${c} ${s.n}`));
if (missing.length) { console.error("좌표 없는 정류장:", missing); process.exit(1); }
const asof = process.argv[2] || new Date().toISOString().slice(0, 10);
const html = fs.readFileSync(path.join(__dirname, "template.html"), "utf8").replace("__DATA__", JSON.stringify(out)).replace("__ASOF__", asof);
fs.writeFileSync(path.join(__dirname, "..", "index.html"), html);
console.log("index.html", html.length, "bytes");
