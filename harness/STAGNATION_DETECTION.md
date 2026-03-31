# Stagnation Detection Protocol

## Overview

Owner↔Reviewer 루프에서 정체를 감지하고 Arbiter를 자동 소환하는 규칙.

## Patterns

### 1. Spinning (같은 에러 반복)

**감지**: 같은 에러 메시지/같은 파일에서 3+ 턴 연속 실패

**대응**:
1. Owner: 현재 접근 중단
2. Owner: 완전히 다른 접근 시도 (같은 fix 반복 금지)
3. 2번째 접근도 실패 → Arbiter 소환

**예시**:
- Turn 1: "TypeError at line 42" → fix → Turn 2: "TypeError at line 42" → fix → Turn 3: "TypeError at line 42"
- → Spinning 감지. 접근 전환 또는 Arbiter.

### 2. Oscillation (접근 교대)

**감지**: 접근 A → 접근 B → 접근 A 패턴

**대응**:
1. 양측 즉시 멈춤
2. Arbiter 소환 — 하나를 선택하거나 C 방향 제시

**예시**:
- Turn 1: "useEffect로 해결" → Turn 2: "아니 useMemo가 맞다" → Turn 3: "다시 useEffect로" 
- → Oscillation 감지. Arbiter 소환.

### 3. Diminishing Returns (개선폭 감소)

**감지**: 최근 2+ 턴에서 점수 개선 < 1점/턴

**대응**:
1. 현재 수준이 임계값을 넘으면 → 수용 (DONE_WITH_CONCERNS)
2. 임계값 미달이면 → Arbiter 소환

**예시**:
- Turn 1: Security 4/10 → Turn 2: 5/10 → Turn 3: 5/10 → Turn 4: 5/10
- → Diminishing returns. 임계값(7) 미달이므로 Arbiter 소환.

### 4. No Progress (토론만)

**감지**: 2+ 턴 연속 코드 변경(커밋) 없이 토론만 진행

**대응**:
1. 패턴 명명: "No progress detected"
2. Owner에게 즉시 구현 지시
3. 다음 턴에도 코드 없으면 → Arbiter 소환

## Report Format

정체 감지 시 Handoff에 포함:

```markdown
## Stagnation Check
- Pattern: Spinning | Oscillation | Diminishing returns | No progress | None
- Turns affected: N
- Action: continue | switch approach | summon arbiter
- Evidence: [구체적 증거]
```

## Arbiter 소환 기준 (자동)

다음 중 하나라도 해당:
- [ ] 같은 에러 3+ 턴
- [ ] 접근 A→B→A 교대
- [ ] 2+ 턴 점수 변화 < 1점
- [ ] 2+ 턴 코드 변경 없음
- [ ] DONE_WITH_CONCERNS에서 같은 우려 2+ 턴 반복
- [ ] BLOCKED 상태 2+ 턴 지속

## Ryan 멘션 없이 해결 가능한 것

- 린트/타입 에러 → 자동 수정
- 테스트 실패 → 디버깅 + 수정
- 커밋 메시지 포맷 → 재작성
- 문서 불일치 → GC에서 자동 PR
- Codex 일시적 API 오류 → 재시도
- Owner↔Reviewer 의견 차이 → Arbiter가 판결
