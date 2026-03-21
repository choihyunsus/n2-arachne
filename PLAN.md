# 📋 Context Assembler (n2-context) — 기획서 v1.0

> **작성일**: 2026-03-21
> **작성자**: Rose
> **상태**: Phase 1 설계 완료, 구현 대기
> **패키지명**: `n2-context` (npm 배포용)

---

## 1. 한 줄 정의

> **AI에게 "지금 필요한 코드"를 자동으로 골라주는 MCP 서버**

사용자가 "executor.js 수정해줘"라고 하면,
Context Assembler가 executor.js뿐 아니라 관련 파일(router.js, registry.js)의
핵심 코드를 자동으로 찾아서 AI 컨텍스트에 주입한다.

---

## 2. 왜 만드는가? (문제 정의)

### 문제 1: AI의 기억상실
- AI는 매 턴마다 제공된 컨텍스트만 볼 수 있음
- 프로젝트가 커지면 전체 소스를 컨텍스트에 못 올림
- 관련 파일을 모르면 부정확한 코드 생성

### 문제 2: 수동 컨텍스트 관리
- 현재: 사용자가 직접 파일을 열거나, AI가 파일을 하나하나 읽음
- 비효율: 매 턴마다 반복, 관련 파일을 놓치기 쉬움

### 문제 3: API 비용 낭비
- 불필요한 코드까지 컨텍스트에 넣으면 입력 토큰 비용 증가
- 필요한 것만 넣으면 30~70% 비용 절감 가능

---

## 3. 핵심 원칙

### 3-1. 로컬 퍼스트 (Local First)
- 모든 인덱싱/검색이 로컬 SQLite
- 소스코드가 외부로 나가지 않음
- Ollama 임베딩도 로컬 (선택사항)

### 3-2. 프로바이더 무관 (Provider Agnostic)
- Claude, Gemini, GPT, Ollama, Qwen, DeepSeek 등 어떤 AI든 동작
- MCP 표준 프로토콜 사용 → 모든 MCP 클라이언트 호환
- **이것이 Cursor/Augment 대비 최대 차별점**

### 3-3. 독립 실행 + 에코시스템 시너지
- 단독으로도 완전히 동작하는 MCP 서버
- Soul과 함께 쓰면: 세션 기억 + 코드 맥락 = 최강 조합
- QLN과 함께 쓰면: 도구 라우팅 + 코드 검색 = 통합 지능
- Ark와 함께 쓰면: 보안 검증 + 인덱스 무결성 = 안전한 컨텍스트

### 3-4. 하드코딩 금지
- 모든 설정은 config 파일로 관리
- 파일 제외 패턴, 토큰 예산, 인덱싱 옵션 전부 설정 가능
- 환경변수 지원 (N2_CONTEXT_DATA_DIR, N2_CONTEXT_PROJECT_DIR 등)

---

## 4. 아키텍처

### 4-1. 전체 구조

```
context-assembler/
├── index.js                # MCP 서버 엔트리포인트
├── package.json            # npm 패키지 설정
├── README.md               # 사용 가이드
│
├── lib/                    # 핵심 모듈
│   ├── README.md
│   ├── config.js           # 설정 로더 (config.default.js + config.local.js)
│   ├── store.js            # SQLite DB 관리 (스키마 생성, 마이그레이션)
│   ├── indexer.js          # 파일 인덱서 (스캔 + 청킹 + 의존성 추출)
│   ├── chunker.js          # 코드 청킹 (함수/클래스 단위 분할)
│   ├── dependency.js       # 의존성 그래프 (import/require 추적)
│   ├── assembler.js        # 컨텍스트 조립기 (4-Layer 페이징)
│   ├── search.js           # BM25 + 시맨틱 검색 (QLN 라우터 경량 버전)
│   └── ignore.js           # 파일 제외 규칙 (.gitignore + .contextignore)
│
├── tools/                  # MCP 도구 정의
│   ├── README.md
│   └── context-tools.js    # MCP 도구 등록 (assemble, index, search, status)
│
├── data/                   # 런타임 데이터 (gitignored)
│   └── context.db          # SQLite 데이터베이스
│
├── config.default.js       # 기본 설정 (배포용)
└── test/                   # 테스트
    └── test-indexer.js
```

### 4-2. 모듈 책임 분담

| 모듈 | 역할 | 입력 | 출력 |
|------|------|------|------|
| `config.js` | 설정 로드 (default → local 오버라이드) | 파일 | config 객체 |
| `store.js` | SQLite 관리, 스키마 생성/마이그레이션 | config | DB 인스턴스 |
| `indexer.js` | 프로젝트 파일 스캔 → 청킹 → DB 저장 | 프로젝트 경로 | 인덱싱 결과 |
| `chunker.js` | 소스 파일 → 함수/클래스 단위 코드 조각 | 파일 내용 | 청크 배열 |
| `dependency.js` | import/require 파싱 → 의존성 그래프 | 파일 내용 | 의존성 목록 |
| `assembler.js` | **핵심!** 4-Layer 알고리즘으로 컨텍스트 조립 | 쿼리 + 예산 | 조립된 컨텍스트 |
| `search.js` | BM25 키워드 검색 (QLN 라우터 경량 버전) | 쿼리 | 관련 청크 목록 |
| `ignore.js` | .gitignore + .contextignore 패턴 매칭 | 파일 경로 | 포함/제외 판단 |

### 4-3. 데이터 흐름

```
[사용자 요청: "executor.js 수정해줘"]
          │
          ▼
[MCP Tool: n2_context(action: "assemble", query: "executor.js 수정")]
          │
          ▼
[assembler.js] ── 4-Layer 페이징 ──┐
  │                                │
  │ L1: 프로젝트 구조 트리          │
  │ L2: 현재 열린 파일 코드         │
  │ L3: search.js로 관련 청크 검색  │─→ [store.js] ─→ SQLite
  │ L4: 의존성 그래프 탐색          │
  │                                │
  └── 토큰 예산 내에서 조립 ────────┘
          │
          ▼
[조립된 컨텍스트 반환] → AI에게 주입
```

---

## 5. SQLite 스키마

### 5-1. MVP 스키마 (Phase 1 — 테이블 3개)

```sql
-- 프로젝트별 설정
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 파일 인덱스
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,         -- 상대 경로 (프로젝트 루트 기준)
    hash TEXT NOT NULL,                -- SHA-256 해시 (변경 감지)
    language TEXT,                     -- js, ts, py, rs, md, json, ...
    size_bytes INTEGER,
    chunk_count INTEGER DEFAULT 0,     -- 이 파일의 청크 수
    indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    modified_at DATETIME               -- 파일시스템 mtime
);

-- 코드 청크 (함수/클래스/블록 단위)
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_type TEXT NOT NULL,           -- function, class, interface, block, module
    name TEXT,                          -- 함수명, 클래스명 (null 가능)
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,              -- 실제 코드 내용
    token_count INTEGER NOT NULL,       -- 토큰 수 (예산 계산용)
    search_text TEXT,                   -- BM25 검색용 텍스트 (이름+코드+주석)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 검색 성능용 인덱스
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
```

### 5-2. Phase 2 추가 테이블

```sql
-- 의존성 그래프 (import/require 관계)
CREATE TABLE IF NOT EXISTS dependencies (
    source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    target_path TEXT NOT NULL,          -- import 대상 경로 (해석 전)
    target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,  -- 해석된 파일 ID
    dep_type TEXT DEFAULT 'import',     -- import, require, extends, implements
    PRIMARY KEY (source_file_id, target_path)
);

-- 접근 이력 (자주 사용하는 파일 추적)
CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    query TEXT,                         -- 어떤 쿼리로 접근했는지
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 5-3. Phase 3 추가 (임베딩)

```sql
-- 벡터 임베딩 (sqlite-vec 또는 별도 테이블)
CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    vector BLOB NOT NULL,               -- float32 배열 직렬화
    model TEXT DEFAULT 'nomic-embed-text',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 6. MCP 도구 정의 (API 표면)

### 통합 도구: `n2_context`

QLN의 `n2_qln_call`과 동일한 패턴: **1 도구, 여러 액션**

```
n2_context(action, ...)

액션:
  - assemble : 컨텍스트 조립 (핵심 기능!)
  - search   : 코드 검색 (독립적으로도 유용)
  - index    : 수동 인덱싱 트리거
  - status   : 인덱스 상태 확인
  - files    : 프로젝트 파일 목록 조회
  - backup   : 인덱스 DB 백업
  - restore  : 백업에서 복구
  - gc       : 오래된 백업/stale 데이터 정리
```

### 액션별 파라미터

```javascript
// assemble — 핵심 기능
n2_context({
    action: "assemble",
    query: "executor.js의 exec 함수 수정",   // 자연어 쿼리
    activeFile: "lib/executor.js",            // 현재 작업 파일 (선택)
    budget: 40000,                            // 토큰 예산 (기본: config)
    layers: ["fixed", "short", "related", "spare"]  // 사용할 레이어 (기본: 전부)
})
// → 조립된 컨텍스트 텍스트 반환

// search — 코드 검색
n2_context({
    action: "search",
    query: "HTTP timeout handling",           // 자연어 쿼리
    topK: 10,                                 // 결과 수 (기본: 5)
    language: "js"                            // 언어 필터 (선택)
})
// → 관련 코드 청크 목록 반환

// index — 수동 인덱싱
n2_context({
    action: "index",
    path: "./src",                            // 인덱싱 대상 (기본: 프로젝트 루트)
    force: false                              // true면 전체 재인덱싱 (기본: 증분)
})
// → 인덱싱 결과 (indexed, skipped, elapsed)

// status — 인덱스 상태
n2_context({ action: "status" })
// → 파일 수, 청크 수, DB 크기, 마지막 인덱싱 시간

// files — 파일 목록
n2_context({
    action: "files",
    language: "ts",                           // 언어 필터 (선택)
    pattern: "**/lib/**"                      // glob 패턴 (선택)
})
// → 파일 목록 (경로, 언어, 크기, 청크 수)
```

---

## 7. 4-Layer 페이징 알고리즘 (상세)

### 입력
- `query`: 사용자 요청 (자연어)
- `activeFile`: 현재 작업 중인 파일 경로 (선택)
- `budget`: 토큰 예산 (기본: 40,000)

### 알고리즘

```
function assemble(query, activeFile, budget):

    result = []
    remaining = budget

    // ── Layer 1: 고정 (Fixed) — 예산의 10% ──
    l1_budget = budget * 0.10
    
    // 프로젝트 파일 트리 (경로만, 내용 X)
    tree = generateFileTree(depth=3)  // 3단계까지만
    result.push(tree)
    remaining -= tokens(tree)

    // ── Layer 2: 단기 (Short-term) — 예산의 30% ──
    l2_budget = min(budget * 0.30, remaining)
    
    // 현재 작업 파일 전체 코드
    if activeFile:
        fileContent = readFile(activeFile)
        result.push(fileContent)
        remaining -= tokens(fileContent)
    
    // 최근 접근한 파일의 청크 (access_log 기반)
    recentChunks = getRecentChunks(limit=5, budget=l2_budget_remaining)
    result.push(recentChunks)
    remaining -= tokens(recentChunks)

    // ── Layer 3: 연관 (Associative) — 예산의 40% ── ★핵심!
    l3_budget = min(budget * 0.40, remaining)
    
    // 3-1. BM25 검색으로 query와 관련된 청크 찾기
    searchResults = bm25Search(query, topK=20)
    
    // 3-2. activeFile의 의존성 체인 탐색 (import 따라가기)
    if activeFile:
        deps = getDependencies(activeFile, depth=2)  // 2단계까지
        depChunks = getChunksForFiles(deps)
        searchResults = merge(searchResults, depChunks)
    
    // 3-3. 관련성 점수순 정렬 → 예산 내 선택
    sorted = sortByRelevance(searchResults)
    for chunk in sorted:
        if remaining - tokens(chunk) < 0: break
        result.push(chunk)
        remaining -= tokens(chunk)

    // ── Layer 4: 여유 (Spare) — 남은 예산 ──
    // 자주 수정되는 파일, TODO 관련 코드 등
    if remaining > 1000:
        frequentFiles = getMostAccessedFiles(limit=3)
        for file in frequentFiles:
            topChunk = getBestChunk(file, budget=remaining)
            if topChunk:
                result.push(topChunk)
                remaining -= tokens(topChunk)

    // ── 출력 구성 (Lost in the Middle 방지) ──
    // 중요도: L1(구조) → L3(연관) → L4(여유) → L2(현재) 순서로 배치
    // → 가장 중요한 관련 코드가 앞쪽에, 현재 파일은 뒤쪽에
    return formatOutput(result, order=[L1, L3, L4, L2])
```

### 토큰 계산

```javascript
// 간단한 토큰 추정 (정확한 토크나이저 없이)
function estimateTokens(text) {
    // 영어: ~4글자 = 1토큰, 한글: ~2글자 = 1토큰
    // 코드: 공백/기호 포함 대략 ~3.5글자 = 1토큰
    return Math.ceil(text.length / 3.5);
}
```

---

## 8. 청킹 전략 (chunker.js)

### Phase 1: 라인 기반 청킹 (MVP — 파서 불필요)

```javascript
// 정규식으로 함수/클래스 경계 감지
const CHUNK_PATTERNS = {
    js: {
        function: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
        class: /^(?:export\s+)?class\s+(\w+)/,
        arrow: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
        method: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
    },
    ts: {
        // js + interface, type
        interface: /^(?:export\s+)?interface\s+(\w+)/,
        type: /^(?:export\s+)?type\s+(\w+)/,
    },
    py: {
        function: /^(?:async\s+)?def\s+(\w+)/,
        class: /^class\s+(\w+)/,
    }
};
// → 패턴 매칭으로 시작점 찾고, 들여쓰기/중괄호로 끝점 추정
```

### Phase 2: AST 기반 청킹 (정확하지만 의존성 필요)

```
JS/TS: @babel/parser 또는 typescript compiler API
Python: tree-sitter-python
Rust: tree-sitter-rust
→ Phase 2에서 선택적으로 도입 (패키지 설치 주인님 승인 필요)
```

### 청크 크기 기준

| | 최소 | 이상적 | 최대 |
|---|---|---|---|
| **토큰** | 50 | 200~500 | 2,000 |
| **라인** | 3 | 10~30 | 100 |

- 너무 작으면: 맥락 손실 (함수 일부만 보임)
- 너무 크면: 토큰 예산 낭비

---

## 9. 의존성 그래프 (dependency.js)

### Phase 1: 정규식 파싱 (MVP)

```javascript
// import/require 패턴 추출
const IMPORT_PATTERNS = [
    // ES6: import X from './path'
    /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    // CommonJS: require('./path')
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Dynamic: import('./path')
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// 경로 해석: './executor' → 'lib/executor.js' (확장자 추론)
function resolveImport(fromFile, importPath, projectFiles) {
    // 1. 정확한 파일 존재 여부
    // 2. .js, .ts, .jsx, .tsx 확장자 추가 시도
    // 3. /index.js, /index.ts 디렉토리 인덱스 시도
    // 4. 실패 시 null (외부 패키지 = 무시)
}
```

### 의존성 탐색 깊이

```
depth=1: executor.js → [router.js, registry.js]
depth=2: executor.js → [router.js → [schema.js, vector-index.js],
                         registry.js → [store.js, embedding.js]]
기본값: depth=2 (너무 깊으면 관련 없는 파일까지 포함됨)
```

---

## 10. 파일 제외 규칙 (ignore.js)

### 기본 제외 패턴 (하드코딩 아님, config.default.js에 정의)

```javascript
const DEFAULT_IGNORE = [
    // 패키지 매니저
    'node_modules/**', 'vendor/**', '__pycache__/**', '.venv/**',
    // 빌드 산출물
    'dist/**', 'build/**', 'out/**', '.next/**', 'target/**',
    // 버전 관리
    '.git/**',
    // 바이너리/미디어
    '*.png', '*.jpg', '*.gif', '*.ico', '*.svg',
    '*.woff', '*.woff2', '*.ttf', '*.eot',
    '*.mp3', '*.mp4', '*.wav',
    '*.zip', '*.tar', '*.gz',
    '*.exe', '*.dll', '*.so', '*.dylib',
    // 압축/난독화
    '*.min.js', '*.min.css', '*.map',
    // 락 파일
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    // Soul/QLN 런타임 데이터
    'soul/data/**', 'data/**',
];
```

### 우선순위
1. `.contextignore` (사용자 커스텀, 최우선)
2. `.gitignore` (프로젝트 설정)
3. `config.default.js`의 기본 패턴 (폴백)

---

## 11. 설정 구조 (config)

### config.default.js (배포용)

```javascript
module.exports = {
    // 데이터 저장 경로
    dataDir: './data',

    // 인덱싱 설정
    indexing: {
        autoIndex: true,            // 시작 시 자동 인덱싱
        incremental: true,          // 증분 인덱싱 (hash 비교)
        maxFileSize: 1024 * 1024,   // 1MB 초과 파일 무시
        maxFiles: 50000,            // 최대 인덱싱 파일 수
        chunkStrategy: 'regex',     // 'regex' (Phase 1) | 'ast' (Phase 2)
    },

    // 컨텍스트 조립 설정
    assembly: {
        defaultBudget: 40000,       // 기본 토큰 예산
        layers: {
            fixed: 0.10,            // L1: 고정 (10%)
            shortTerm: 0.30,        // L2: 단기 (30%)
            associative: 0.40,      // L3: 연관 (40%)
            spare: 0.20,            // L4: 여유 (20%)
        },
        dependencyDepth: 2,         // 의존성 탐색 깊이
    },

    // 검색 설정
    search: {
        bm25: { k1: 1.2, b: 0.75 },    // BM25 파라미터 (QLN과 동일)
        topK: 10,                        // 기본 검색 결과 수
    },

    // 임베딩 설정 (Phase 3, 선택사항)
    embedding: {
        enabled: false,             // 기본 비활성화 (Ollama 필요)
        provider: 'ollama',
        model: 'nomic-embed-text',
        endpoint: 'http://localhost:11434',
    },

    // 파일 제외 패턴
    ignore: {
        useGitignore: true,
        useContextignore: true,
        patterns: [/* DEFAULT_IGNORE */],
    },

    // 통합 설정 (Soul, QLN, Ark)
    integrations: {
        soul: { enabled: false, dataDir: null },
        qln: { enabled: false },
        ark: { enabled: false, rulesDir: null },
    },
};
```

---

## 12. N2 에코시스템 통합 (integrations)

### 12-1. Soul 통합 (최우선)

```
Soul ←→ Context Assembler 연동 포인트:

1. KV-Cache 연계:
   - Soul의 세션 요약에서 "어떤 파일을 다뤘는지" 추출
   - Context Assembler의 access_log에 반영
   - → 다음 세션에서 이전에 다룬 파일을 자동으로 높은 우선순위로

2. Soul Board 연계:
   - handoff에 "현재 작업 파일 목록" 추가
   - → 다음 에이전트가 부팅 시 관련 컨텍스트 자동 조립

3. Ledger 연계:
   - 작업 기록에 "사용된 컨텍스트 청크 목록" 첨부
   - → 과거 작업에서 어떤 코드를 참조했는지 추적 가능
```

### 12-2. QLN 통합

```
QLN ←→ Context Assembler 연동 포인트:

1. 검색 엔진 공유:
   - BM25 알고리즘 동일 (Router.js 로직 재활용)
   - 시맨틱 검색도 같은 Ollama 임베딩 사용

2. 도구 실행 컨텍스트:
   - AI가 QLN으로 도구를 선택할 때, 관련 코드도 함께 제공
   - → 도구 사용 정확도 향상

3. 통합 MCP:
   - n2_qln_call + n2_context 를 하나의 MCP 서버로 합칠 수도 있음
   - → 토큰 절약 (도구 스키마 2개 대신 1개)
```

### 12-3. Ark 통합

```
Ark ←→ Context Assembler 연동 포인트:

1. 인덱스 무결성 검증:
   - Ark의 validator.rs 패턴으로 청크 품질 검사
   - 빈 청크, 중복 청크, 너무 큰 청크 자동 거부

2. 보안 정책 적용:
   - .env, credentials, API 키가 포함된 파일 자동 제외
   - Ark의 보안 규칙으로 민감 정보 필터링

3. 샌드박스 실행:
   - 인덱싱 연산을 Ark의 샌드박스 규칙 내에서 실행
   - 악의적 파일 (예: node_modules의 악성 패키지)로부터 격리
```

---

## 13. 확장성 안전장치 (Scalability Safeguards)

### 파일 규모별 전략 자동 분기

```javascript
function selectStrategy(fileCount) {
    if (fileCount < 500) {
        return 'full';       // 전체 스캔 OK, 인메모리 검색
    } else if (fileCount < 5000) {
        return 'incremental'; // 증분만, SQLite 검색
    } else {
        return 'lazy';       // 요청 시에만 인덱싱, 파티션 검색
    }
}
```

### 안전장치 체크리스트

| # | 안전장치 | 구현 위치 | 트리거 |
|---|---------|----------|--------|
| 1 | 증분 인덱싱 (hash 비교) | indexer.js | 모든 인덱싱 시 |
| 2 | .gitignore + .contextignore | ignore.js | 파일 스캔 시 |
| 3 | 토큰 예산 하드캡 | assembler.js | 조립 시 |
| 4 | 최대 파일 크기 제한 (1MB) | indexer.js | 파일 읽기 시 |
| 5 | 최대 파일 수 제한 (50,000) | indexer.js | 전체 스캔 시 |
| 6 | GC: stale 파일 정리 | store.js | 주기적 / 수동 |
| 7 | 폴더 단위 파일 감시 | indexer.js | 변경 감지 시 |
| 8 | Git 기반 변경 감지 (최적화) | indexer.js | Git 프로젝트일 때 |

---

## 13.5 백업 & 복구 (Backup & Recovery)

> Soul의 `n2_kv_backup/restore` 패턴을 그대로 따름

### 왜 필요한가?

| 규모 | DB 크기 | 인덱싱 시간 | 날아가면? |
|------|--------|-----------|---------|
| 소규모 (100파일) | ~5MB | ~3초 | 재인덱싱 가능 |
| 중규모 (1,000파일) | ~50MB | ~30초 | 좀 아까움 |
| 대규모 (10,000파일) | ~500MB | ~5분 | 😤 |
| 엔터프라이즈 (100,000파일) | ~5GB | ~30분+ | 💀 재앙 |

**파일이 많을수록 인덱스 재구축 비용이 기하급수적으로 증가.**
**임베딩까지 있으면 (Ollama 호출) 더 비쌈.**
**→ 백업은 선택이 아니라 필수.**

### 13.5-1. 백업 전략

```
data/
├── context.db              ← 현재 활성 DB
├── backups/                ← 백업 디렉토리
│   ├── context-2026-03-21-143000.db    ← 타임스탬프 백업
│   ├── context-2026-03-20-180000.db
│   └── context-2026-03-19-120000.db
└── backups.json            ← 백업 메타데이터
```

### backups.json 구조

```json
{
    "backups": [
        {
            "id": "2026-03-21-143000",
            "filename": "context-2026-03-21-143000.db",
            "created_at": "2026-03-21T14:30:00+09:00",
            "type": "auto",
            "file_count": 3500,
            "chunk_count": 28000,
            "size_bytes": 52428800,
            "project_dir": "/home/user/my-project",
            "trigger": "pre-reindex"
        }
    ],
    "policy": {
        "max_backups": 10,
        "max_age_days": 30,
        "auto_backup_on_reindex": true
    }
}
```

### 13.5-2. 백업 MCP 액션

```javascript
// backup — 수동 백업
n2_context({
    action: "backup",
    label: "before-refactor"     // 선택: 사람이 읽을 수 있는 라벨
})
// → { id: "2026-03-21-143000", size: "52MB", files: 3500, chunks: 28000 }

// restore — 백업에서 복구
n2_context({
    action: "restore",
    id: "2026-03-21-143000"      // 백업 ID (없으면 최신)
})
// → 현재 DB 교체 + 인덱스 리로드

// gc — 오래된 백업 정리
n2_context({
    action: "gc",
    maxAge: 30,                  // N일 이상 된 백업 삭제 (기본: config)
    maxCount: 10                 // 최대 백업 수 (기본: config)
})
// → 삭제된 백업 수 반환
```

### 13.5-3. 자동 백업 트리거

| 트리거 | 시점 | 이유 |
|-------|------|------|
| `pre-reindex` | `force: true` 전체 재인덱싱 직전 | 재인덱싱 실패 시 롤백용 |
| `scheduled` | 설정된 주기 (기본: 1일 1회) | 정기 보호 |
| `pre-migration` | DB 스키마 업그레이드 직전 | 마이그레이션 실패 시 롤백 |
| `manual` | 사용자 수동 요청 | 중요 작업 전 |

### 13.5-4. 백업 내 검색 (Backup Search)

**핵심 시나리오**: "옛날에 삭제한 함수가 뭐였더라?"

```javascript
// 백업 DB를 ATTACH해서 검색
n2_context({
    action: "search",
    query: "deleted function handleAuth",
    searchBackups: true,         // 백업 DB도 검색!
    backupId: "2026-03-20-180000"  // 특정 백업 (없으면 최신 백업)
})
// → 현재 DB + 백업 DB에서 모두 검색
// → 백업에만 있는 결과는 [backup:2026-03-20] 태그 표시
```

**구현 방식**: SQLite의 `ATTACH DATABASE` 활용

```sql
-- 백업 DB를 임시로 연결
ATTACH DATABASE 'backups/context-2026-03-20.db' AS backup;

-- 현재 + 백업 통합 검색
SELECT 'current' as source, * FROM chunks WHERE search_text LIKE '%handleAuth%'
UNION ALL
SELECT 'backup' as source, * FROM backup.chunks WHERE search_text LIKE '%handleAuth%';

-- 연결 해제
DETACH DATABASE backup;
```

### 13.5-5. GC (Garbage Collection) 정책

```javascript
// config.default.js에 추가
backup: {
    enabled: true,
    dir: './data/backups',       // 백업 저장 경로
    maxBackups: 10,              // 최대 백업 수
    maxAgeDays: 30,              // 30일 이상 된 백업 자동 삭제
    autoBackupOnReindex: true,   // 전체 재인덱싱 전 자동 백업
    scheduledBackup: '0 0 * * *', // cron 형식 (매일 자정) — 선택사항
    
    // 외부 백업 경로 (선택 — Soul의 Google Drive 백업과 동일 패턴)
    externalBackupDir: null,     // 예: 'G:/Backup/n2-context'
}
```

### 13.5-6. store.js에 추가될 메서드

```javascript
class Store {
    // ... 기존 메서드 ...

    /** SQLite 온라인 백업 (락 최소화) */
    async backup(label) {
        const id = this._generateBackupId();
        const filename = `context-${id}.db`;
        const dest = path.join(this._backupDir, filename);
        
        // better-sqlite3의 .backup() — 안전하고 빠름
        await this._db.backup(dest);
        
        // 메타데이터 기록
        this._updateBackupMeta(id, filename, label);
        return { id, filename, size: fs.statSync(dest).size };
    }

    /** 백업에서 복구 */
    async restore(backupId) {
        const meta = this._getBackupMeta(backupId);
        const src = path.join(this._backupDir, meta.filename);
        
        // 현재 DB 닫기 → 백업으로 교체 → 다시 열기
        this._db.close();
        fs.copyFileSync(src, this._dbPath);
        this._db = new Database(this._dbPath);
        return { restored: backupId, files: this.getFileCount() };
    }

    /** ATTACH로 백업 DB 검색 */
    searchBackup(backupId, query) {
        const meta = this._getBackupMeta(backupId);
        const backupPath = path.join(this._backupDir, meta.filename);
        
        this._db.exec(`ATTACH DATABASE '${backupPath}' AS backup`);
        try {
            return this._db.prepare(`
                SELECT 'current' as source, * FROM chunks 
                WHERE search_text LIKE ?
                UNION ALL
                SELECT 'backup:${backupId}' as source, * FROM backup.chunks 
                WHERE search_text LIKE ?
            `).all(`%${query}%`, `%${query}%`);
        } finally {
            this._db.exec('DETACH DATABASE backup');
        }
    }

    /** GC: 오래된 백업 삭제 */
    gc(maxAgeDays, maxCount) {
        // 1. maxAge 초과 백업 삭제
        // 2. maxCount 초과 시 오래된 것부터 삭제
        // 3. 외부 백업 경로가 있으면 거기서도 정리
    }
}
```

### 13.5-7. 아키텍처 흐름 (lib/backup.js 별도 모듈)

```
context-assembler/
├── lib/
│   ├── ...기존...
│   └── backup.js          # 백업/복구/GC 전담 모듈
```

| 메서드 | 역할 |
|-------|------|
| `backup(label?)` | 현재 DB → backups/ 복사 + 메타 기록 |
| `restore(id?)` | backups/ → 현재 DB 복구 |
| `list()` | 백업 목록 반환 (메타데이터 포함) |
| `searchBackup(id, query)` | ATTACH로 백업 DB 내 검색 |
| `gc(maxAge, maxCount)` | 정책 기반 오래된 백업 삭제 |
| `exportTo(externalDir)` | 외부 경로로 백업 내보내기 |



### Phase 1: MVP (2~3일) — "검색만 되면 성공"

```
[ ] config.js + config.default.js
[ ] store.js (SQLite 스키마 생성)
[ ] ignore.js (.gitignore + .contextignore)
[ ] indexer.js (파일 스캔 + hash 기반 증분)
[ ] chunker.js (정규식 기반 함수/클래스 분할)
[ ] search.js (BM25 키워드 검색)
[ ] context-tools.js (MCP 도구 등록: search, index, status)
[ ] index.js (MCP 서버 엔트리)
[ ] 테스트: QLN 프로젝트를 대상으로 인덱싱 + 검색 테스트
```

### Phase 2: 핵심 기능 (1~2주) — "조립이 되면 진짜 가치"

```
[ ] assembler.js (4-Layer 페이징 알고리즘)
[ ] dependency.js (import/require 의존성 그래프)
[ ] assemble 액션 추가
[ ] Lost in the Middle 방지 배치 전략
[ ] 토큰 예산 최적화 + 벤치마크
[ ] Soul 연동 (KV-Cache 연계)
```

### Phase 3: 완성형 (추가 1~2주) — "프로덕션 레디"

```
[ ] 시맨틱 검색 (Ollama 임베딩 + sqlite-vec)
[ ] AST 기반 청킹 (선택적)
[ ] Ark 보안 연동 (민감 파일 자동 제외)
[ ] npm 배포 (n2-context)
[ ] README 완성 (영문 + 한국어)
[ ] 성능 벤치마크 보고서
```

---

## 15. 이전 리서치 참조

| 참조 | 핵심 교훈 |
|------|---------|
| Cursor | 시맨틱 인덱싱 + 벡터DB, 하지만 클라우드 의존 |
| Augment Code | Context Engine API, 에이전트 성능 70%↑, 하지만 유료 |
| FastMCP Code Mode | 도구 체이닝 샌드박스, N2에서는 WebWorker로 대체 가능 |
| Cloudflare Code Mode | V8 샌드박스, Electron에 이미 V8이 있으므로 활용 가능 |
| "Lost in the Middle" | 중요한 정보는 컨텍스트 앞/뒤에 배치 |
| Context Engineering 2026 | 선택적 컨텍스트 + 동적 도구 주입이 핵심 트렌드 |

---

## 부록: QLN 대비 코드 재활용 매핑

| QLN 모듈 | Context Assembler 대응 | 재사용 가능 코드 |
|---------|----------------------|---------------|
| `router.js` (BM25) | `search.js` | BM25 알고리즘 95% 동일 |
| `store.js` (SQLite) | `store.js` | 스키마만 다르고 구조 동일 |
| `registry.js` | `indexer.js` | 등록/조회 패턴 유사 |
| `config.js` | `config.js` | 구조 100% 동일 |
| `validator.js` | Ark 연동 | 검증 패턴 재활용 가능 |
| `embedding.js` | Phase 3 | 코드 그대로 복사 가능 |
