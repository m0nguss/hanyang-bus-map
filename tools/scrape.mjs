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
  // c = map center "x,y,zoom,...". It is the map view when the link was shared, NOT the pin, so it is the last resort.
  const c = (qs.get("c") || "").split(",");
  const z = +c[2] || null;
  // base62 (0-9a-zA-Z) compact coordinates: value - 2e9 = degrees * 1e7
  const B = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const b62 = s => ([...s].reduce((n, ch) => n * 62 + B.indexOf(ch), 0) - 2e9) / 1e7;
  const isB62 = s => /^[0-9A-Za-z]{5,}$/.test(s || "") && !/^\d+$/.test(s);
  // Exact pins: /address/<x>,<y> (EPSG:3857 meters) and /coordinates/<lng>,<lat> (base62)
  let m = url.match(/\/address\/(\d+\.\d+),(\d+\.\d+)/);
  if (m) { const [lat, lng] = merc2ll(+m[1], +m[2]); return { lat, lng, how: "address", url }; }
  m = url.match(/\/coordinates\/([0-9A-Za-z]+),([0-9A-Za-z]+)/);
  if (m) return { lat: b62(m[2]), lng: b62(m[1]), how: "pin", url };
  if (/\/bus-station\//.test(url)) {
    if (+c[0] > 1000) { const [lat, lng] = merc2ll(+c[0], +c[1]); return { lat, lng, z, how: "busstation", url }; }
    if (isB62(c[0])) return { lat: b62(c[1]), lng: b62(c[0]), z, how: "busstation", url };
  }
  const pid = (url.match(/\/place\/(\d+)/) || [])[1] || qs.get("id");
  if (pid) {
    // Naver throttles after many requests and then serves a page without data: retry with backoff.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 4000 * attempt));
      const h = await (await fetch(`https://m.place.naver.com/place/${pid}/home`, { headers: { "User-Agent": UA } })).text();
      m = h.match(/"coordinate":\{"__typename":"Coordinate","x":"([\d.]+)","y":"([\d.]+)"/);
      if (m) return { lat: +m[2], lng: +m[1], how: "place", url, pid };
      if (!/PlaceDetailBase/.test(h) && attempt === 0) continue;   // throttled shell page
      if (/PlaceDetailBase/.test(h)) break;                          // real page without coordinates
    }
  }
  if (qs.get("lat") && qs.get("lng")) return { lat: +qs.get("lat"), lng: +qs.get("lng"), how: "url", url };
  if (+c[0] > 1000) { const [lat, lng] = merc2ll(+c[0], +c[1]); return { lat, lng, z, how: "center", url }; }
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
for (let i = 0; i < hrefs.length; i += 3) {
  await Promise.all(hrefs.slice(i, i + 3).map(async h => { try { res[h] = await resolve(h); } catch (e) { res[h] = { how: "fail", err: String(e) }; } }));
}
// When Naver throttles a place page, reuse that link's place coordinates from the previous run (places don't move).
let prev = {};
try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
const cache = {};
for (const c of Object.values(prev)) for (const s of [...(c.on || []), ...(c.off || [])])
  if (/^place/.test(s.how) && s.lat) cache[s.href] = [s.lat, s.lng];
let cached = 0;
for (const h of hrefs) if (res[h].how === "fail" && cache[h]) { [res[h].lat, res[h].lng] = cache[h]; res[h].how = "place-cached"; cached++; }
if (cached) console.log(`place pages throttled: reused ${cached} coordinates from the previous ${OUT}`);
// Links whose Naver place no longer exists (the page has no data even when fetched slowly; the landmark is gone
// from Naver search). Positions looked up one at a time on 2026-11-18. `est` = still approximate on the map.
const FALLBACK = {
  // 서울숲동물병원 closed. OSM stop "성원중.성수2가제1동주민센터" across 뚝섬로 from the 등교 stop.
  "성원중학교(서울숲동물병원 앞)": [37.539193, 127.053605],
  // 부산은행 잠실지점 gone. Naver direction point "아시아선수촌아파트정문" (id 18847055).
  "아시아선수촌아파트(부산은행 잠실지점 앞)": [37.509757, 127.078594, "est"],
  // Now "GS25 성동텐즈힐점", 무학로 33 (Naver id 2099423952).
  "왕십리뉴타운텐즈힐1단지(GS편의점 앞)": [37.567844, 127.025941],
  // Now "성동행당새마을금고 응봉지점", 독서당로 381 현대종합상가 (Naver id 1110142864).
  "응봉현대아파트(MG새마을금고 응봉지점 앞)": [37.55028, 127.030919],
};
// Bus-station links only carry the map center. Shared from desktop Naver Map at the default zoom (15, or 14),
// the center sits 97 px west of the station because of the left side panel; shift it back.
// Checked 2026-11-18 against OSM bus stops with the same ARS number: 11 of 11 default-zoom links were 96-99 px west.
const PANEL_SHIFT_PX = 97;
// Default-zoom links that were shared without the panel (raw center already matches the stop).
const NO_SHIFT = new Set(["구의현대2단지 아파트 상가 버스정류장(05163)", "현대 프라임아파트 버스정류장(05724)", "금옥초등학교 앞 공항버스정류장(04787)"]);
// Verified positions (2026-11-18). ARS-numbered stops use the OSM bus stop with that ref.
const OSM_ARS = {"23148":[37.528438,127.030581],"23170":[37.520853,127.056262],"23192":[37.515083,127.060057],"23237":[37.495754,127.066981],"23308":[37.499254,127.051298],"23511":[37.501862,127.067315],"23857":[37.501868,127.066618],"24124":[37.519526,127.109984],"24130":[37.51718,127.10103],"24131":[37.516632,127.1001],"24150":[37.509028,127.091934],"04276":[37.558924,127.023912],"04127":[37.558794,127.040923]};
const OVERRIDE = {
  "성동교남단 버스정류장(04185)": [37.550099, 127.044444],        // OSM stop "성동교남단.서울숲리버포레"
  "광진구청 잎 버스정류장(05175)": [37.539674, 127.082918],       // panel offset at zoom 15.3; puts it on 자양로 at 광진구청
  "뚝섬역 8번출구": [37.547472, 127.046317],                      // site reuses the KB국민은행 서울숲 link; OSM exit 8
};
// Positions that remain uncertain: shown as approximate on the map.
// 한남더힐 119동: not in OSM or Naver search. The shifted center lands ~70 m from Naver's "한남더힐아파트정문" point.
const UNCERTAIN = new Set(["한남더힐아파트 119동 앞 공항버스정류장(03749)"]);
for (const c of Object.values(courses)) for (const s of [...c.on, ...c.off]) {
  const r = res[s.href]; let lat = r.lat, lng = r.lng; s.how = r.how;
  const ars = (s.n.match(/\((\d{5})\)/) || [])[1];
  if (r.how === "busstation" && (r.z === 15 || r.z === 14) && !NO_SHIFT.has(s.n)) {
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** r.z;
    lng += PANEL_SHIFT_PX * mpp / (6378137 * Math.cos(lat * Math.PI / 180)) * 180 / Math.PI; s.how = "busstation-shifted";
  }
  if (r.how === "busstation" && ars && OSM_ARS[ars]) { [lat, lng] = OSM_ARS[ars]; s.how = "osm-ars"; }
  if (OVERRIDE[s.n]) { [lat, lng] = OVERRIDE[s.n]; s.how = "override"; }
  if (s.how === "fail" && FALLBACK[s.n]) { const [a, b, est] = FALLBACK[s.n]; lat = a; lng = b; s.how = est ? "est" : "lookup"; }
  if (UNCERTAIN.has(s.n)) s.how = "est";
  s.lat = lat ? +lat.toFixed(6) : null; s.lng = lng ? +lng.toFixed(6) : null;
}
const fails = hrefs.filter(h => res[h].how === "fail");
console.log("links", hrefs.length, "fails", fails.length, JSON.stringify(fails.map(h => [h, res[h]])));
console.log(JSON.stringify(Object.values(res).reduce((a, r) => (a[r.how] = (a[r.how] || 0) + 1, a), {})));
fs.writeFileSync(OUT, JSON.stringify(courses, null, 1));
