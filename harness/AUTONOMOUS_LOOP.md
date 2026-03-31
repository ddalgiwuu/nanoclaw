# Autonomous Agent Loop Protocol

## Overview

Claude Code와 Codex CLI가 자율적으로 구현-평가-수정 사이클을 수행.
Ryan은 최종 승인과 방향 결정 시에만 개입.

## Flow

```
┌─────────────────────────────────────────────────┐
│                  AUTONOMOUS LOOP                 │
│                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐   │
│  │  Claude   │───>│  Codex   │───>│  Claude  │   │
│  │  Code     │    │  CLI     │    │  Code    │   │
│  │ (구현)    │    │ (평가)   │    │ (수정)   │   │
│  └──────────┘    └──────────┘    └──────────┘   │
│       │               │               │         │
│       │          iteration N/3         │         │
│       │               │               │         │
│       └───────────────┴───────────────┘         │
│                       │                          │
│              통과 or 3회 초과                     │
│                       │                          │
└───────────────────────┼──────────────────────────┘
                        │
                        ▼
                   @Ryan 멘션
```

## Step-by-Step

### Step 1: Claude Code — 구현

1. `current-task.md` 확인 (있으면) + Lock 획득
2. Sprint Contract (DoD) 작성
3. 코드 구현 + 테스트 작성
4. 커밋 (conventional commits)
5. Handoff 파일 작성 → Codex에게 전달

### Step 2: Codex CLI — 독립 리뷰

Codex는 Claude Code의 구현을 **독립적으로** 평가:

```bash
codex --approval-mode full-auto \
  "You are a code reviewer. Evaluate this implementation.
   
   Changed files: <file_list>
   Diff: <diff_content>
   
   Eval Rubric:
   - Functionality (threshold: 6/10): Does it meet requirements? Edge cases?
   - Code Quality (threshold: 6/10): Conventions, readability, no duplication?
   - Security (threshold: 7/10): No secrets, input validation, auth checks?
   
   If project has .claude/eval/EVAL_RUBRIC.md, use those thresholds instead.
   
   Output JSON:
   {
     \"scores\": {\"functionality\": N, \"code_quality\": N, \"security\": N},
     \"pass\": true/false,
     \"feedback\": [\"actionable item 1\", \"actionable item 2\"],
     \"issues\": [{\"file\": \"path\", \"line\": N, \"issue\": \"description\"}]
   }"
```

### Step 3: Claude Code — 피드백 반영

Codex 피드백이 실패(pass: false)인 경우:
1. 피드백의 각 항목을 구체적으로 수정
2. 수정 커밋
3. 다시 Codex에게 재평가 요청

### Step 4: Codex CLI — 재평가

동일한 rubric으로 재평가. 이전 피드백 반영 여부도 체크.

### Step 5: 반복 제어

- **통과**: 모든 기준이 임계값 이상 → Step 6
- **실패 (iteration < 3)**: 피드백 → Step 3으로 돌아감
- **실패 (iteration = 3)**: Step 7로 에스컬레이션

### Step 6: 성공 → @Ryan 승인 요청

```
✅ 완료: [태스크 이름]
- PR: #NNN (있으면)
- Functionality: 8/10
- Code Quality: 7/10  
- Security: 9/10
- Iterations: 2/3
- 승인해주시면 머지하겠습니다.
```

### Step 7: 실패 → @Ryan 개입 요청

```
⚠️ 개입 필요: [태스크 이름]
- 3회 반복 후에도 미달:
  - Security: 5/10 (threshold: 7) — RLS policy 누락
  - 시도한 수정: [요약]
- 방향 결정이 필요합니다.
```

## Handoff Format

에이전트 간 작업 인수인계 시 사용:

```markdown
# Handoff: <topic>
- From: claude-code | codex
- To: claude-code | codex
- Iteration: N/3
- Project: <project-name>
- Branch: <branch-name>

## Scores
| Criterion | Score | Threshold | Pass |
|-----------|-------|-----------|------|
| Functionality | X/10 | Y | Y/N |
| Code Quality | X/10 | Y | Y/N |
| Security | X/10 | Y | Y/N |

## Feedback
1. (구체적, 실행 가능한 피드백)
2. (파일 경로 + 라인 넘버 포함)

## Action
- continue: 피드백 반영 후 재제출
- approve: 통과 → @Ryan 멘션
- escalate: 실패 → @Ryan 멘션
```

## Rules

1. **Self-eval 절대 금지**: Claude Code가 작성 → Codex가 평가. Codex가 작성 → Claude Code가 평가.
2. **피드백은 구체적**: "코드 품질 낮음" ❌ → "파일 X, 라인 Y에서 중복 로직. Z 함수로 추출 필요" ✅
3. **점수는 근거 포함**: 각 점수에 왜 그 점수인지 1-2문장 설명
4. **3회 제한 엄수**: 무한 루프 방지. 3회 후에는 반드시 사람 개입.
5. **보안 즉시 에스컬레이션**: 보안 임계값 미달은 반복 없이 즉시 @Ryan
