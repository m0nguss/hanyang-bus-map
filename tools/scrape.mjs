import fs from "node:fs";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const OUT = process.argv[2];

const dec = s => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();
function parse(h) {
  const rows = [];
  for (const tr of h.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const href = (tr.match(/href=["'](https?:[^"']+)["']/i) || [])[1];
    if (!href) continue;
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => dec(m[1]));
    rows.push({ cells, href: href.replace(/&amp;/g, "&") });
  }
  return rows;
}
const merc2ll = (x, y) => [(2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI, x / 6378137 * 180 / Math.PI];
const tm = t => { const [h, m] = t.split(":"); return `${+h}:${m}`; };

async function resolve(href) {
  let url = href;
  for (let i = 0; i < 4 && /naver\.me|share\?id/.test(url); i++) {
    const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA } });
    const loc = r.headers.get("location");
    if (!loc) break;
    url = new URL(loc, url).href;
  }
  const u = new URL(url), qs = u.searchParams;
  if (qs.get("lat") && qs.get("lng")) return { lat: +qs.get("lat"), lng: +qs.get("lng"), how: "url", url };
  const c = (qs.get("c") || "").split(",");
  if (/\/bus-station\//.test(url) && +c[0] > 1000) { const [lat, lng] = merc2ll(+c[0], +c[1]); return { lat, lng, how: "busstation", url }; }
  // /p/entry/coordinates/<lng>,<lat>: base62 (0-9a-zA-Z), value - 2e9 = degrees * 1e7
  const enc = url.match(/\/coordinates\/([0-9A-Za-z]+),([0-9A-Za-z]+)/) || (qs.get("c") || "").match(/^([0-9A-Za-z]{5,}),([0-9A-Za-z]{5,}),/);
  if (enc && !/^\d+(\.\d+)?$/.test(enc[1])) {
    const B = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const d = s => ([...s].reduce((n, ch) => n * 62 + B.indexOf(ch), 0) - 2e9) / 1e7;
    if (!/\/place\//.test(url) || /\/coordinates\//.test(url)) return { lat: d(enc[2]), lng: d(enc[1]), how: "decoded", url };
  }
  const pid = (url.match(/\/place\/(\d+)/) || [])[1] || qs.get("id");
  if (pid) {
    const h = await (await fetch(`https://m.place.naver.com/place/${pid}/home`, { headers: { "User-Agent": UA } })).text();
    const m = h.match(/"coordinate":\{"__typename":"Coordinate","x":"([\d.]+)","y":"([\d.]+)"/);
    if (m) return { lat: +m[2], lng: +m[1], how: "place", url, pid };
  }
  if (+c[0] > 1000) { const [lat, lng] = merc2ll(+c[0], +c[1]); return { lat, lng, how: "c", url }; }
  return { lat: null, lng: null, how: "fail", url };
}

const courses = {};
for (let b = 1; b <= 15; b++) {
  const t = await (await fetch("https://www.hye.or.kr/bus/layouts/process/bus_main_proc.php", {
    method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.hye.or.kr/" },
    body: new URLSearchParams({ buid: b, cuid: 4, isLogin: "", proc: "bus_route_home" }) })).text();
  const p = t.split("^^");
  courses[`${b}코스`] = {
    on: parse(p[1]).map(r => ({ n: r.cells[0], t: tm(r.cells[1]), href: r.href })),
    off: parse(p[2]).map(r => ({ n: r.cells[0], t: r.cells.slice(1, 4).map(tm), href: r.href })),
  };
}
const hrefs = [...new Set(Object.values(courses).flatMap(c => [...c.on, ...c.off].map(s => s.href)))];
const res = {};
for (let i = 0; i < hrefs.length; i += 6) {
  await Promise.all(hrefs.slice(i, i + 6).map(async h => { try { res[h] = await resolve(h); } catch (e) { res[h] = { how: "fail", err: String(e) }; } }));
}
// Naver place pages that don't expose coordinates to a plain fetch: OSM (Nominatim) positions, shown as approximate.
const FALLBACK = {
  "성원중학교(서울숲동물병원 앞)": [37.539263, 127.052267],
  "아시아선수촌아파트(부산은행 잠실지점 앞)": [37.509841, 127.079042],
  "왕십리뉴타운텐즈힐1단지(GS편의점 앞)": [37.568846, 127.024402],
  "응봉현대아파트(MG새마을금고 응봉지점 앞)": [37.551045, 127.031034],
};
for (const c of Object.values(courses)) for (const s of [...c.on, ...c.off]) {
  const r = res[s.href]; s.lat = r.lat ? +r.lat.toFixed(6) : null; s.lng = r.lng ? +r.lng.toFixed(6) : null; s.how = r.how;
  if (s.how === "fail" && FALLBACK[s.n]) { [s.lat, s.lng] = FALLBACK[s.n]; s.how = "est"; }
}
const fails = hrefs.filter(h => res[h].how === "fail");
console.log("links", hrefs.length, "fails", fails.length, JSON.stringify(fails.map(h => [h, res[h]])));
console.log(JSON.stringify(Object.values(res).reduce((a, r) => (a[r.how] = (a[r.how] || 0) + 1, a), {})));
fs.writeFileSync(OUT, JSON.stringify(courses, null, 1));
