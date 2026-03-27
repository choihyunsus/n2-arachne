# Arachne (n2-arachne)

[![npm version](https://img.shields.io/npm/v/n2-arachne.svg)](https://www.npmjs.com/package/n2-arachne)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/n2-arachne.svg)](https://www.npmjs.com/package/n2-arachne)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)

한국어 | **[English](README.md)** | **[日本語](README.ja.md)**

> 거미줄처럼 코드를 엮어 AI에게 최적의 컨텍스트를 조립하는 MCP 서버 

## 문제 — AI가 내 코드를 왜 틀리게 짜는 걸까?

병원에 가서 **"머리가 아파요"** 라고 말했다고 해봅시다.

- **나쁜 의사**: 500페이지짜리 전체 진료기록을 다 읽고, 혼란스러워하며, 엉뚱한 약을 처방
- **좋은 의사**: 관련 기록만 확인 — 최근 증상, 복용 약, 알레르기 — 정확히 진단

**AI 코딩 어시스턴트가 바로 그 나쁜 의사입니다.**

프로젝트에 파일이 500개 있으면, AI가 전부 읽을 수 없거든요. 그럼 무슨 일이 벌어질까요?

```
 내 프로젝트 (파일 500개, 토큰 200만개)
│
├── auth/login.ts ← 버그가 여기에 있음
├── auth/session.ts ← login이 이걸 import함
├── api/http.ts ← session이 이걸 import함
├── utils/config.ts ← 타임아웃 설정값이 여기에
│
├── pages/home.tsx ← 완전히 관계없음
├── pages/about.tsx ← 완전히 관계없음
├── components/Button.tsx ← 완전히 관계없음
└── ... 나머지 493개 ← 전부 관계없음
```

| 방법 | AI가 받는 양 | 결과 |
|------|------------|------|
| 전부 던지기 | 토큰 2,000,000개 | 컨텍스트 초과, AI 혼란 |
| 아무 파일이나 | ~50,000 토큰 | 핵심 코드 누락, 잘못된 수정 |
| **Arachne** | **30,000 토큰** (관련 파일 4개만) | 정확한 수정, 매번 |

> **토큰**이란? AI가 읽는 텍스트의 단위. 토큰이 많을수록 = 비용 증가, 속도 저하, 정확도 감소.
> AI에는 한계가 있는 "컨텍스트 윈도우"가 있습니다 — 책상 위에 올릴 수 있는 서류 양에 한계가 있는 것처럼.

---

## 해결 — Arachne가 AI에게 딱 필요한 것만 골라줍니다

Arachne는 좋은 의사처럼 작동하는 **로컬 MCP 서버**입니다. 코드베이스를 한 번 읽고, 구조를 이해한 뒤, **관련된 코드만** AI에게 전달합니다.

```
사용자: "로그인 타임아웃 버그 고쳐줘"
 │
 ▼
┌───────────────────────────────────────────────────────┐
│ Arachne: "딱 필요한 코드만 골라줄게" │
│ │
│ L1 파일 트리 (AI가 전체 구조를 파악하도록) │
│ L2 login.ts (지금 작업 중인 파일) │
│ L3 http.ts, session.ts (검색 + 의존성 체인으로 발견 │
│ login → session → http) │
│ L4 config.ts (자주 접근, 타임아웃 설정 포함) │
│ │
│ → 완벽하게 큐레이션된 30,000 토큰 │
└───────────────────────────────────────────────────────┘
 │
 ▼
 AI가 정확한 수정 코드 생성 
```

**파일을 직접 골라줄 필요 없음. 프롬프트 엔지니어링 불필요. 그냥 물어보세요.**

---

### 왜 Arachne인가?

- **토큰 98.5% 절약** — 200만 대신 3만 토큰. API 비용 실제 절감
- **"Lost in the Middle" 극복** — 스마트 출력 순서(L1→L3→L4→L2)로 AI가 집중하는 위치에 핵심 코드 배치 ([논문 근거](https://arxiv.org/abs/2307.03172))
- **제로 외부 의존** — Docker 없음, 클라우드 없음, API 키 불필요. `npm install`이면 끝
- **초고속** — 21개 파일 인덱싱 12ms. 증분 업데이트는 밀리초 단위
- **초경량** — 의존성 3개: `better-sqlite3`, `sqlite-vec`, `zod`. 그게 전부
- **100% 무료 & 오픈소스** — Apache-2.0, 숨겨진 비용 없음, 텔레메트리 없음
- **플러그 앤 플레이** — MCP 설정 추가 → 끝. 프로젝트 코드 수정 불필요
- **다국어 지원** — JS/TS, Python, Rust, Go, **Java** import 체인 자동 분석
- **Ollama 선택사항** — Ollama 없이도 완벽 동작(BM25 검색). Ollama 추가하면 시맨틱 검색 보너스

### Arachne 4컷 만화

![Arachne란? — AI가 파일 500개를 받으면 버그를 못 찾는다. Arachne가 관련 파일 4개만 골라준다. 3만 토큰, 매번 정확한 수정.](docs/arachne-comic.png)

### Soul + Arachne 시너지

![Soul은 이전 세션을 기억한다. Arachne는 코드를 찾는다. 합치면 AI가 절대 잊지 않고, 절대 놓치지 않는다.](docs/soul-synergy-comic.png)

## 핵심 특징

| 기능 | 설명 |
|------|------|
| **MCP 표준** | Claude, Gemini, GPT, Ollama — 어떤 AI든 OK |
| **로컬 퍼스트** | 모든 인덱싱이 로컬 SQLite. 외부 전송 제로 |
| **증분 인덱싱** | 변경된 파일만 업데이트. 초 단위 갱신 |
| **하이브리드 검색** | BM25 키워드 + 시맨틱 벡터 검색 (Ollama 임베딩) |
| **4-Layer 조립** | 토큰 예산 내에서 스마트 컨텍스트 페이징 |
| **의존성 그래프** | JS/TS, Python, Rust, Go, **Java** import 체인 추적 |
| **백업 & 복구** | SQLite 온라인 백업 + 백업 내 검색 |

## 아키텍처: 4-Layer 컨텍스트 조립

```
┌─────────────────────────────────────────────┐
│ 토큰 예산 (예: 30K) │
├────────────┬────────────────────────────────┤
│ L1: Fixed │ 파일 트리 개요 (10%) │
│ (고정) │ 프로젝트 구조 스냅샷 │
├────────────┼────────────────────────────────┤
│ L2: Short │ 현재 파일 + 최근 (20%) │
│ (단기) │ 지금 작업 중인 파일 │
├────────────┼────────────────────────────────┤
│ L3: Assoc │ 검색 + 의존성 (50%) │
│ (연관) │ BM25 + 시맨틱 + 의존성 체인 │
├────────────┼────────────────────────────────┤
│ L4: Spare │ 자주 접근한 파일 (20%) │
│ (예비) │ 가장 많이 쓰는 파일 │
└────────────┴────────────────────────────────┘

출력 순서: L1 → L3 → L4 → L2 ("Lost in the Middle" 방지)
```

## 시맨틱 검색 (선택, 제로 록인)

Ollama가 있으면 키워드 전용에서 **하이브리드 검색**으로 자동 업그레이드:

```
BM25 스코어 (키워드) ──┐
 ├── 가중 합산 (α=0.5) → 최적 결과
코사인 유사도 ──────────┘
(nomic-embed-text 768D)
```

- **sqlite-vec**: SIMD 가속(AVX2/SSE2/Neon) KNN 벡터 검색
- **768차원** 임베딩 — Ollama `nomic-embed-text`로 100% 로컬 처리
- **Graceful degradation**: Ollama 없으면 BM25-only로 폴백. **크래시 제로. 항상 동작.**
- 설정: `embedding.enabled = true`로 활성화
- 벡터 저장: 청크당 ~3KB. 5000청크 = 디스크 15MB

## Java 지원 — 엔터프라이즈급 대규모 프로젝트 대응

Arachne는 대규모 엔터프라이즈 코드베이스(5M+ LOC)를 위한 **Java 일급 지원**을 제공합니다:

| 기능 | 설명 |
|------|------|
| **스마트 청킹** | `class`, `interface`, `enum`, `method`, `@interface` (어노테이션) 자동 감지 |
| **대형 클래스 분할** | 500토큰 이상의 클래스는 **메서드 단위로 자동 분할** |
| **Import 해석** | `import com.example.Service` 및 `import static org.junit.Assert.*` 지원 |
| **접근 제어자** | `public`, `private`, `protected`, `abstract`, `final`, `synchronized` 처리 |
| **제네릭** | `<T extends Comparable<T>>` 등 복잡한 제네릭 타입 정상 처리 |
| **Spring/JUnit** | Spring Boot `@RestController`, JUnit5 static import, Mockito 테스트 완료 |
| **바이너리 제외** | `.class`, `.jar`, `.war`, `.ear` 파일 자동 제외 |

### 대형 클래스 분할 동작 원리

```
// 500+ 토큰 클래스 → 메서드 단위로 자동 분할
public class UserService { // ← 컨테이너로 감지
 public User findById() {} // ← sub-chunk 1
 public List<User> findAll() // ← sub-chunk 2
 public User save() {} // ← sub-chunk 3
 // ... 필드, 생성자 // ← 나머지 청크
}

// 작은 클래스 (<500 토큰) → 단일 청크로 유지 (오버헤드 없음)
public class TinyDTO { ... } // ← 단일 청크, 효율적
```

> **5M LOC 프로젝트에서 이게 중요한 이유**: Java 클래스 하나가 50개+ 메서드와 수천 줄에 달할 수 있습니다. sub-chunking 없이는 AI가 클래스 전체를 한 덩어리로 받습니다. Arachne는 개별 메서드를 제공하여 정밀하고 타겟된 코드 생성을 가능하게 합니다.

### 토큰 절약: 적을수록 정확하다

```
Sub-chunking 없이:
 AI: "findById 버그 고쳐줘"
 → BM25 검색 → UserService 클래스 hit
 → 클래스 통째로 전달: 6,000 토큰 

Sub-chunking 사용:
 AI: "findById 버그 고쳐줘"
 → BM25 검색 → findById() 메서드만 hit
 → 메서드만 전달: 80 토큰 75배 절약!
```

> Sub-chunking은 추가 비용이 없습니다 — 클래스 전체 대신 **필요한 메서드만** 보내서 오히려 토큰을 **절약**합니다.

## 안정성: 104개 테스트, 실패 제로

Arachne는 프로덕션용입니다. 모든 엣지 케이스가 테스트됨:

| 카테고리 | 테스트 내용 |
|----------|------------|
| SQL 인젝션 | Bobby Tables 포함 5종 공격 패턴 방어 |
| Null/빈 입력 | null, undefined, 빈 문자열 → 안전 반환 |
| 거대 입력 | 10KB 쿼리 → 크래시 없음 |
| 특수문자 | 유니코드, 이모지, 정규식 문자 → 처리됨 |
| Ollama 끊김 | 잘못된 엔드포인트 → BM25 폴백 |
| 멱등성 | 3회 연속 인덱싱 → 동일 결과 |
| 극단적 예산 | 예산 0, 1, 100만 → 전부 안전 |
| Edge topK | topK = -1, 0, 99999 → 크래시 없음 |
| 스키마 안전 | 3회 연속 init → 데이터 무사 |

```
Phase 1 (인덱싱/검색):       15/15  PASS
Phase 2 (조립/의존성):        26/26  PASS
Phase 3 (시맨틱/하이브리드):   19/19  PASS
Stability (Reddit-proof):    44/44  PASS
─────────────────────────────────────
총합:                       104/104  ALL PASS
```

## 설치

> **꿀팁**: 최고의 설치 방법은? 당신의 AI 에이전트에게 부탁하세요: *"n2-arachne 설치해줘."* 알아서 다 해줍니다. 

```bash
npm install n2-arachne
```

### MCP 설정 (Claude Desktop / Cursor 등)

```json
{
 "mcpServers": {
 "n2-arachne": {
 "command": "node",
 "args": ["/path/to/n2-arachne/index.js"],
 "env": {
 "ARACHNE_PROJECT_DIR": "/path/to/your/project"
 }
 }
 }
}
```

## 설정

Arachne 디렉토리에 `config.local.js` 생성:

```javascript
module.exports = {
 projectDir: '/path/to/your/project',
 dataDir: './data',

 indexing: {
 autoIndex: true,
 maxFileSize: 512 * 1024, // 파일당 최대 512KB
 },

 // 시맨틱 검색 (Ollama 필요)
 embedding: {
 enabled: true, // 기본: false
 provider: 'ollama',
 model: 'nomic-embed-text',
 endpoint: 'http://localhost:11434',
 },

 assembly: {
 defaultBudget: 30000, // 토큰
 },
};
```

## 사용법 (MCP 도구)

Arachne는 `n2_arachne` MCP 도구를 등록합니다:

| 액션 | 설명 |
|------|------|
| `search` | BM25 키워드 검색 (+ 시맨틱) |
| `assemble` | 4-Layer 컨텍스트 조립 |
| `index` | 프로젝트 파일 인덱싱/재인덱싱 |
| `status` | 인덱싱 통계 + 임베딩 상태 |
| `files` | 인덱싱된 파일 목록 |
| `backup` | 백업 생성/목록/복원 |

### 예시: 컨텍스트 조립

```json
{
 "action": "assemble",
 "query": "HTTP 요청 타임아웃 에러 처리",
 "activeFile": "lib/executor.js",
 "budget": 20000
}
```

## Soul / QLN 연동하기

Arachne는 독립 실행도 되지만, **Soul**(세션 기억)이나 **QLN**(도구 라우팅)과 함께 쓰면 훨씬 강력합니다.

연동 방법은 간단합니다 — MCP 설정에 같이 등록하면 끝!

### Soul + Arachne 함께 쓰기

```json
{
 "mcpServers": {
 "n2-soul": {
 "command": "node",
 "args": ["/path/to/n2-soul/index.js"]
 },
 "n2-arachne": {
 "command": "node",
 "args": ["/path/to/n2-arachne/index.js"],
 "env": {
 "ARACHNE_PROJECT_DIR": "/path/to/your/project"
 }
 }
 }
}
```

> **추가 설정 필요 없음!** 두 서버를 같은 MCP 설정에 등록하면, AI가 자동으로 양쪽 도구를 사용합니다.
> - `Soul`이 이전 세션의 작업 내용과 결정을 기억
> - `Arachne`가 해당 코드를 정확하게 찾아서 AI에게 전달
> - 결과: AI가 "지난번에 뭐 했더라?" 없이 바로 이어서 작업

### 전체 N2 스택 (Soul + Arachne + QLN)

```json
{
 "mcpServers": {
 "n2-soul": {
 "command": "node",
 "args": ["/path/to/n2-soul/index.js"]
 },
 "n2-arachne": {
 "command": "node",
 "args": ["/path/to/n2-arachne/index.js"],
 "env": {
 "ARACHNE_PROJECT_DIR": "/path/to/your/project"
 }
 },
 "n2-qln": {
 "command": "node",
 "args": ["/path/to/n2-qln/index.js"]
 }
 }
}
```

> QLN까지 더하면, MCP 도구가 100개+ 있어도 AI는 QLN을 통해 필요한 도구만 자동으로 찾아 사용합니다.

## N2 에코시스템 — 함께 쓰면 더 강력

| 패키지 | 역할 | npm | 독립실행 |
|--------|------|-----|:-------:|
| **QLN** | 도구 라우팅 (1000+ 도구 → 1 라우터) | `n2-qln` | Yes |
| **Soul** | 에이전트 기억 & 세션 관리 | `n2-soul` | Yes |
| **Ark** | 보안 정책 & 코드 검증 | `n2-ark` | Yes |
| **Arachne** | 코드 컨텍스트 자동 조립 | `n2-arachne` | Yes |

> 모든 패키지는 **100% 독립 실행** 가능. 하지만 합치면 마법이 일어남:

### 시너지: 실제 동작 흐름

```
사용자: "로그인 타임아웃 버그 고쳐줘"
 │
 ▼
┌─── QLN (라우터) ──────────────────────────────────────┐
│ 1000+ 도구 → 시맨틱 라우팅으로 자동 선별: │
│ → n2_arachne.assemble (컨텍스트 조립) │
│ → n2_arachne.search (코드 검색) │
│ 토큰 비용: 1000+개 도구 대신 2개만 AI에 전달 │
└────────────────┬──────────────────────────────────────┘
 │
 ▼
┌─── Arachne (컨텍스트) ────────────────────────────────┐
│ L1: 프로젝트 트리 개요 │
│ L2: auth/login.ts (현재 작업 파일) │
│ L3: BM25 + 시맨틱 검색 → 타임아웃 관련 코드 │
│ + 의존성 체인: login.ts → api.ts → http.ts │
│ L4: 자주 접근한 설정 파일 │
│ → 30K 토큰의 완벽하게 큐레이션된 컨텍스트 │
└────────────────┬──────────────────────────────────────┘
 │
 ▼
┌─── Soul (기억) ───────────────────────────────────────┐
│ "지난 세션에서 로제가 api.ts 47번 줄의 비슷한 │
│ 타임아웃을 수정함. 결정: 30초로 증가." │
│ → 과거 컨텍스트 + 결정 사항 + 핸드오프 노트 │
│ → KV-Cache: 즉시 세션 복원 │
└────────────────┬──────────────────────────────────────┘
 │
 ▼
┌─── Ark (보안) ────────────────────────────────────────┐
│ 생성된 코드에 하드코딩된 자격증명 없음 │
│ 타임아웃 값은 config에서 로드 (매직넘버 금지) │
│ 에러 처리가 프로젝트 컨벤션 준수 │
│ → 커밋 전 코드 검증 │
└───────────────────────────────────────────────────────┘
```

### 단독 vs 통합

| 시나리오 | 단독 사용 | 통합 사용 |
|----------|----------|----------|
| **토큰 사용량** | AI가 1000+ 도구 전부 봄 | QLN이 라우팅 → AI는 2~3개만 |
| **컨텍스트 품질** | AI가 어떤 파일이 중요한지 추측 | Arachne가 정확한 관련 코드 제공 |
| **기억** | AI는 매 턴 전부 잊음 | Soul이 과거 세션 + 결정 기억 |
| **코드 안전** | 가드레일 없음 | Ark가 배포 전 검증 |
| **설정** | 각 도구 독립 동작 | 추가 설정 불필요 — 자동 연동 |

### 실전 임팩트

- **QLN + Arachne**: QLN이 요청을 Arachne로 라우팅 → Arachne가 완벽한 컨텍스트 제공 → AI가 첫 시도에 정확한 코드 생성. "그 파일이 어디였더라?" 끝.
- **Soul + Arachne**: Soul이 지난 세션 작업 내용 기억 → Arachne가 해당 파일을 우선 인덱싱 → 세션 간 연속성 보장
- **Ark + Arachne**: Arachne가 코드 컨텍스트 제공 → AI가 코드 생성 → Ark가 프로젝트 패턴 준수 검증. 버그를 배포 전에 잡음.
- **4개 전부**: AI가 **모든 걸 기억하고**, **무엇이든 찾고**, **올바른 도구를 쓰고**, **규칙을 따르는** 팀원이 됨.

## 라이선스

Apache-2.0

## Star History

Arachne가 도움이 되셨다면, 별 하나 부탁드립니다! 

[![Star History Chart](https://api.star-history.com/svg?repos=choihyunsus/n2-arachne&type=Date)](https://star-history.com/#choihyunsus/n2-arachne&Date)

---

*Arachne — 그리스 신화 최고의 직조사. 코드의 실을 엮어 완벽한 맥락을 짜냅니다.* 
