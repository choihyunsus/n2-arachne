# 🕸️ Arachne (n2-arachne)

[![npm version](https://img.shields.io/npm/v/n2-arachne.svg)](https://www.npmjs.com/package/n2-arachne)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)

> 거미줄처럼 코드를 엮어 AI에게 최적의 컨텍스트를 조립하는 MCP 서버 🕷️

## 문제

AI 코딩 어시스턴트는 매 턴마다 **기억상실**에 걸립니다. 프로젝트가 커지면 소스코드 전체를 컨텍스트에 올릴 수 없고, AI가 관련 파일을 모르면 **부정확한 코드**를 생성합니다.

## 해결

Arachne는 **로컬 퍼스트 MCP 서버**로, AI에게 자동으로 최적의 코드 컨텍스트를 조립합니다:

### 왜 Arachne인가?

- 💰 **토큰 절약 = 비용 절약** — 관련 코드만 전달. 200K 덤프 대신 30K 예산 = 실제 API 비용 절감
- 🧠 **"Lost in the Middle" 극복** — 출력 순서 배치(L1→L3→L4→L2)로 핵심 컨텍스트가 프롬프트 중간에 묻히는 문제 방지 ([논문 근거](https://arxiv.org/abs/2307.03172))
- 🔓 **제로 외부 의존** — Docker 없음, 클라우드 없음, API 키 불필요. `npm install`이면 끝
- ⚡ **초고속** — 21개 파일 인덱싱 12ms. 증분 업데이트는 밀리초 단위
- 📦 **초경량** — 의존성 3개: `better-sqlite3`, `sqlite-vec`, `zod`. 그게 전부
- 🆓 **100% 무료 & 오픈소스** — Apache-2.0, 숨겨진 비용 없음, 텔레메트리 없음
- 🔌 **플러그 앤 플레이** — MCP 설정 추가 → 끝. 프로젝트 코드 수정 불필요
- 🌍 **다국어 의존성 추적** — JS/TS, Python, Rust, Go import 체인 자동 분석

```
프로젝트 → [인덱싱] → SQLite → [4-Layer 조립] → AI가 완벽한 맥락을 받음
```

## ✨ 핵심 특징

| 기능 | 설명 |
|------|------|
| 🔌 **MCP 표준** | Claude, Gemini, GPT, Ollama — 어떤 AI든 OK |
| 💾 **로컬 퍼스트** | 모든 인덱싱이 로컬 SQLite. 외부 전송 제로 |
| ⚡ **증분 인덱싱** | 변경된 파일만 업데이트. 초 단위 갱신 |
| 🧠 **하이브리드 검색** | BM25 키워드 + 시맨틱 벡터 검색 (Ollama 임베딩) |
| 🕸️ **4-Layer 조립** | 토큰 예산 내에서 스마트 컨텍스트 페이징 |
| 🔗 **의존성 그래프** | JS/TS, Python, Rust, Go import 체인 추적 |
| 🗃️ **백업 & 복구** | SQLite 온라인 백업 + 백업 내 검색 |

## 🏗️ 아키텍처: 4-Layer 컨텍스트 조립

```
┌─────────────────────────────────────────────┐
│              토큰 예산 (예: 30K)              │
├────────────┬────────────────────────────────┤
│ L1: Fixed  │ 파일 트리 개요 (10%)            │
│ (고정)      │ 프로젝트 구조 스냅샷            │
├────────────┼────────────────────────────────┤
│ L2: Short  │ 현재 파일 + 최근 (20%)          │
│ (단기)      │ 지금 작업 중인 파일              │
├────────────┼────────────────────────────────┤
│ L3: Assoc  │ 검색 + 의존성 (50%) ★           │
│ (연관)      │ BM25 + 시맨틱 + 의존성 체인     │
├────────────┼────────────────────────────────┤
│ L4: Spare  │ 자주 접근한 파일 (20%)           │
│ (예비)      │ 가장 많이 쓰는 파일              │
└────────────┴────────────────────────────────┘

출력 순서: L1 → L3 → L4 → L2  ("Lost in the Middle" 방지)
```

## 🧠 시맨틱 검색 (선택, 제로 록인)

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

## 🛡️ 안정성: 104개 테스트, 실패 제로

Arachne는 프로덕션용입니다. 모든 엣지 케이스가 테스트됨:

| 카테고리 | 테스트 내용 |
|----------|------------|
| 💉 SQL 인젝션 | Bobby Tables 포함 5종 공격 패턴 방어 |
| 🛡️ Null/빈 입력 | null, undefined, 빈 문자열 → 안전 반환 |
| 🐘 거대 입력 | 10KB 쿼리 → 크래시 없음 |
| 🔣 특수문자 | 유니코드, 이모지, 정규식 문자 → 처리됨 |
| 🔌 Ollama 끊김 | 잘못된 엔드포인트 → BM25 폴백 |
| 🔄 멱등성 | 3회 연속 인덱싱 → 동일 결과 |
| 💰 극단적 예산 | 예산 0, 1, 100만 → 전부 안전 |
| 📊 Edge topK | topK = -1, 0, 99999 → 크래시 없음 |
| 💾 스키마 안전 | 3회 연속 init → 데이터 무사 |

```
Phase 1 (인덱싱/검색):       15/15 ✅
Phase 2 (조립/의존성):        26/26 ✅
Phase 3 (시맨틱/하이브리드):   19/19 ✅
Stability (Reddit-proof):    44/44 ✅
─────────────────────────────────────
총합:                       104/104 ✅
```

## 📦 설치

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

## 🔧 설정

Arachne 디렉토리에 `config.local.js` 생성:

```javascript
module.exports = {
    projectDir: '/path/to/your/project',
    dataDir: './data',

    indexing: {
        autoIndex: true,
        maxFileSize: 512 * 1024,    // 파일당 최대 512KB
    },

    // 시맨틱 검색 (Ollama 필요)
    embedding: {
        enabled: true,              // 기본: false
        provider: 'ollama',
        model: 'nomic-embed-text',
        endpoint: 'http://localhost:11434',
    },

    assembly: {
        defaultBudget: 30000,       // 토큰
    },
};
```

## 🚀 사용법 (MCP 도구)

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

## 🌐 N2 에코시스템

| 패키지 | 역할 | npm |
|--------|------|-----|
| **QLN** | 도구 라우팅 (1000+ 도구 → 1 라우터) | `n2-qln` |
| **Soul** | 에이전트 기억 & 세션 관리 | `n2-soul` |
| **Ark** | 보안 정책 & 코드 검증 | `n2-ark` |
| **Arachne** | 코드 컨텍스트 자동 조립 🕸️ | `n2-arachne` |

> 각 패키지는 **독립 실행 가능**하며, 함께 쓰면 시너지 극대화.
> 어떤 AI 프로바이더, 어떤 클라우드에서든 동작합니다.

## 📄 라이선스

Apache-2.0

---

*Arachne — 그리스 신화 최고의 직조사. 코드의 실을 엮어 완벽한 맥락을 짜냅니다.* 🕷️
