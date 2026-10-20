# 📋 국회의원 출석부

22대 국회의원의 본회의 표결 참여(출석) 현황을 보여주는 사이트입니다.
국회 열린국회정보 Open API 데이터를 GitHub Actions가 매일 새벽 6시에 자동으로 받아옵니다.

## 동작 방식

```
GitHub Actions (매일 06:00) ── 인증키(Secret) ──▶ 국회 Open API
        │
        ▼
data/attendance.json 커밋 ──▶ GitHub Pages (index.html)가 읽어서 표시
```

- 방문자는 국회 API를 직접 부르지 않습니다. 인증키가 공개되지 않고 페이지도 빠르게 열립니다.
- 이미 받은 표결 기록은 다시 받지 않고 새로 생긴 표결만 추가합니다.

## 설치 방법

1. GitHub에서 새 저장소를 만듭니다 (예: `assembly-attendance`, Public).
2. 이 폴더의 파일을 모두 올립니다. `.github/workflows/update.yml` 파일도 꼭 포함해야 합니다.
3. **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `ASSEMBLY_KEY`
   - Secret: 열린국회정보 인증키
4. **Settings → Actions → General → Workflow permissions** 에서 *Read and write permissions* 를 선택합니다.
5. **Actions 탭 → "출석 데이터 갱신" → Run workflow** 로 처음 한 번 실행합니다. 첫 실행은 표결 기록 전체를 받으므로 10~30분쯤 걸립니다.
6. **Settings → Pages → Source: Deploy from a branch → main / (root)** 로 저장합니다.
7. 잠시 뒤 `https://<아이디>.github.io/assembly-attendance/` 에서 사이트가 열립니다.

## 내 컴퓨터에서 데이터 받기 (선택)

GitHub Actions가 국회 서버에 접속하지 못할 때 쓰는 방법입니다.

```bash
ASSEMBLY_KEY=인증키 node scripts/fetch.mjs   # Node.js 18 이상
git add data/attendance.json && git commit -m "데이터 갱신" && git push
```

## 데이터 해석 주의

- 국회는 의원별 출석부를 Open API로 공개하지 않습니다. 본회의 전자표결 기록(찬성·반대·기권·불참)으로 출석을 추정합니다.
- **참여율**: 재적 중이던 표결 가운데 불참이 아닌 비율입니다.
- **출석일**: 표결이 있었던 본회의 날짜 중 한 건 이상 표결한 날입니다.
- 청가·공무출장 같은 불참 사유는 구분되지 않습니다. 국회의장은 관례상 표결하지 않습니다.
- 특정 의원을 바로 열려면 주소 뒤에 `#의원이름` 을 붙입니다 (예: `.../#고민정`).

## 사용 API

| 서비스 코드 | 내용 |
|---|---|
| `nwvrqwxyaytdsfvhu` | 국회의원 인적사항 (정당·지역구·상임위) |
| `nwbpacrgavhjryiph` | 본회의 표결 의안 목록 |
| `nojepdqqaweusdfbi` | 의안별 의원 표결 결과 |
