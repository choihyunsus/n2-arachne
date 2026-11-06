# Arachne 5.0

AI 에이전트가 필요한 소스와 문서를 검색하고 작업 문맥을 조립하는 모듈입니다. 배포판 Soul과 같은 SQLite 파일을 사용하며 프로젝트와 에이전트별로 데이터를 구분합니다.

[English](README.md) · [日本語](README.ja.md)

## 설치

Node.js 20.19 이상을 사용하세요. GitHub 릴리스의 `n2-arachne-5.0.0.tgz`를 도구 전용 폴더에 내려받아 설치합니다. 이번 버전의 배포 경로는 GitHub입니다. 다른 레지스트리에서는 설치 버전을 확인하세요.

```sh
npm install ./n2-arachne-5.0.0.tgz
node node_modules/n2-arachne/dist/index.js --version
```

Windows x64 문서 파서가 포함됩니다. 다른 운영체제는 Rust 1.98과 해당 플랫폼 링커를 준비한 뒤 패키지 폴더에서 `npm run build:documents`를 실행하세요. 소스 체크아웃은 `npm ci`, `npm run build:documents`, `npm run build` 순으로 준비합니다.

## MCP 연결

경로를 실제 설치 위치로 바꾸어 MCP 클라이언트에 등록합니다.

```json
{
  "mcpServers": {
    "arachne": {
      "command": "node",
      "args": ["C:/tools/node_modules/n2-arachne/dist/index.js"],
      "env": {
        "N2_CONTEXT_PROJECT_DIR": "C:/projects/example",
        "N2_CONTEXT_DATA_DIR": "C:/state/example-arachne",
        "N2_CONTEXT_DB_PATH": "C:/state/soul/mimir.db",
        "N2_PROJECT": "example",
        "N2_AGENT_NAME": "assistant"
      }
    }
  }
}
```

프로젝트·에이전트 이름은 계속 같은 값으로 사용하세요. 한 소유자 조합은 하나의 정규화된 소스 루트에 연결됩니다. 다른 루트를 같은 조합에 연결하면 오류를 반환합니다. 자동 색인과 임베딩 점검은 MCP 연결 후 진행되며 `status`로 확인합니다. 색인 중 검색과 문맥 조립은 완료 후 재시도를 안내합니다. 부분 처리와 중단 기록은 재시작한 뒤에도 표시됩니다.

## 기능

`n2_arachne` 도구의 `action`으로 실행합니다.

| 작업 | 기능 | 주요 인자 |
| --- | --- | --- |
| `index` | 전체 또는 하위 경로 증분 색인 | `path`, `force` |
| `search` | 키워드·백업 검색 | `query`, `topK`, `language`, `searchBackups`, `backupId` |
| `assemble` | 4개 계층의 문맥 조립 | `query`, `activeFile`, `budget`, `layers` |
| `status` | 색인·벡터·백업 상태 | — |
| `files` | 파일 목록과 페이지 조회 | `pattern`, `language`, `offset`, `limit` |
| `health` | 의존성 그래프 통계 | — |
| `embed` | 누락되거나 낡은 벡터 생성 | 배치 크기로 사용할 `topK` |
| `backup` | 소유자별 체크섬 백업 | `label` |
| `restore` | 실행 중인 DB의 소유자별 복원 | `backupId` |
| `gc` | 새 백업 보관 정책 | `maxAge`, `maxCount` |

```json
{"action":"assemble","query":"요청 취소 처리","activeFile":"src/client.ts","budget":6000}
```

문맥의 기본 배분은 프로젝트 구조 10%, 현재 파일과 의존성 30%, 관련 검색 결과 40%, 자주 참조한 소스 20%입니다. 제목·코드 울타리·생략 표시도 예산에 포함합니다. 토큰 수는 문자 기반 추정이므로 모델별 실제 토큰 수와 차이가 있습니다. MCP 상태 설명은 문맥 예산 밖에 있습니다. `budget: 0`이면 조립 문맥은 비어 있습니다.

## Soul 공통 DB

`N2_CONTEXT_DB_PATH`에 배포판 Soul과 Mimir가 사용하는 로컬 SQLite 파일을 지정합니다. 단독 기본 경로는 `<dataDir>/mimir.db`이며 필드 구조가 같습니다. WAL DB를 공유하는 모든 프로세스에서 SQLite 3.51.3 이상을 사용하세요. 자신의 런타임 버전은 실행 시 검사합니다.

공통 버전은 `meta.schema_version = 2`입니다. 공통 테이블은 `experiences`, `insights`, `tags`, `embeddings`, `effect_tracking`, `experience_insight_links`, `insight_links`, `meta`, `tag_similarity`입니다. Arachne는 `arachne_` 접두사의 파일·청크·의존성·이력·벡터·백업·잠금 테이블을 관리하며 `meta.arachne_schema_version = 1`을 사용합니다. 파일은 `project`/`agent`로 구분하고 기존 경로·해시·언어·크기·청크·내용·시간 필드를 유지합니다.

검색은 소유자 필터를 적용한 뒤 결과 개수를 제한합니다. 백업에는 해당 소유자의 소스와 이력이 들어가며 복원은 그 소유자의 Arachne 데이터에 적용됩니다. 공통 경험과 통찰은 Soul/Mimir가 관리합니다. DB 접근 권한과 소유자를 선택하는 호출자의 권한은 호스트에서 관리하세요.

### 4.x에서 이전

1. 기존 프로세스를 종료하고 데이터 폴더 사본을 보관합니다.
2. `N2_CONTEXT_DATA_DIR`에 기존 폴더를 지정하고 프로젝트·에이전트·소스 루트를 명시합니다.
3. 5.0을 시작하면 `context.db`를 새 `mimir.db`의 지정 소유자에 트랜잭션으로 복사합니다. 공통 데이터·다른 소유자·기존 파일을 보존합니다.
4. 버전 4 `arachne-kv.json`은 루트를 확인한 뒤 이력을 복사합니다. 이후 이력은 SQLite에 저장합니다.
5. `index`와 `status`를 확인하고, 임베딩 사용 시 `embed`를 반복해 `complete: true`를 확인합니다.

이전 영수증으로 중복 복사를 방지합니다. 최초 복사는 MCP 연결 전에 실행되므로 큰 DB는 클라이언트 시작 제한 시간을 늘리거나 라이브러리 `Store.init()`/`Store.migrateLegacy()`로 먼저 이전할 수 있습니다. 기존 벡터는 기존 DB에 남으며 새 벡터를 생성합니다. 과거 백업도 검증 후 검색·복원할 수 있습니다. 새 보관 정책은 5.0의 백업에 적용됩니다. 미래 버전·루트 불일치·과거 대붕이의 소유자 없는 테이블은 명시적 이전이 필요합니다.

## 임베딩과 처리 한도

임베딩 기본값은 꺼짐입니다. Ollama 사용 시 아래 설정을 추가하세요. 선택한 청크가 지정한 서버로 전송됩니다. 서버 오류는 문맥 조립 응답에 표시되며 키워드 검색은 계속 사용할 수 있습니다.

```json
{
  "N2_CONTEXT_EMBEDDING_ENABLED": "true",
  "N2_CONTEXT_EMBEDDING_ENDPOINT": "http://127.0.0.1:11434",
  "N2_CONTEXT_EMBEDDING_MODEL": "nomic-embed-text",
  "N2_CONTEXT_EMBEDDING_TIMEOUT": "10000"
}
```

- JS/TS·Python·Rust·Go·Java는 선언 패턴으로 청크를 나눕니다. 다른 텍스트 형식은 제한된 구간으로 처리합니다. 의존성은 휴리스틱이며 컴파일러 별칭과 동적 표현식에 한계가 있습니다. Go 패키지는 미해결 패키지 참조로 기록됩니다.
- 루트 `.gitignore`와 `.contextignore`를 읽습니다. 기본 제외 규칙은 중첩 의존성·빌드 폴더에도 적용합니다. 하위 ignore 파일을 별도로 읽는 기능은 현재 범위 밖입니다. 심볼릭 링크 항목은 건너뜁니다.
- PDF·DOCX·PPTX·XLSX를 별도 Rust 프로세스에서 읽습니다. XLSX는 실제 셀과 공유 문자열·캐시된 수식을 해석합니다. OCR·암호 해제·수식 재계산·시각적 배치는 외부 도구가 필요합니다.
- 문서는 입력 32 MiB, 추출 8 MiB, 확장 32 MiB, 메모리 예산 256 MiB, 자체 20초 제한을 적용합니다. 상위 프로세스는 22초에 종료를 요청합니다. ZIP 4,096항목·PDF 2,000쪽 제한이 있습니다. Windows는 Job 메모리 제한, Linux는 주소 공간 제한을 사용합니다. macOS는 최대 상주 메모리를 10ms마다 점검해 초과 프로세스를 종료하며 점검 사이에 예산을 일시 초과할 수 있습니다.
- 소스 파일은 기본 1 MiB, 설정 최대 10 MiB입니다. 탐색은 10만 항목·64단계·120초 검사로 제한합니다. 오류는 약 1,000개까지 수집하고 MCP에는 앞의 20개를 표시합니다.
- 임베딩은 기본 64개 배치이며 요청 사이에 20초 예산을 확인합니다. 개별 요청 제한 시간이 더해질 수 있습니다. HTTP 응답은 4 MiB로 제한합니다. 자동 색인 후 벡터 생성은 한 배치까지 실행합니다.
- 백업은 최대 2 GiB·100만 행·120초 복사 검사를 적용합니다. 부분 색인은 미확인 기존 파일을 보존하고 실패한 문서는 기존 색인을 유지하며 진단을 제공합니다.

## 설정과 검증

패키지 `config.default.js`, 선택적인 `config.local.js`, 환경 변수 순으로 합칩니다. 상대 데이터·백업 경로는 패키지 위치 기준이므로 운영 시 절대 경로를 사용하세요. `N2_DATA_DIR`은 공통 데이터 경로 별칭입니다. 기존 `integrations` 객체는 호출자 호환성을 위해 남아 있으며 실제 연결은 DB 경로와 소유자 설정을 사용합니다. 영문 README에 라이브러리 예제와 전체 설정이 있습니다.

```sh
npm ci
npm run build:documents
npm test
cargo +1.98.0 test --locked --manifest-path document-worker/Cargo.toml --jobs 2
cargo +1.98.0 test --locked --manifest-path native/Cargo.toml --jobs 2
```

실제 MCP 호출, 취소·재시도, 재시작 복원, 소유자 격리, 이전·백업·롤백, 문서와 임베딩 오류를 검증합니다. 로컬 Windows 검증은 포함된 파서를 사용합니다. 플랫폼별 결과는 해당 릴리스 커밋의 Windows·Linux·macOS CI 실행에서 확인하세요. OS 자원 제한 FFI 세 곳은 정적 검사와 별도로 수동 검토합니다.

## 사용 조건

기존 LICENSE에는 비상업·개인·교육 목적 사용 조건과 별도 상업 라이선스가 규정되어 있습니다. 이식 코드의 MIT 고지와 파서 의존성 고지를 함께 제공합니다. [라이선스](LICENSE) · [출처와 의존성 고지](THIRD-PARTY-NOTICES)
