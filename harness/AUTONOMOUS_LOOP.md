# Autonomous Tribunal Loop Protocol

## Overview

3-Agent Tribunal: **Owner** (구현) ↔ **Reviewer** (검증) ↔ **Arbiter** (중재).
Ryan은 ESCALATE 또는 작업 완료 시에만 개입.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    TRIBUNAL LOOP                      │
│                                                       │
│   ┌──────────┐         ┌──────────┐                  │
│   │  Owner    │────────>│ Reviewer  │                  │
│   │ (Claude)  │<────────│ (Codex)   │                  │
│   │ 구현+커밋  │ feedback│ 리뷰+채점  │                  │
│   └──────────┘         └──────────┘                  │
│        │                     │                        │
│        │    교착 감지 시      │                        │
│        │         ┌──────────┐│                        │
│        └────────>│ Arbiter  │<┘                        │
│                  │ (중재자)  │                          │
│                  │ 판결 발행 │                          │
│                  └──────────┘                          │
│                       │                                │
│           PROCEED / REVISE / RESET / ESCALATE         │
└───────────────────────┼────────────────────────────────┘
                        │
              ESCALATE → @Ryan
              DONE → @Ryan 승인 요청
```

## Step-by-Step

### Step 1: Owner (Claude Code) — 구현

1. `current-task.md` 확인 + Lock 획득
2. Sprint Contract (DoD) 작성
3. 코드 구현 + 테스트 작성
4. 커밋 (conventional commits)
5. Handoff → Reviewer에게 전달

**첫 줄 필수**: `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`

### Step 2: Reviewer (Codex CLI) — 독립 리뷰

Eval rubric 기준으로 독립 평가. Critical Review Framework 적용:

1. **Essence** — 명시된 문제가 실제 문제인가?
2. **Root cause** — 근본 원인을 고치는가?
3. **Prerequisites** — 이 접근이 동작하려면?
4. **Hidden assumptions** — 틀릴 수 있는 가정은?

**피드백 원칙:**
- "코드 품질 낮음" ❌ → "파일 X, 라인 Y에서 중복 로직. Z 함수로 추출 필요" ✅
- 이슈 발견 시 구체적 지시: "Owner, fix X in file Y"
- 옳을 때 입장 고수. 증거로 반박.
- 문제 없으면 빠르게 승인.

**첫 줄 필수**: `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`

### Step 3: Owner — 피드백 반영

Reviewer 피드백이 실패인 경우:
1. 각 피드백 항목 구체적 수정
2. Reviewer의 추론도 비판적 검증 (무조건 수용 금지)
3. 수정 커밋
4. Reviewer에게 재평가 요청

**자신감은 증거가 아니다:**
- "작동할 것 같다" → 실행해봐라
- "확신한다" → 증거 없으면 무의미
- "아까 테스트했다" → 코드 변경 후면 다시 테스트
- "사소한 변경" → 그래도 검증

### Step 4: Stagnation Detection

다음 패턴 감지 시 **Arbiter 자동 소환**:

| 패턴 | 기준 | 감지 방법 |
|------|------|----------|
| Spinning | 같은 에러 3+ 턴 | 에러 메시지/파일 비교 |
| Oscillation | A→B→A 접근 교대 | 접근 방식 추적 |
| Diminishing returns | 점수 개선 < 1점/턴 | 점수 추이 비교 |
| No progress | 토론만 2+ 턴, 코드 변경 0 | 커밋 유무 확인 |

### Step 5: Arbiter — 중재 (교착 시 자동 소환)

Owner↔Reviewer 대화 히스토리를 읽고 **구속력 있는 판결** 발행:

- **PROCEED** — Owner가 맞음. Reviewer는 승인. 왜 Owner가 맞고 Reviewer가 놓친 것은 무엇인지 설명.
- **REVISE** — Reviewer 우려가 타당. Owner에게 구체적 수정 지시 (파일, 라인, 액션).
- **RESET** — 양쪽 다 비생산적 경로. 새로운 구체적 방향 제시.
- **ESCALATE** — 사람 판단 필요. 사용 조건:
  - 사용자 허가/승인/결정이 필요한 상황
  - 이전 PROCEED 후 같은 이슈 재발 → PROCEED 반복 금지, ESCALATE
  - NEEDS_CONTEXT/BLOCKED가 해결 안 되는 경우

**Arbiter 규칙:**
- 증거 기반 판단 (누가 먼저 말했는지 무관)
- 판결은 해당 교착 사이클에서 최종
- 코드 구현/리뷰 안 함 — 판결만
- Owner가 사용자에게 질문하는 상황 → 무조건 ESCALATE

### Step 6: 성공 → @Ryan 승인 요청

```
✅ 완료: [태스크 이름]
- Scores: F:8 / CQ:7 / S:9
- Iterations: 2
- Branch: feat/xxx
- 승인 요청합니다.
```

### Step 7: ESCALATE → @Ryan 개입 요청

```
⚠️ 개입 필요: [태스크 이름]
- 상황: [Arbiter 판결 요약]
- Owner 주장: [1줄]
- Reviewer 주장: [1줄]
- 필요한 결정: [구체적]
```

## Handoff Format

```markdown
# Handoff: <topic>
- From: owner | reviewer | arbiter
- To: owner | reviewer | arbiter
- Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- Iteration: N
- Project: <project-name>
- Branch: <branch-name>

## Scores
| Criterion | Score | Threshold | Pass |
|-----------|-------|-----------|------|
| Functionality | X/10 | Y | Y/N |
| Code Quality | X/10 | Y | Y/N |
| Security | X/10 | Y | Y/N |

## Feedback
1. (구체적, 파일:라인 포함)

## Stagnation Check
- Spinning: N/A | detected
- Oscillation: N/A | detected
- Progress: improving | stalled | regressing

## Action
- continue: 피드백 반영 후 재제출
- approve: @Ryan 승인 요청
- arbiter: 교착 → 중재 소환
- escalate: @Ryan 개입 요청
```

## Rules

1. **Self-eval 절대 금지**
2. **자신감은 증거가 아니다** — 실행 결과만 증거
3. **피드백은 구체적** — 파일:라인 + 액션
4. **Arbiter 판결은 구속력** — 따르지 않으면 ESCALATE
5. **Owner↔Reviewer 루프 중 @Ryan 멘션 금지** — 시스템이 자동 처리
6. **구현과 커밋은 양측 합의 필요** — 한쪽이 거부권
7. **보안 즉시 ESCALATE** — 반복 없이 즉시
