# NanoClaw Evaluation Rubric

## Default Criteria (프로젝트에 별도 rubric 없을 때)

| Criterion | Threshold | Description |
|-----------|-----------|-------------|
| Functionality | 6/10 | 요구사항 충족, 기본 엣지 케이스 처리 |
| Code Quality | 6/10 | 컨벤션 준수, 읽기 쉬움, 중복 없음 |
| Security | 7/10 | 시크릿 관리, 입력 검증, 인증 확인 |

**하나라도 임계값 미달 → 실패 + 구체적 피드백.**

## Project Override

프로젝트에 `.claude/eval/EVAL_RUBRIC.md`가 있으면 그 기준 사용.
프로젝트 기준은 글로벌 기준을 **상향만 가능** (하향 불가).

예: Borkd는 Security 8/10, Design Fidelity 7/10 추가.

## Scoring Guide

### Functionality
| Score | Meaning |
|-------|---------|
| 9-10 | 모든 요구사항 + 엣지 케이스 + 에러 핸들링 완벽 |
| 7-8 | 핵심 요구사항 + 주요 엣지 케이스 |
| 5-6 | 기본 기능 동작, 엣지 케이스 미처리 |
| 3-4 | 부분 동작, 주요 기능 누락 |
| 1-2 | 거의 동작 안 함 |

### Code Quality
| Score | Meaning |
|-------|---------|
| 9-10 | 프로젝트 컨벤션 완벽 + 일관 + 재사용성 높음 |
| 7-8 | 컨벤션 준수 + 읽기 쉬움 + 적절한 추상화 |
| 5-6 | 대체로 준수, 일부 패턴 불일치 |
| 3-4 | 컨벤션 위반 다수, 중복 코드 |
| 1-2 | 구조 없음, 이해 불가 |

### Security
| Score | Meaning |
|-------|---------|
| 9-10 | 완벽한 인증/인가 + 입력 검증 + 시크릿 관리 |
| 7-8 | 기본 보안 준수 + 시크릿 노출 없음 |
| 5-6 | 일부 검증 누락 |
| 3-4 | 보안 결함 존재 |
| 1-2 | 심각한 보안 위협 |

## Review Output Format

```json
{
  "scores": {
    "functionality": 8,
    "code_quality": 7,
    "security": 9
  },
  "pass": true,
  "feedback": [
    "Walk model에 distance validation 추가 필요 (음수 방지)",
    "useWalkState hook에서 cleanup 함수 누락"
  ],
  "issues": [
    {
      "file": "features/walk/hooks/use-walk-state.ts",
      "line": 42,
      "issue": "useEffect cleanup 없음 — 메모리 릭 가능"
    }
  ]
}
```

## Calibration

- 첫 10회 리뷰: Ryan이 병행 채점하여 편향 교정
- Codex가 너무 관대하면: 프롬프트에 "be skeptical, penalize mediocre code" 추가
- 분기별 재캘리브레이션
