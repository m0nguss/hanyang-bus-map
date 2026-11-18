# 한양초 통학버스 노선 지도

https://m0nguss.github.io/hanyang-bus-map/

[한양초등학교 학교버스노선도](https://www.hye.or.kr/?c=A1000/A2000/A2002)의 등교/하교 노선표와 정류장별 네이버 지도 링크를 모아 한 지도에 보여 줍니다.

## 노선 갱신

Node.js 18 이상이 필요합니다.

```bash
node tools/scrape.mjs tools/bus.json   # 학교 사이트에서 노선표를 받고 네이버 링크를 좌표로 바꿈
node tools/build.js                    # tools/template.html + bus.json → index.html
git commit -am "Update routes" && git push
```

- 코스 수는 `scrape.mjs`의 `b <= 15`에 고정돼 있습니다. 코스가 늘면 이 숫자를 고쳐 주세요.
- 네이버 장소 페이지에서 좌표를 못 읽은 정류장은 `scrape.mjs`의 `FALLBACK`에 OSM 좌표를 넣어 둡니다. 지도에는 점선 핀(근사 위치)으로 나옵니다.
- 좌표가 비어 있는 정류장이 있으면 `build.js`가 이름을 출력하고 멈춥니다.
- 사이트 오류처럼 개별 메모가 필요한 정류장은 `template.html`의 `NOTES`에 있습니다. 정류장 순서가 바뀌면 번호를 다시 맞춰 주세요.
