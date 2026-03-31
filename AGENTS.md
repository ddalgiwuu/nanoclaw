# NanoClaw — Global Agent Instructions

## Identity

- **Host**: Mac Mini (launchd daemon)
- **Internal Agents**: Claude Code (Claude SDK) + Codex CLI
- **Channel**: Telegram + Discord (per-project)
- **Operator**: Ryan Song (최소 개입 — 최종 승인/방향 결정만)

## Core Principle: Autonomous Loop

Claude Code와 Codex CLI가 자율적으로 소통하며 작업.
Ryan은 최종 승인과 방향 결정 시에만 개입.

**절대 규칙:**
1. Self-eval 금지 — Claude Code가 작성한 코드는 Codex가 평가 (반대도 동일)
2. Sprint contract (DoD) 없이 코드 시작 금지
3. 보안 이슈는 즉시 @Ryan 멘션
4. 같은 유형 실패 2번 반복 금지 — 1번이면 수정, 2번이면 하네스 결함

## Autonomous Agent Loop

Details: `harness/AUTONOMOUS_LOOP.md`

```
1. Claude Code: 구현 + 테스트 + 커밋
2. Codex CLI: 독립 리뷰 (eval rubric) → 피드백
3. Claude Code: 피드백 반영 → 수정 커밋
4. Codex CLI: 재평가
5. 반복 (최대 3회)
6. 전부 통과 → @Ryan 최종 승인 요청
7. 3회 초과 실패 → @Ryan 개입 요청
```

## @Ryan 멘션 조건

Details: `harness/MENTION_PROTOCOL.md`

| 상황 | 메시지 | 우선순위 |
|------|--------|----------|
| 모든 eval 통과 | "완료: [태스크] — 승인 요청" | 일반 |
| 3회 반복 후 미달 | "개입 필요: [태스크] — [이유]" | 높음 |
| 보안 이슈 | "긴급: [설명]" | 긴급 |
| 설계 결정 필요 | "결정 필요: [A vs B]" | 중간 |
| 리소스 한도 80%+ | "리소스 경고: [현황]" | 낮음 |

**그 외 모든 상황은 에이전트끼리 해결.**

## Task Priority

1. **CRITICAL**: 보안 알림, main/staging CI 실패 (즉시)
2. **HIGH**: PR 리뷰, develop 테스트 실패 (30분 내)
3. **MEDIUM**: 주간 GC, 문서 체크 (다음 사이클)
4. **LOW**: 개선 제안, 기술 부채 (유휴 시)

## Eval Standards

Details: `harness/EVAL_RUBRIC.md`

- 프로젝트에 `.claude/eval/EVAL_RUBRIC.md` 있으면 그것 사용
- 없으면 기본: Functionality 6, Code Quality 6, Security 7
- 하드 임계값 미달 → 실패 + 구체적 피드백

## Codex CLI Integration

Details: `harness/CODEX_INTEGRATION.md`

크로스 밸리데이션 시 Codex CLI를 컨테이너에서 실행.
전체 diff + 관련 파일 컨텍스트 제공, 구조화 JSON 응답 요청.

## Security Baseline

Details: `harness/SECURITY_BASELINE.md`

- mount-allowlist: 프로젝트 디렉토리만 허용
- blockedPatterns: .ssh, .gnupg, .aws, credentials, .secret, id_rsa
- 비메인 그룹: 기본 read-only
- 타임아웃 강제 (default 600s)

## Resource Limits

- MAX_CONCURRENT_CONTAINERS: 3
- MAX_DAILY_RUNS: 50
- CONTAINER_TIMEOUT: 600000 (10분)
- IDLE_TIMEOUT: 300000 (5분)

## Monitoring

- 10분 하트비트 → control 채널
- 일일 23:55 리포트 (실행 횟수, 런타임, 비용 추정)
- 30분+ 미응답 → alerts 채널

## Garbage Collection (주간)

- 문서 ↔ 코드 일관성 검사
- 미사용 코드/import 탐지
- 아키텍처 위반 스캔
- 보안 감사 (시크릿, 권한)
- 테스트 커버리지 갭
- Stale 컨텍스트 파일 정리 (90일+)
