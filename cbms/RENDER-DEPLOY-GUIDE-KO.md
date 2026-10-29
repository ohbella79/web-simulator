# Construction Bid Management System — Render 배포 가이드 (한국어)

이 패키지에는 Render.com 무료 배포에 필요한 설정이 모두 들어 있습니다.

| 파일 | 역할 |
|---|---|
| `render.yaml` | Render Blueprint — 서비스 설정 자동 감지 |
| `Procfile` | 시작 명령(`node server.js`) 정의 |
| `server.js` / `seed.js` | 부팅 시 빈 DB를 자동 생성·시드(`seedIfEmpty()`) — TxDOT 실데이터 기반 데모 자동 복원 |

## 배포 절차 (약 10분)

### 1. 소스를 GitHub에 올리기
1. 첨부된 zip을 PC에서 압축 해제합니다.
2. [github.com](https://github.com) → **New repository** → 이름 예: `construction-bid-mgmt` → Create (Public 권장).
3. **"uploading an existing file"** 링크 클릭 → 압축 해제한 폴더 **안의** 파일·폴더를 모두 드래그해 올립니다.
   - `node_modules`, `data` 폴더는 원래 없음(제외되어 있음) — 그대로 두면 됩니다. Render가 `npm install`로 알아서 설치합니다.
4. **Commit changes** 클릭.

### 2. Render에서 Web Service 만들기
1. [dashboard.render.com](https://dashboard.render.com) 접속 → GitHub 로그인.
2. **New + → Web Service** → 방금 만든 저장소 선택(목록에 없으면 "Configure account"로 권한 허용).
3. **Blueprint 감지** 창이 뜨면 그대로 Apply(설정 자동 적용). 수동 설정 시:
   - Language: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
   - 환경변수: `NODE_VERSION` = `22` (권장)
4. **Create Web Service** → 빌드·배포 로그가 3~5분 진행됩니다(`better-sqlite3` 네이티브 모듈 컴파일 포함).

### 3. 완료 및 공유
- 주소: `https://<서비스명>.onrender.com` — 누구에게나 링크만으로 공유 가능합니다.
- 로그인 없이 바로 열람되는 데모입니다.

## 무료 플랜 동작 방식 (중요)
- **15분간 접속이 없으면 서비스가 잠들고**, 다음 접속 시 첫 화면까지 수십 초 걸릴 수 있습니다(이후 정상 속도).
- 재시작·재배포 때 로컬 DB는 초기화되지만, 서버가 부팅 때 자동 재시드하므로 **TxDOT 실데이터 기반 프로젝트·업체·입찰 데모는 항상 복원**됩니다.
- 단, 데모에서 만든 변경(초대 상태, 평점, 메모 등)은 재시작 시 초기화됩니다.

## 데이터 영속화 (선택 · 유료)
변경 데이터를 재시작 후에도 유지하려면: 유료 인스턴스 + 디스크 마운트가 필요합니다.
`render.yaml`의 `disk:` 주석을 해제하고 `DB_PATH=/var/data/cbms.db` 환경변수를 추가하세요(이 패키지의 서버는 `DB_PATH`를 지원).

## 업데이트 배포
GitHub 레포에서 파일을 다시 업로드(덮어쓰기)·커밋하면 Render가 자동 재배포합니다.

## 문제 해결
- 배포 실패: dashboard → **Events / Logs** 확인 — 대부분 빌드 로그의 의존성 컴파일 오류입니다.
- 앱이 반복 종료: `NODE_VERSION=22` 지정 여부 확인.
- 포트: Render가 자동 할당하며 이 앱은 `process.env.PORT`를 사용 — 별도 설정 불필요.
