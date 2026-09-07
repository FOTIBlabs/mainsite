# FOTIB Labs

Flow → Observe → Tune → Iterate → Balance — 자연스러운 성장의 순환을 기록하는 퍼스널 브랜드 사이트.

## 구조

```
index.html    실제 사이트 (단일 파일, CSS/JS 인라인)
favicon.svg   브랜드 오브 모티프를 축소한 파비콘
robots.txt    검색엔진 크롤링 허용
```

빌드 과정이 필요 없는 순수 정적 사이트입니다. `index.html`을 여는 것만으로 로컬에서도 그대로 보입니다.

## 배포 (Cloudflare Pages)

1. 이 저장소를 GitHub에 올린다.
2. Cloudflare 대시보드 → **Workers & Pages → Create → Pages → Connect to Git** 에서 이 저장소를 선택한다.
3. 빌드 설정은 비워둔다 (Build command 없음, Build output directory는 `/`).
4. 배포 후 **Custom domains** 탭에서 `fotiblabs.com` (필요하면 `www.fotiblabs.com`도) 을 추가한다.

## 다음에 채울 것

- 연락처 / 소셜 링크 (`footer-contact`, 현재 "준비 중" 상태)
- LOG_01, LOG_02 각 작업의 실제 상세 링크
- 새 작업이 생기면 `works` 섹션에 `log-entry` 블록을 추가하고, 고스트 카드(LOG_03)는 뒤로 밀기
