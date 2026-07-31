# CharterMesh 제품·아키텍처 설계서

작성: CharterMesh 초기 설계 기록

작성일: 2026-07-27

상태: **신규 독립 프로젝트용 제품·아키텍처 설계 기준**

개정 상태: **2026-07-29 범용 부트스트랩·액션 투영 실행 슬라이스 반영**

> 이 문서의 최초안 이후 Codex와 Claude Code의 네이티브 협업 기능이
> 확장되었고, 제품은 특정 LLM이나 agent host에 의존하지 않는 방향으로
> 구체화되었다. 아래 `엔진·호스트 중립성 갱신`과 `협업 런타임 갱신`은
> 공급자 실행·예약·세션 오케스트레이션에 관한 뒤 절의 기존 표현보다
> 우선한다. 제품의 정본, 승인, 원장과 보안 원칙은 그대로 유지한다.

주의: 이 문서는 비공개 레거시 운영 시스템을 공개하거나 수정하기 위한
승인이 아니다. 구현은 레거시 시스템과 경로·저장소·데이터·배포 단위를
분리한 신규 프로젝트에서만 수행한다. 실제 작업 DB, 검수자료, 로그,
프롬프트와 비공개 운영 규칙은 이 프로젝트에 복사하지 않는다.

## 범용 적용·팀 콘솔 갱신 — 2026-07-29

### 한 문장 적용 경험

사용자는 Codex, Claude Code 또는 다른 코딩 agent에게 공개 저장소 URL과
“이 프로젝트에 CharterMesh를 적용해줘”라는 요청만 전달할 수 있어야 한다.
모든 host별 안내는 공통 `BOOTSTRAP.md`로 연결한다. 공통 흐름은 다음과
같다.

```text
read-only inspect → deterministic plan → exact human hash approval
                  → CLI apply → doctor → optional offline smoke
```

최초 요청은 읽기 검사와 계획 생성의 권한이다. 아직 존재하지 않았던 계획의
쓰기 승인은 아니다. agent는 현재 target content hash가 결박된 계획을
보여준 뒤 사람에게 그 hash의 승인을 받아야 한다. CLI 사용자는 같은 명령과
같은 승인 절차를 직접 수행한다.

### 액션 중심 운영 투영

Team Console의 첫 화면은 status 통계보다 `누가 지금 무엇을 해야 하는가`를
우선한다. 서버가 하나의 `DashboardProjection`을 계산하고 CLI와 UI가 이를
공유한다.

`UserAction`은 최소한 category, reason, actor, CTA, actionable,
blockedBy, priority와 선택적 expiresAt을 가진다. 우선순위는 사람 검토,
사용자 입력, 미배정 intake, 변경 요청 재개, 시작 가능 작업, 가시적 대기
순이다. 실패한 WorkItem은 검사와 명시적 수동 재시도를 위한 이력으로
보존하지만 actionable 또는 사람 검토 수에 포함하지 않는다. 일반 대기도
화면에는 남지만 actionable count에는 들어가지 않는다. 첫 화면의 기본
필터는 실제 actionable 작업이다.

사람 검토에는 현재 진행을 막고 있는 최신 artifact 결정과 정확한 tool-call
승인만 들어간다. `changes_requested`는 검토가 끝난 뒤 담당 role/runner가
보완할 작업이며 사람 검토로 다시 세지 않는다. 대신 최신 검토 결정과
사유를 WorkItem 옆에 보존해 무엇을 수정해야 하는지 바로 읽을 수 있어야
한다.

모든 대기는 `WaitCondition`으로 표현한다.

```text
type: predecessor | not_before | user_input | manual_resume | approval
reason: 사람이 이해할 수 있는 이유
reference/resumeAt: 재개 조건
createdBy: 대기를 만든 actor
```

선행조건 해소 시 successor는 정확히 한 번 다시 드러난다. root intake와
parent/child 계보는 유지하며, 잘못된 dependency는 history를 지우지 않고
비활성화하는 방향으로 확장한다.

### 명령·실행·검토 불변식

- SQLite Control Plane이 유일한 mutable WorkItem ledger다.
- 모든 mutation은 actor와 idempotency key를 가진 명령이다.
- claim은 Run, Attempt, Lease, generation을 한 transaction에서 만든다.
- runner artifact는 active generation fencing을 통과해야 한다.
- 사람 검토는 최신 immutable artifact SHA-256과 정확히 결박한다.
- 결과 검토 승인과 외부 side-effect 실행 승인은 별개다.
- API는 credential, 환경변수 값, DB·artifact·project 절대경로를 반환하지
  않는다.

UI 세부 계약은 `docs/DASHBOARD-DESIGN.md`, 결정 근거는
`docs/adr/0009-universal-bootstrap-action-projection.md`에서 추적한다.

## 엔진·호스트 중립성 갱신 — 2026-07-27

### 갱신 결론

Codex와 Claude Code는 필수 엔진이 아니다. 이들은 자체 세션·도구·협업
기능과 모델 선택을 소유하는 선택적 `AgentHost` adapter다. 어떤 LLM이든
최소 `ModelEngine` 계약을 구현하면 제품의 `ManagedRunner`에 연결할 수
있다.

| 개념 | 책임 | 금지되는 책임 |
|---|---|---|
| `ModelEngine` | 메시지 기반 추론, streaming/cancel, token·cost usage | WorkItem, 도구 실행, workspace, 승인, schedule, 조직 원장 |
| `ManagedRunner` | tool loop, workspace, 승인 pause/resume, retry, Control Plane 결박 | 특정 모델 공급자에 대한 core 의존 |
| `AgentHost` | 외부 제품의 session, tool, native collaboration·schedule | OrgSpec, WorkItem, 사람 승인 정본 |
| `ExecutionTarget` | role이 선택하는 managed runner 또는 agent host | raw model engine 직접 선택 |

`ManagedRunner`는 주입 가능한 `ModelEngine`을 사용한다. 반대로 Codex·
Claude Code처럼 모델을 호스트가 관리하는 `AgentHost`에는 외부 engine을
주입하지 않는다. 이 차이를 숨기지 않고 manifest의 `engineBinding`으로
검증한다.

capability namespace도 책임에 따라 분리한다.

- `model.*`: `model.text.generate`, `model.structured_output`,
  `model.tool_calling`, multimodal 입력 등
- `runner.*`: tool loop, checkpoint, deterministic retry 등
- `host.*`: session, approval callback, subagent, peer team, worktree 등
- `schedule.*`: local, hosted, chat-continuation native schedule
- `integration.*`: plugin, skill, MCP, hook, protocol surface

role의 preferred와 모든 fallback은 모델 요구와 호스트 요구를 각각
충족해야 한다. 한쪽 capability가 다른 쪽의 결손을 대신할 수 없다.
text generation만 가능한 LLM도 그 수준의 역할에는 사용할 수 있지만,
structured output이나 tool calling emulation은 명시적 opt-in과 degraded
표시가 필요하다. 지원하지 않는 기능은 조용히 축소하지 않는다.

OrgSpec은 desired profile과 참조를 저장하고, 실제 탐지 결과는 adapter
manifest로 분리한다. compiler는 두 입력을 대조하며 발견된 capability
snapshot의 hash를 InstallPlan에 결박한다. 따라서 설치 승인 뒤 runtime
기능이 달라지면 같은 OrgSpec이라도 새 계획과 승인이 필요하다.

기본 E2E와 MVP 완료 기준은 `fake/generic ModelEngine + built-in
ManagedRunner`다. Codex·Claude Code adapter는 별도 호환성 시험이며,
둘 중 하나의 설치나 계정이 core 완성 조건이 아니다. 상세 결정은
`docs/adr/0008-model-engine-agent-host-separation.md`에서 추적한다.

## 협업 런타임 갱신 — 2026-07-27

### 갱신 결론

Codex의 subagent·custom agent·goal·thread·worktree·scheduled task와
Claude Code의 subagent·agent team·background agent·worktree·routine은
더 이상 제품이 새로 구현해야 할 원시 실행 기능으로 보지 않는다. 이들은
adapter가 탐지하고 선택적으로 사용하는 `HostOrchestrationCapability`다.

다만 공급자 네이티브 협업 기능은 다음을 대체하지 않는다.

- 승인된 `OrgSpec`과 조직 revision
- 공급자 중립 WorkItem, Run, Attempt, Lease와 TaskPacket
- 사람 승인, 비용·권한 정책과 감사 이벤트
- 교차 공급자 상태, desired schedule과 drift
- no-work-no-model을 보장하는 기본 controller

즉, 이 제품은 네이티브 agent 실행을 재구현하는 대신 그 위에서 조직
의도·거버넌스·교차 공급자 운영을 소유한다.

### 네 계층의 명시적 경계

| 계층 | 소유자 | 예 |
|---|---|---|
| Organization control | 이 제품 | OrgSpec, 정책, WorkItem, 승인, 예산, 감사 |
| Host orchestration | 공급자 host | subagent, agent team, thread, goal, worktree |
| Integration surface | adapter | app-server, SDK, CLI, MCP, plugin, skill, hook |
| Native automation | 공급자 host | local scheduled task, hosted routine, chat follow-up |

공급자 host의 shared task list, 대화 history, goal 상태 또는 schedule
history를 제품 DB의 정본으로 승격하지 않는다. adapter는 이를 외부
projection과 실행 증거로 정규화한다.

### 공급자 중립 오케스트레이션 의도

`OrgSpec` role과 stage는 필요할 때 다음 의도를 선언할 수 있다.

```yaml
orchestration:
  strategy: single        # single | delegated | peer_team
  maxWorkers: 1
  workspaceIsolation: required  # required | preferred | shared_read_only
  communication: parent_only    # parent_only | peer_messages
  humanApprovalAuthority: control_plane_only
```

이는 특정 공급자의 agent 파일이나 팀 설정을 core schema에 넣기 위한
필드가 아니다. compiler는 의도를 adapter capability와 대조하여
`native`, `emulated`, `degraded`, `manual_step_required`,
`unsupported` 중 하나로 계획한다.

초기 capability namespace는 최소한 다음을 구분한다.

- `host.session.start`, `host.session.resume`, `host.session.fork`,
  `host.session.steer`, `host.session.interrupt`
- `host.delegate.subagent`, `host.delegate.custom_agent`,
  `host.delegate.peer_team`
- `host.workspace.isolated`, `host.goal.continuation`,
  `host.approval.pause_resume`
- `schedule.native.local`, `schedule.native.hosted`,
  `schedule.native.chat_continuation`
- `model.text.generate`, `model.structured_output`, `model.tool_calling`,
  `model.stream.events`, `model.usage.reporting`
- `integration.plugin`, `integration.skill`, `integration.mcp`,
  `integration.lifecycle_hook`

capability는 단순 boolean이 아니라 `stability`, `surface`, `minVersion`,
`permissionBehavior`, `workspaceIsolation`, `costVisibility`와 제약을 함께
반환한다. experimental 기능은 기본 자동 적용 대상이 아니다.

### Codex 갱신

- 현재 Codex는 독립 작업을 subagent로 위임하고 spawn·steer·wait·interrupt
  할 수 있다. 프로젝트 `.codex/agents/*.toml` custom agent도 지원한다.
- subagent는 별도 context를 사용하지만 부모 turn의 sandbox와 permission
  경계를 상속한다. 이 상속은 제품의 사람 승인을 충족하지 않는다.
- 여러 쓰기 작업은 동일 checkout 공유가 아니라 별도 worktree를 기본으로
  계획한다. 읽기·검수 작업은 병렬화하되 비용 상한에 포함한다.
- Goal은 장기 작업의 사용자 경험과 세션 연속성 capability다. 제품의
  durable WorkItem/Run 완료조건과 kill switch를 대체하지 않는다.
- Codex scheduled task는 앱/웹의 관리 surface이며 로컬 프로젝트 또는
  worktree에서 실행될 수 있다. 공식 programmatic 관리 계약을 확인할 수
  없으면 adapter는 임의 API를 만들지 않고 설치 계획을 `UserAction`으로
  낸다.
- 저수준 실행 연동은 stable app-server JSON-RPC 또는 SDK를 우선하고,
  설치된 Codex 버전에서 schema를 생성·pin한다. experimental app-server
  method는 별도 capability opt-in과 호환성 테스트가 필요하다.
- plugin은 skill과 MCP를 배포하는 사용자-facing package다. plugin
  설치 여부를 Control Plane 실행 API의 존재와 혼동하지 않는다.

### Claude Code 갱신

- subagent는 집중된 하위 작업, agent team은 peer communication과 shared
  task가 필요한 복잡한 협업에 사용할 수 있다.
- agent team은 현재 experimental·기본 비활성 capability로 취급한다.
  project-level team 설정이 정본이라고 가정하지 않는다.
- 팀원은 lead permission을 상속하며 agent team 자체는 worktree 격리를
  보장하지 않으므로 파일 소유권 분할 또는 별도 isolated session이 필요하다.
- local Desktop scheduled task, hosted routine, session-scoped `/loop`를
  서로 다른 capability로 모델링한다. `/loop`는 durable schedule이 아니다.
- hosted routine처럼 실행 중 승인 prompt가 없는 surface는 R2/R3 행동의
  실행 호스트로 기본 선택하지 않는다.

### 승인·비용·상태 정규화

- host permission prompt, automatic approval reviewer와 model review는
  `human` approval을 대신할 수 없다.
- parent와 child agent의 모든 실제 모델 실행은 별도 Attempt 또는
  child-attempt usage로 계측한다. 측정할 수 없으면 `unknown`으로 둔다.
- host가 자체 task id나 session id를 만들더라도 Control Plane의
  WorkItem·Run id와 generation에 결박한다.
- 네이티브 agent가 늦게 완료한 결과도 lease fencing 검사를 통과해야
  artifact로 승격할 수 있다.
- host-native orchestration이 사라지거나 experimental 상태가 바뀌면
  capability drift로 기록하고 자동 권한 확대 fallback은 금지한다.

### 이 갱신이 추가하는 필수 시험

- native delegation 미지원 시 deterministic fallback 또는 명시적 거부
- child agent 비용·상태·artifact의 parent Run 결박
- parent/child permission 상속이 사람 승인으로 오인되지 않음
- 병렬 쓰기 시 worktree 또는 명시적 파일 소유권 격리
- 중단·steer·부분 실패 뒤 active child 정리
- experimental peer team의 capability drift
- native schedule surface별 승인·workspace·missed-run 의미 차이
- Goal/chat continuity 손실 뒤 DB 정본으로 복구
- provider-native shared task와 Control Plane WorkItem의 중복 실행 방지

상세 판단과 검증 근거는 `docs/adr/0005-native-collaboration-boundary.md`와
`docs/REQUIREMENTS.md`에서 추적한다.

## 0. 한 줄 정의와 결론

> 사용자의 업무 목표를 인터뷰한 C레벨 에이전트가 팀·역할·프롬프트·
> 워크플로·승인 규칙·예약 작업·수동 세션 지침을 공급자 중립 명세로
> 설계하고, 이를 임의의 LLM engine과 managed runner 또는 외부 agent
> host에 컴파일한 뒤
> 하나의 대시보드에서 업무·승인·실행·비용을 운영하게 하는 로컬 우선
> 오픈소스 시스템.

이 제품은 Jira 복제품이 아니며, 자체 `ManagedRunner`도 차별화의 전부가
아니다. 핵심 계층은
**Goal-to-Organization Compiler + 운영 거버넌스 제어판**이다. 기존
LLM API는 `ModelEngine`으로, Claude Code, Codex, GitHub Agentic
Workflows, CrewAI, Microsoft Agent Framework 등은 필요할 때
`AgentHost` 또는 integration adapter로 이용한다.

권장 제품 범주와 표현은 다음과 같다.

- CharterMesh
- Organization-as-Code for AI Agents
- AI Team Compiler & Operations Console
- Agentic Workflow Operating Kit

## 1. 해결하려는 문제

현재 에이전트 도구는 개별 agent, skill, workflow, schedule을 만들 수
있지만 사용자가 다음을 직접 설계해야 하는 경우가 많다.

1. 자기 업무에 어떤 역할과 팀이 필요한지
2. 어떤 팀을 상시·수동·예약·이벤트 실행으로 둘지
3. 어떤 작업을 어느 공급자와 모델에 맡길지
4. 무엇을 자동화하고 어디에서 사람 승인을 받을지
5. 팀 간 선후행·인수인계·산출물 계약을 어떻게 정의할지
6. 실행 결과·승인·비용·실패를 어디에서 통합 관리할지
7. 운영 결과를 보고 조직을 언제 통폐합하거나 일정을 바꿀지

이 제품은 위 설계 부담을 최초 C레벨 대화와 결정적 컴파일러로 줄인다.
사용자는 업무와 제약을 설명하고 조직안을 승인한다. 시스템은 승인된
조직을 설치하고 운영 상태를 대시보드에 투영한다.

## 2. 핵심 사용자 경험

### 2.1 최초 설치

1. 사용자가 신규 프로젝트에 패키지를 설치한다.
2. 로컬 Control Plane, SQLite DB, 대시보드가 시작된다.
3. 설치기는 Claude Code, Codex, 로컬 CLI, MCP, Git 사용 가능 여부와
   운영체제를 탐지한다.
4. 설치기는 자격증명 값을 읽거나 복사하지 않는다. 로그인·키 등록·권한
   확대가 필요하면 사용자 작업으로 생성한다.
5. 사용자가 지원되는 환경에서 `organization-bootstrap` C레벨 skill을
   시작한다.

### 2.2 C레벨 조직 설계 인터뷰

C레벨은 최소한 다음을 확인한다.

- 조직 또는 프로젝트의 목적과 주요 산출물
- 반복 업무와 일회성 업무
- 저장소, 문서, 외부 서비스와 데이터 경계
- 오류 비용과 승인 필요 행동
- 외부 게시·배포·결제·삭제 등 부작용
- 수동으로 유지할 의사결정 세션
- 원하는 자동화 수준과 운영 시간대
- 월간 비용 또는 호출량 상한
- 사용 가능한 모델·구독·API·로컬 실행환경

C레벨은 자유 형식 파일을 직접 확정하지 않고 구조화된 `OrgSpec` 후보를
출력한다. 기본적으로 세 가지 대안을 제시한다.

| 대안 | 원칙 | 적합한 상황 |
|---|---|---|
| 간소형 | C레벨 1개 + 최소 실행 역할 | 초기 실험, 소규모 프로젝트 |
| 균형형 | 기능 역할 + 필요한 승인 관문 | 일반적인 개인·소규모 팀 |
| 통제형 | 실행·검수·감사 역할 분리 | 오류 비용이 큰 업무 |

각 대안에는 팀 수, 존재 이유, 실행 방식, 예상 일정 호출 수, 공급자,
승인 지점, 수동 설정 항목과 주요 위험을 함께 표시한다.

### 2.3 계획·승인·적용

시스템은 Terraform과 유사한 `plan → review → apply` 경험을 제공한다.

사용자는 다음을 서로 분리해 승인한다.

1. 조직·역할 구조
2. 워크플로와 선후행
3. 예약 주기와 동시 실행 상한
4. 도구·파일·네트워크 권한
5. 무인 실행 범위
6. 외부 부작용 허용 범위
7. 비용 상한

승인 전에는 공급자 설정과 예약 작업을 활성화하지 않는다. 최초 적용은
read-only dry-run과 수동 `Run now` 검증을 거친다. 신규 역할·신규
워크플로·신규 외부 행동은 번인 후 사용자가 별도로 무인 전환을 선언한다.

### 2.4 정상 운영

- 논리적 팀은 명세에 상시 존재하지만 실제 agent 세션은 작업이 있을 때만
  생성한다.
- 사용자의 신규 요청은 대시보드 또는 MCP를 통해 WorkItem으로 등록된다.
- 결정적 라우터가 역할·능력·정책·선후행을 기준으로 배정한다.
- 불명확한 요청만 C레벨 판정 큐로 보낸다.
- 작업자는 정규화된 `TaskPacket`만 받고 실행한다.
- 검수·승인·추가 정보가 필요하면 대시보드의 사용자 행동 목록에 나타난다.
- 운영 지표를 바탕으로 C레벨이 팀 통합·분리·일정 변경안을 제안하되
  자동 적용하지 않는다.

## 3. 비협상 설계 원칙

1. **OrgSpec 단일 정본**
   조직의 의도는 특정 공급자의 프롬프트 파일이나 대화 이력이 아니라
   버전 관리되는 공급자 중립 명세에 둔다.

2. **설계면·제어면·실행면 분리**
   LLM이 조직안을 설계할 수는 있지만 상태 전이, 스케줄 판정, 권한 검사,
   lease, 재시도는 결정적 프로그램이 수행한다.

3. **모델 중립과 실행 호스트 중립을 구분**
   모델 API와 Claude Code·Codex 같은 agent host의 기능 계약은 다르다.
   공통 명세 위에 각각 별도 adapter를 둔다.

4. **DB-first, no-work-no-model**
   기본 `controller` schedule은 예약 시각이 와도 먼저 DB만 조회한다.
   실행 가능한 작업이 없으면 모델을 호출하거나 세션을 만들지 않는다.
   `provider_native` direct mode는 명시적 degraded 예외다.

5. **한 작업의 기본 execution target은 하나**
   제2 target은 명시된 실패 전환 또는 고위험 pairwise 검수에만 사용한다.

6. **중립 작업 패킷으로 인수인계**
   서로 다른 engine·host의 내부 대화 전체를 상호 이전하지 않는다. 목표,
   입력, 결정, 관련 파일, 완료 조건, 현재 산출물과 정책 참조만 전달한다.

7. **사람 승인과 모델 승인 분리**
   정책이 사람 승인을 요구하면 다른 모델의 동의로 대체할 수 없다.

8. **현재 상태의 쓰기 원장은 하나**
   DB가 현재 상태의 단일 쓰기 원장이고 이벤트는 append-only로 보존한다.
   Markdown은 가져오기·내보내기·감사용 파생본으로만 취급한다.

9. **로컬 우선·최소 권한**
   기본 설치는 단일 사용자, loopback bind, SQLite, BYO credentials다.
   외부 호스팅과 멀티테넌시는 별도 제품 단계다.

10. **설치와 조직 변경은 항상 diff를 보여준다**
    전역 설정, 예약 작업, 플러그인, 권한을 조용히 변경하지 않는다.

### 3.1 용어

| 용어 | 이 문서의 의미 |
|---|---|
| Organization | 하나의 목표·정책·예산 아래 운영되는 전체 AI 조직 |
| Role | 책임·능력·권한·실행조건의 논리 정의 |
| Team | 사용자에게 보이는 Role 또는 Role 묶음의 표현 |
| Actor | Role을 실제 수행하는 사람 또는 agent identity |
| Worker | WorkItem을 claim해 Run을 만드는 실행 Actor |
| ModelEngine | 메시지를 받아 추론 결과와 usage를 반환하는 순수 모델 경계 |
| ManagedRunner | 임의의 ModelEngine을 사용해 tool loop와 실행 상태를 소유하는 제품 runner |
| AgentHost | 모델 선택·session·도구를 자체 소유하는 외부 agent runtime |
| ExecutionTarget | Role이 선택하는 ManagedRunner 또는 AgentHost 참조 |
| Schedule | Control Plane의 공급자 중립 desired cadence |
| Native schedule/routine | Claude·Codex 등 외부 host에 투영된 예약 작업 |
| C-level | 초기 조직설계·조직개편·예외판정을 담당하는 Role |

## 4. 논리 아키텍처

```text
사용자 목표·환경
        │
        ▼
C-Level Organization Architect
        │  구조화된 제안
        ▼
Workspace Inspector ── OrgSpec ── Validator/Simulator
                                      │
                                      ▼
                                  Plan/Diff ── 사용자 승인
        │
        ▼
Organization Compiler
        │
        ├── Generic / Local ModelEngine Adapters
        ├── Built-in ManagedRunner
        ├── Optional AgentHost Adapters (Codex / Claude / future)
        ├── Plugin / Skill / Schedule Integration Facets
        └── Manual Setup Guide Exporter
        │
        ▼
Control Plane DB + Scheduler + Policy Engine
        │                         ▲
        ├── Work Queue            │ events / usage / artifacts
        ├── Approval Queue        │
        ├── Run & Lease Manager ──┘
        └── Dashboard / MCP / CLI
```

### 4.1 설계면

- C-Level Organization Architect skill
- 인터뷰 질문과 프로젝트 탐색
- 비밀·대용량 파일을 제외하는 read-only Workspace Inspector
- 세 가지 조직 대안 생성
- 예상 호출량·위험·수동 작업 산출
- `OrgSpec` 구조화 출력
- 운영 자료를 이용한 조직개편 제안

C레벨은 최초 설계, 조직 변경, 모호한 배정, 정책 예외에만 호출한다.
일상적인 분류와 상태 관리는 C레벨을 호출하지 않는다.

### 4.2 제어면

- Control Plane API
- 현재 상태 DB와 append-only 이벤트
- 상태 전이·권한·정책 엔진
- 예약 계산과 due-work dispatcher
- lease, fencing generation, heartbeat, timeout
- retry/backoff, dead-letter queue, cancel, kill switch
- 승인 대기와 재개
- 비용·토큰·지연·재작업 계측
- engine·host 설정의 desired/actual drift 감지

### 4.3 실행면

- generic model API·local process `ModelEngine` adapter
- built-in `ManagedRunner`
- 선택적 Claude Code·Codex `AgentHost` adapter
- 향후 GitHub Agentic Workflows, CrewAI, Microsoft Agent Framework exporter

실행면은 조직을 설계하지 않는다. 승인된 `OrgSpec`과 `TaskPacket`을 해당
engine·host의 형식으로 변환하고 실행 결과를 공통 이벤트로 정규화한다.

### 4.4 표현면

- 초기설정 wizard
- 지금 사용자가 해야 할 일
- 조직도와 역할 설명
- 작업함과 선후행
- 승인함과 검수 실물
- 예약 작업과 다음 실행
- 실행 상태·실패·재시도
- 공급자·모델·비용·토큰
- 감사 이벤트와 조직 변경 이력

## 5. OrgSpec v1alpha1

### 5.1 필수 객체

- `Organization`
- `Role`
- `RoleCapability`
- `ContextPack`
- `Workflow`
- `Stage`
- `Schedule`
- `PolicySet`
- `ModelEngineProfile`
- `AgentHostProfile`
- `ManagedRunnerProfile`
- `ExecutionTarget`
- `RoleExecutionPolicy`
- `ManualSession`
- `Budget`
- `OrchestrationIntent`

`ModelEngineProfile`은 추론 연결, `AgentHostProfile`은 외부 agent runtime,
`ManagedRunnerProfile`은 특정 engine을 주입받는 제품 소유 runner다.
`ExecutionTarget`은 role이 선택할 수 있는 runner 또는 host 연결이고,
`RoleExecutionPolicy`는 role의 `execution.preferred/fallbacks` 규칙이다.
`PolicySet`은 `spec.policies`에 직렬화한다. 역할이 수행할 수 있는 업무 의미
(`planning`, `code_change`)는 `RoleCapability`, 실행 호스트가 제공하는
기능은 `host.*`·`runner.*`, 추론 엔진의 기능은 `model.*` namespace로
구분한다. validator는 role의 두 요구 집합을 발견된 engine/host manifest와
각각 대조한다.
`OrchestrationIntent`는 `single`, `delegated`, `peer_team` 같은 공급자
중립 실행 의도만 표현하며 Codex나 Claude의 내부 team 파일을 정본으로
직렬화하지 않는다.

실행 상태 객체는 별도 DB에 둔다.

- `Principal`
- `Actor`
- `WorkItem`
- `Dependency`
- `Run`
- `Attempt`
- `Lease`
- `Artifact`
- `Approval`
- `Decision`
- `UserAction`
- `UsageRecord`
- `Event`

### 5.2 예시

```yaml
apiVersion: chartermesh.dev/v1alpha1
kind: Organization
metadata:
  id: example-product-team
  name: Example Product Team
  revision: 1

spec:
  mission: >
    사용자 요구를 조사하고 안전하게 제품을 개발·검수·배포한다.

  operatingProfile: balanced

  budgets:
    monthlyCostLimitUsd: 100
    maxConcurrentRuns: 3
    maxDailyModelStarts: 24

  modelEngines:
    - id: primary-llm
      adapter: generic-model-api
      transport: http
      model: configured-by-user
      enabled: true
    - id: simulated-llm
      adapter: fake-model-engine
      transport: embedded
      model: deterministic-fixture
      enabled: true

  agentHosts: []

  managedRunners:
    - id: primary-runner
      adapter: builtin-managed-runner
      modelEngineRef: primary-llm
      executionHost: local
      enabled: true
    - id: simulated-runner
      adapter: fake-managed-runner
      modelEngineRef: simulated-llm
      executionHost: local
      enabled: true

  executionTargets:
    - id: generic-local
      kind: managed_runner
      runnerRef: primary-runner
      enabled: true
    - id: simulated-fallback
      kind: managed_runner
      runnerRef: simulated-runner
      enabled: true

  contextPacks:
    - id: common-policy
      sources:
        - policies/common.md
      maxTokens: 6000

  roles:
    - id: strategy
      name: Strategy
      class: c_level
      executionMode: manual_persistent
      capabilities: [planning, prioritization, exception_routing]
      requiredModelCapabilities: [model.structured_output]
      requiredRuntimeCapabilities: [host.session.resume]
      promptRef: prompts/strategy.md
      contextPacks: [common-policy]
      execution:
        preferred: generic-local
        allowEmulation: true
        fallbacks: [simulated-fallback]
      tools:
        allow: [work_read, work_create, proposal_write]
        approvalRequired: [policy_apply, schedule_activate]

    - id: implementation
      name: Implementation
      class: worker
      executionMode: scheduled_ephemeral
      capabilities: [code_change, testing]
      requiredModelCapabilities: [model.tool_calling]
      requiredRuntimeCapabilities:
        [host.delegate.subagent, host.workspace.isolated]
      promptRef: prompts/implementation.md
      contextPacks: [common-policy]
      execution:
        preferred: generic-local
        fallbacks: [simulated-fallback]
      concurrency: 1
      tools:
        allow: [repo_read, repo_write, test_run]
        approvalRequired: [deploy, destructive_action]

  workflows:
    - id: feature-delivery
      name: Feature Delivery
      trigger:
        type: queue
      stages:
        - id: implement
          role: implementation
          outputContract: schemas/implementation-result.json
        - id: user-review
          type: approval
          dependsOn: [implement]
          evidenceRequired: true
        - id: close
          type: deterministic
          dependsOn: [user-review]

  schedules:
    - id: implementation-dispatch
      workflow: feature-delivery
      cadence:
        rrule: "FREQ=HOURLY;INTERVAL=3"
        timezone: Asia/Seoul
      activation: proposed
      noWorkBehavior: skip_without_model
      overlapPolicy: forbid

  manualSessions:
    - role: strategy
      reason: 정책·우선순위·조직개편은 장기 맥락과 사용자 협의가 필요함

  policies:
    externalSideEffects: user_approval
    destructiveActions: prohibited
    providerFailover: same_or_lower_permissions
    organizationChanges: user_approval
    firstRunMode: read_only
```

### 5.3 검증 규칙

컴파일 전 최소한 다음을 결정적으로 검사한다.

- role, workflow, stage, engine, runner, host, execution target 참조 무결성
- 의존성 순환
- 책임 role이 없는 실행 stage
- 동일 자원에 대한 동시 쓰기 충돌
- 승인 없이 외부 부작용을 수행하는 stage
- 종료 조건 없는 반복·재귀 workflow
- preferred와 모든 fallback의 model/host capability 독립 충족 여부
- 역할·일정·동시 실행·비용 상한
- fallback 전환 시 권한 확대 여부
- no-work 조건이 없는 `controller` schedule
- `provider_native` direct mode인데 degraded 표시·빈 기동 계측·비용
  경고가 없는 schedule
- 산출물 schema 또는 완료 조건이 없는 실행 stage
- 수동 세션이 필요한데 설치 지침이 없는 role
- 병렬 쓰기인데 workspace isolation 또는 파일 소유권 규칙이 없는 stage
- `peer_team`을 요구하지만 host capability가 experimental이며
  사용자가 명시적으로 opt-in하지 않은 role
- child agent 비용·상태를 계측하거나 `unknown`으로 표시할 수 없는 adapter

## 6. 상태·데이터 계약

### 6.1 WorkItem 수명주기

```text
requested
  → triaged
  → ready
  → claimed
  → in_progress
  → review_pending
  → approved | changes_requested | rejected
  → done
```

어느 단계에서든 정책에 따라 `blocked`, `on_hold`, `canceled`, `failed`로
갈 수 있다. 완료 이력은 삭제하지 않으며 재작업은 새 Run 또는 후속
WorkItem으로 표현한다.

### 6.2 Run 수명주기

```text
queued → leased → starting → running
        → waiting_for_approval
        → succeeded | failed | timed_out | canceled | dead_lettered
```

`Run`은 논리 실행 한 건이고 재시도 이력을 덮어쓰지 않는다.

- `run_id`, `work_item_id`, `role_id`, `execution_target_id`
- `current_attempt_id`, `generation`
- `session_ref`, `native_schedule_ref`
- `started_at`, `finished_at`, `exit_reason`
- attempt별 usage의 집계와 artifact·event 참조
- `spec_hash`, `context_hash`, `input_snapshot_hash`

`Attempt`는 한 execution target에서 TaskPacket을 수행하려는 한 번의 agent
실행이다. managed runner의 tool loop는 한 Attempt 안에서 여러 번 모델을
호출할 수 있으므로 각 호출은 별도 `ModelInvocation`으로 기록한다.

- `attempt_id`, `run_id`, `attempt_no`
- `execution_target_id`, `agent_host_profile_id`, `host_run_ref`
- `started_at`, `finished_at`, `exit_reason`, redacted error
- 집계 input/output/cache token, 비용과 `measurement_status`
- `spec_hash`, `context_hash`, `input_snapshot_hash`

`ModelInvocation`은 다음을 가진다.

- `invocation_id`, `attempt_id`, `sequence_no`
- `model_engine_profile_id`, `model_id`, `provider_request_ref`
- `started_at`, `finished_at`, `finish_reason`
- input/output/cache token, 비용과 `measurement_status`
- redacted tool-call metadata와 response artifact reference

`Lease`는 별도 객체로 보존한다.

- `lease_id`, `run_id`, `attempt_id`
- `owner`, `generation`, fencing token
- `acquired_at`, `expires_at`, `heartbeat_at`, `released_at`

사용량을 제공하지 않는 adapter도 있으므로 수치는 nullable로 두고
`measurement_status: measured | estimated | unknown`을 반드시 기록한다.

### 6.3 이벤트 원칙

- 이벤트는 append-only다.
- 현재 화면은 이벤트에서 갱신된 projection을 사용한다.
- 동일 idempotency key의 이벤트는 한 번만 적용한다.
- 단순 조회와 무변경 sync는 이벤트를 만들지 않는다.
- 보존·압축 정책을 명시한다.
- 공급자 원문 이벤트는 별도 raw payload로 보존할 수 있으나 비밀과
  불필요한 대화 전문을 기본 저장하지 않는다.

### 6.4 TaskPacket

공급자 전환과 일회성 실행은 다음 중립 패킷을 이용한다.

```json
{
  "taskId": "work-123",
  "objective": "완료해야 하는 단일 결과",
  "inputs": [],
  "policyRefs": [],
  "contextRefs": [],
  "priorDecisions": [],
  "artifacts": [],
  "acceptanceCriteria": [],
  "allowedTools": [],
  "approvalBoundaries": [],
  "workspace": {},
  "deadline": null,
  "budget": {},
  "handoffReason": null
}
```

대화 전체, 공급자 내부 시스템 프롬프트, 비밀값은 TaskPacket에 넣지 않는다.

### 6.5 InstallPlan과 승인 결박

컴파일러는 파일이나 schedule을 즉시 변경하지 않고 `InstallPlan`을 만든다.
각 operation에는 다음이 필요하다.

- 생성·수정·비활성화할 정확한 대상
- before/after hash
- `spec_hash`, `capability_snapshot_hash`, `plan_hash`
- 요구 capability와 권한
- 위험등급과 사용자 승인 필요 여부
- 되돌리기 가능 여부와 rollback 방법
- adapter가 직접 적용할지 `UserAction`으로 전환할지

적용 API는 사용자가 승인한 `plan_hash`가 현재 계획과 동일할 때만 동작한다.
승인 후 명세·프롬프트·artifact 또는 발견된 engine/host capability가
달라지면 기존 승인을 무효화한다. 생성한 파일과 native schedule은 install
manifest에 소유권을 기록하며, 재적용은 idempotent해야 한다.

위험등급 기본값은 다음과 같다.

| 등급 | 예 | 기본 처리 |
|---|---|---|
| R0 | 읽기 전용 진단 | 정책 범위 내 자동 가능 |
| R1 | 프로젝트 내부 가역 변경 | 최초 설치·조직 변경은 승인 필수. 이후 승인된 managed scope만 정책에 따라 자동 가능 |
| R2 | schedule 활성화·네트워크·외부 서비스 변경 | 사용자 승인 필수 |
| R3 | 게시·배포·삭제·결제·권한 확대 | 별도 실행 승인 필수 |

### 6.6 Artifact와 Approval

Artifact는 다음 immutable identity를 가진다.

- `artifact_id`, `producer_run_id`
- `sha256`, MIME type, byte size
- immutable storage URI 또는 content-addressed path
- 생성 시각과 schema version

Approval은 설명 문구가 아니라 `spec_hash`, `plan_hash`,
`artifact_hash` 중 해당 대상을 결박한다. 상태는 다음을 기본으로 한다.

```text
requested
  ├→ approved
  ├→ conditionally_approved
  ├→ changes_requested
  ├→ rejected
  └→ expired

approved | conditionally_approved | changes_requested
  → superseded  # 대상 hash가 바뀐 경우
```

조건부 승인에는 구조화된 조건, 적용 범위와 만료 시각이 필요하다. 대상
hash가 달라지거나 새 artifact가 제출되면 과거 승인은 `superseded`가 된다.

### 6.7 WorkItem·Run 원자성 및 DB 불변조건

- claim 트랜잭션은 WorkItem을 `claimed`로 바꾸고 Run·Attempt·Lease를
  함께 생성한다.
- 실행 시작·종료 시 WorkItem과 Run projection, 이벤트를 한 트랜잭션으로
  갱신하거나 transactional outbox를 사용한다.
- 실행 자체는 성공했지만 검수가 남은 경우 Run은 `succeeded`,
  WorkItem은 `review_pending`이다.
- `changes_requested` 결정은 WorkItem을 `changes_requested`로 바꾸고
  기존 artifact 승인을 무효화한다. 담당자가 재작업을 수락하면 `ready`로
  돌리고 새 Run을 만든다.
- `schedule_id + due_at`은 unique다.
- `work_item_id + generation`마다 active Run은 하나뿐이다.
- terminal Run과 terminal WorkItem은 직접 수정하지 않고 후속 WorkItem을
  만든다.
- Event에는 단조 증가 sequence, payload schema version,
  correlation/causation id가 필요하다.
- projection 변경과 Event 기록은 원자적이어야 한다.
- 지난 generation의 worker는 artifact·완료 이벤트를 commit할 수 없다.

### 6.8 Principal·Actor 인증

`Principal`은 인증된 실제 주체이고 `Actor`는 Organization revision의
Role을 수행하도록 결박된 identity다.

- 로컬 사용자는 UI bearer session으로 `human` Principal에 인증한다.
- worker는 Control Plane이 발급한 짧은 수명의 run-scoped credential을
  사용한다.
- credential에는 `organization_revision`, `run_id`, `actor_id`,
  `role_id`, `generation`, 허용 도구·범위와 만료 시각을 결박한다.
- MCP와 API는 요청 본문의 `actor_id` 문자열을 신뢰하지 않고 credential의
  identity와 대조한다.
- 다른 Role, 지난 generation 또는 다른 Run의 credential로 mutation을
  시도하면 거부한다.
- adapter나 plugin에는 장기 관리자 토큰을 제공하지 않는다.

## 7. 엔진·호스트 어댑터 계약

### 7.1 공통 인터페이스

```text
ModelEngine
  detectCapabilities()
  validateConfiguration()
  generate(inferenceRequest, signal)
  stream(inferenceRequest, signal)       # optional
  cancel(invocationRef)                  # optional
  collectUsage(invocationRef)

ManagedRunner
  detectCapabilities()
  bindEngine(modelEngine)
  startRun(taskPacket)
  resumeRun(runRef, taskPacketDelta)
  streamEvents(runRef)
  pauseForApproval(runRef, request)
  resolveApproval(runRef, decision)
  cancelRun(runRef)

AgentHost
  detectCapabilities()
  validateConfiguration()
  startRun(taskPacket)                   # model is host-managed
  resumeRun(sessionRef, taskPacketDelta)
  streamEvents(runRef)
  cancelRun(runRef)
  collectUsage(runRef)

RuntimeInstaller
  planInstallation(orgSpec, capabilitySnapshot)
  applyInstallation(approvedPlan)
  planRollback(installManifest, targetRevision)
  applyRollback(approvedRollbackPlan)
  planUninstall(installManifest)
  applyUninstall(approvedUninstallPlan)
  inspectDrift()
  registerNativeSchedule(schedule)       # optional host facet
  pauseNativeSchedule(scheduleRef)       # optional host facet
  removeNativeSchedule(scheduleRef)      # optional host facet
```

각 adapter는 자기 책임 범위의 capability matrix만 반환한다. 모델의 tool
calling은 host의 worktree 격리를 대신하지 않고, host의 native subagent는
모델의 structured output을 대신하지 않는다. 지원하지 않는 기능을 성공으로
가장하지 않고 `unsupported`, `manual_step_required`, `degraded` 중 하나로
명시한다.

rollback과 uninstall은 install manifest가 소유한 파일·schedule만 대상으로
한다. 기존 사용자 파일은 before hash가 일치할 때만 복원하며, 사용자가
설치 후 수정한 파일은 덮어쓰지 않고 충돌로 보고한다.

### 7.2 지원 단계

| 단계 | 실행환경 | 제공 범위 |
|---|---|---|
| Managed runner | 모든 호환 `ModelEngine` | 제품 소유 tool loop·workspace·scheduler·승인 |
| Full native host | Claude Code, Codex 등 | 역할 패키지, 세션, 승인, 이벤트, 예약 연동 |
| Command engine/host | 모델 또는 에이전트 CLI | 명령 실행·구조화 출력·사용량 수집 |
| Guided manual | 일반 채팅 LLM | 프롬프트·세션 설정·수동 작업 가이드 |

“모든 LLM 지원”은 모든 모델이 동일 기능을 가진다는 뜻이 아니다. 공통
조직 명세를 사용하되 실행환경의 capability에 따라 기능을 점진 활성화한다.

### 7.3 Codex adapter

초기 지원 범위:

- `.codex-plugin/plugin.json`
- 공통 `skills/`, `hooks/`, `.mcp.json`
- 프로젝트 `AGENTS.md` 또는 생성된 role guidance
- Codex SDK, app-server 또는 `codex exec`
- thread·turn·approval·history·streamed event 정규화
- native subagent와 project custom agent capability 탐지
- goal은 세션 연속성 hint로만 사용하고 WorkItem/Run은 Control Plane에 유지
- Codex Scheduled Tasks export
- local/worktree 선택과 저장소 쓰기 충돌 방지

네이티브 예약 작업은 Codex 기능을 사용할 수 있을 때만 export한다. 제품의
desired schedule 정본은 Control Plane에 두고 외부 task id, 적용 revision,
상태와 drift를 기록한다.
공식 programmatic schedule 관리 계약이 없는 surface는 자동 설치를
가장하지 않고 검증 가능한 `UserAction`으로 변환한다.

### 7.4 Claude Code adapter

초기 지원 범위:

- `.claude-plugin/plugin.json`
- 공통 `skills/`, `agents/`, `hooks/`, `.mcp.json`
- Claude Agent SDK 또는 `claude -p`
- session resume/fork
- subagent와 experimental agent team capability 탐지
- permission callback과 lifecycle hook 정규화
- Desktop Scheduled Tasks 또는 Remote Routines export

세션 내부 `/loop`는 장기 정본 스케줄로 사용하지 않는다. 제품의 스케줄
정본과 native schedule의 적용 상태를 분리한다.
agent team의 shared task list도 제품 WorkItem 원장으로 사용하지 않으며,
team member의 병렬 쓰기는 별도 worktree 또는 명시적 파일 소유권이 없으면
거부한다.

### 7.5 Generic ModelEngine과 ManagedRunner

- OpenAI-compatible, 공급자별 model API 또는 로컬 model process
- text generation을 최소 공통 계약으로 두고 structured output·tool
  calling·multimodal은 capability로 협상
- `ManagedRunner`가 MCP/tool gateway, workspace, 승인, retry, checkpoint를
  제공
- 지정 command 실행과 JSON Schema 출력
- 사용자가 제공하는 custom adapter SDK

API 모델은 자체 세션·파일시스템이 없어도 된다. 그 경우 Control Plane과
`ManagedRunner`가 tool loop, workspace, 승인, 재시도와 상태를 소유한다.
새 LLM 추가는 원칙적으로 `ModelEngine` adapter와 manifest만 요구하며 core
OrgSpec 변경을 요구하지 않는다.

## 8. 스케줄러와 디스패처

schedule 실행 방식은 두 가지로 구분한다.

| executor | 동작 | no-work-no-model 보장 |
|---|---|---|
| `controller` | 로컬 daemon이 DB를 먼저 보고 필요한 agent만 기동 | 보장 |
| `provider_native` | 선택한 `AgentHost`가 정해진 시각에 agent 세션을 직접 시작 | 보장 불가 |

기본값은 `controller`다. 공급자 네이티브 일정은 사용자가 해당 호스트의
관리 UI·격리 기능을 선호할 때 선택하는 degraded mode다. 이 경우 큐 확인
전 이미 모델 세션이 시작될 수 있으므로 `empty_model_start`를 별도로
측정하고 예상 비용을 plan에 표시한다. 네이티브 일정이 모델을 거치지 않는
결정적 launcher를 공식 지원하는 경우에만 strict 보장을 회복할 수 있다.

### 8.1 기본 동작

아래 절차는 기본 `controller` executor의 계약이다.

1. due schedule을 DB에서 조회한다.
2. workflow의 실행 가능 WorkItem과 선행조건을 확인한다.
3. 실행 대상이 없으면 `skipped_no_work` 계수만 올리고 종료한다.
4. 활성 execution target, generation, 동시 실행 상한을 확인한다.
5. 원자적으로 lease를 획득한다.
6. TaskPacket을 만들고 adapter를 호출한다.
7. heartbeat와 timeout을 감시한다.
8. 성공·승인대기·실패·재시도를 이벤트로 기록한다.
9. lease 만료 시 fencing token이 지난 worker의 쓰기를 거부한다.

### 8.2 필수 안전장치

- overlap 기본 금지
- idempotency key
- lease와 heartbeat
- 최대 attempt
- 지수 backoff
- retryable/non-retryable 오류 구분
- dead-letter queue
- per-role concurrency
- global kill switch
- execution target별 pause
- 일정별 Run now와 dry-run
- PC 절전·앱 종료·재기동 뒤 복구
- native schedule drift 감지

### 8.3 엔진·호스트 절체

ModelEngine 또는 AgentHost 절체는 단순 토글이 아니다.

1. 신규 claim 동결
2. 기존 lease drain 또는 안전 취소
3. 권한·capability 호환성 검사
4. generation 증가
5. TaskPacket과 artifact로 카나리 1건
6. 중복 실행·상태 정합 확인
7. 활성 공급자 변경
8. 이전 공급자의 native schedule 정지 확인

fallback이 더 넓은 권한을 요구하면 자동 절체하지 않고 사용자 승인을
요청한다.

## 9. MCP·CLI 계약

대시보드, C레벨, worker가 같은 제어면을 사용하도록 MCP와 CLI는 동일한
서비스 계층을 호출한다.

### 9.1 조직 도구

- `environment.inspect`
- `organization.propose`
- `organization.validate`
- `organization.plan`
- `organization.apply`
- `organization.diff`
- `organization.rollback`
- `organization.audit`
- `user_action.list`
- `user_action.complete`

`organization.apply`, schedule 활성화와 권한 확대는 사용자 승인 토큰 또는
대시보드 승인 상태를 요구한다.

### 9.2 작업 도구

- `work.create`
- `work.list`
- `work.show`
- `work.claim`
- `work.progress`
- `work.block`
- `work.complete`
- `work.create_followup`
- `artifact.submit`
- `artifact.list`
- `artifact.show`
- `approval.request`
- `approval.list`
- `approval.show`
- `approval.resolve`
- `run.list`
- `run.show`
- `run.heartbeat`
- `run.cancel`
- `run.usage`
- `schedule.list`
- `schedule.plan`
- `schedule.enable`
- `schedule.disable`
- `schedule.run_now`
- `provider.list`
- `provider.capabilities`
- `provider.status`

각 호출에는 actor, role, work item, idempotency key, expected version을
포함한다. 팀명을 문자열로 주장하는 것만으로 권한을 부여하지 않는다.

모든 mutation은 공통 envelope에서 다음을 강제한다.

- 인증된 `actor_id`
- `idempotency_key`
- `expected_version`
- 해당 시 `spec_hash`, `plan_hash`, `artifact_hash`
- R2/R3 또는 정책상 필요할 때 `approval_id`
- `correlation_id`

서버는 approval이 결박한 hash와 실제 실행 후보가 다르면 MCP 단계에서
거부한다. 조회 응답에도 trace/correlation id와 적용된 spec revision을
포함한다.

## 10. 대시보드 정보구조

### 10.1 홈: 지금 할 일

가장 먼저 다음을 보여준다.

- 사용자가 승인·검수·설정해야 할 항목
- 막힌 작업과 필요한 입력
- 실패하거나 재시도가 필요한 Run
- 다음 예약 실행과 예상 비용
- 조직 변경 제안

완료 보고와 원시 이벤트는 기본 홈에서 분리한다.

### 10.2 조직

- 역할·능력·책임·실행 방식
- manual persistent / scheduled ephemeral 구분
- 공급자와 fallback
- 선후행·handoff 지도
- 현재 OrgSpec revision과 변경 diff

### 10.3 작업

- 요청·담당·상태·선행·후속
- 관련 Run과 artifact
- 완료 기준
- 사용자 운영 overlay가 아닌 단일 현재 상태

### 10.4 승인

- 요청한 행동
- 필요한 이유
- 정확한 후보와 artifact
- 변경점
- 실행 대상·시점·권한·비용
- 승인·조건부 승인·수정 요청·반려

산출물 품질 승인과 외부 게시·배포 실행 승인을 분리한다.

### 10.5 스케줄·실행

- desired schedule과 provider-native actual schedule
- active/paused/proposed/drifted
- 마지막·다음 실행
- no-work skip
- 성공·실패·승인대기
- Run now, dry-run, pause, kill

### 10.6 비용·효율

- 작업별 모델 호출
- input/output/cache token
- 비용과 예산
- 빈 기동
- handoff 수
- 재작업·반려
- 완료까지 걸린 시간
- 역할·공급자별 성공률

## 11. 토큰·비용 최적화

- C레벨은 최초 설계·조직개편·예외 판정에만 사용한다.
- 팀별 전체 조직 문서를 매번 넣지 않는다.
- 역할별 context pack에 상한과 version을 둔다.
- TaskPacket에는 관련 결정과 변경분만 포함한다.
- 정적 정책은 공급자 캐시가 유효한 범위에서 prefix를 안정화한다.
- 기본 `controller` schedule은 빈 queue에서 모델을 호출하지 않는다.
- `provider_native` direct mode는 빈 모델 기동을 계측하고 plan에서 비용
  경고를 표시한다.
- 한 작업의 기본 공급자는 하나다.
- 제2 모델 검수는 위험도·불확실성·정책 조건으로 제한한다.
- 저위험 결정적 분류·상태 전이는 모델을 호출하지 않는다.
- 조직안 적용 전에 월간 예상 start 수와 예산을 계산한다.

최소 계측 필드는 다음과 같다.

```text
task_id, run_id, role_id, provider, model,
input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
cost, empty_poll, handoff_count, retry_count,
approval_wait, revision_count, rework_reason, elapsed_ms
```

## 12. 보안·승인 모델

### 12.1 기본 보안

- `127.0.0.1` bind
- 단일 사용자 로컬 모드
- 무작위 로컬 bearer token과 세션 만료
- Host·Origin 검사와 상태 변경 요청의 CSRF 방어
- deny-by-default 도구 정책
- workspace 범위 명시
- path traversal·symlink 탈출 차단과 canonical path 검사
- shell 문자열 조립 금지, executable과 argv 배열 분리
- SSRF 방지와 role별 network allowlist
- adapter를 격리 child process 또는 명확한 RPC 경계에서 실행
- 자격증명 값은 문서·프롬프트·로그·DB에 저장하지 않음
- 로그·오류·provider event의 secret redaction
- 공급자 로그인과 키는 각 공식 저장소 또는 OS 보안 저장소에 위임
- 플러그인 hook과 실행 파일은 설치 시 diff와 출처를 표시
- 외부 네트워크와 파일 범위는 role별 allowlist
- raw 대화 전문의 기본 수집 금지
- 감사 이벤트의 actor와 revision 기록

### 12.2 항상 사용자 승인이 필요한 항목

- 조직 목표·정책 확정
- 신규 팀과 신규 schedule의 최초 활성화
- 홈 디렉터리·전역 설정·OS 시작 서비스 변경
- sandbox·네트워크·파일 권한 확대
- 외부 게시·메일·배포·결제·삭제
- 비용 상한 증가
- 공급자 변경으로 권한이 증가하는 경우
- 비밀 접근과 신규 connector 연결

### 12.3 위협 모델

최소한 다음을 다룬다.

- 프롬프트 인젝션에 의한 조직·권한 변경
- 악성 plugin·MCP·hook
- schedule 폭주와 비용 폭주
- lease 만료 뒤 늦은 worker의 중복 쓰기
- 공급자 절체 중 중복 실행
- 검수 후보 변경 뒤 과거 승인 재사용
- 로컬 DB·artifact 유출
- 명령 인자와 로그를 통한 비밀 노출
- path traversal·symlink·command injection·SSRF
- adapter process 또는 plugin의 confused-deputy 공격
- native schedule과 desired state의 drift

## 13. 권장 저장소 구조

```text
chartermesh/
├─ apps/
│  ├─ dashboard/
│  ├─ daemon/
│  └─ cli/
├─ packages/
│  ├─ orgspec/
│  ├─ compiler/
│  ├─ policy-engine/
│  ├─ runtime/
│  ├─ adapter-sdk/
│  ├─ mcp-server/
│  └─ client-sdk/
├─ adapters/
│  ├─ model-engines/
│  │  ├─ generic-api/
│  │  └─ command/
│  └─ agent-hosts/
│     ├─ codex/
│     └─ claude-code/
├─ plugins/
│  ├─ codex/
│  └─ claude-code/
├─ .codex/
│  └─ agents/              # 선택적 project-scoped custom agents
├─ packs/
│  ├─ software-development/
│  └─ research/
├─ schemas/
├─ docs/
│  ├─ architecture/
│  ├─ security/
│  └─ adr/
├─ examples/
├─ tests/
├─ LICENSE
├─ SECURITY.md
├─ CONTRIBUTING.md
└─ README.md
```

ModelEngine과 AgentHost manifest는 분리한다. Codex와 Claude용 host
manifest도 분리하되 공통 skill, schema와 MCP 코어를 공유할 수 있게 한다.
여러 host에서 동시에 작동한다는 가정은 호환성 테스트를 통과한 파일에만
적용한다.

프로젝트별 로컬 상태는 기본적으로 다음처럼 격리한다.

```text
.chartermesh/
├─ organization.yaml       # 버전 관리 권장
├─ prompts/
├─ policies/
├─ generated/
├─ install-manifest.json
├─ state.db                # 기본 gitignore
└─ artifacts/              # 기본 gitignore
```

## 14. 권장 기술 기준

신규 개발 세션은 첫 구현 전에 ADR로 최종 선택을 기록한다. 기본 권고는
**TypeScript 중심 모노레포**다. 대시보드, daemon, CLI, MCP, OrgSpec 타입,
ModelEngine·AgentHost adapter가 한 타입 계약을 공유할 수 있기 때문이다.

- 런타임: 현재 지원되는 Node.js LTS
- 패키지: TypeScript workspace/monorepo
- 로컬 DB: SQLite WAL
- 향후 다중 사용자 DB: PostgreSQL용 repository 경계
- 프런트: React, TypeScript, Vite
- API: versioned REST + event stream
- MCP: 공식 SDK 기반 thin server
- CLI: 동일 서비스 계층을 호출하는 cross-platform CLI
- 스케줄: DB의 due time과 lease를 사용하는 자체 경량 dispatcher
- 테스트: 단위·속성·adapter contract·Playwright E2E
- 배포: 로컬 native 실행과 Docker Compose

Python backend를 선택할 수는 있지만 별도 언어를 추가하는 이점, SDK
호환성, 패키징과 타입 중복 비용을 ADR에서 입증해야 한다.

현재 Team Console의 큰 단일 `server.py`, `App.jsx`, CSS를 그대로 복사하지
않는다. 동작 계약과 검증된 UX는 참고할 수 있으나 새 프로젝트는 모듈 경계와
마이그레이션을 처음부터 둔다.

## 15. 오픈소스 패키징

라이선스는 Apache-2.0으로 결정했다. 최상단 `LICENSE`가 배포 정본이다.
공개 프로젝트명, 보안 연락처와 릴리스 정책은 공개 전 별도로 확정한다.

공개 전 최소 산출물:

- LICENSE
- SECURITY.md와 취약점 제보 경로
- 개인정보·telemetry 기본값
- threat model
- SBOM·dependency license scan
- 기여·릴리스·호환성 정책
- 합성 example data
- Codex·Claude·OS별 compatibility matrix
- 재현 가능한 설치·제거·업그레이드
- migration과 rollback

비공개 레거시 시스템은 공개 저장소의 기본 예제로 넣지 않는다. 필요한
경우 실제 고유명사·데이터·정책을 제거한 합성 `research` pack을 별도로
만든다.

## 16. 구현 단계

### Phase 0 — 독립 기반

- 신규 경로·신규 Git 저장소
- 라이선스·보안·기여 문서
- 비공개 제품 문자열·데이터 유입 방지 검사
- 기술 ADR
- CI, lint, test, secret scan
- Apache-2.0 적용, 공개 프로젝트명은 사용자 승인 후 확정

### Phase 1 — OrgSpec과 컴파일러

- v1alpha1 JSON Schema
- parser·validator
- 세 조직 대안의 구조화 출력 계약
- plan/diff/apply/rollback
- 합성 example pack

### Phase 2 — Control Plane

- DB migration
- WorkItem·Run·Artifact·Approval·Event
- 상태 전이·idempotency·lease·heartbeat
- scheduler·retry·dead-letter·kill switch
- MCP와 CLI

### Phase 3 — C레벨 Bootstrap

- 초기 인터뷰
- 환경 capability 탐지
- 조직 제안·비용·위험 설명
- 수동 설정 항목 생성
- 설치할 수 없는 항목을 검증 가능한 `UserAction`으로 생성
- read-only dry-run

### Phase 4 — 엔진·호스트 연동

- fake ModelEngine과 fake ManagedRunner
- built-in ManagedRunner
- generic model API·command ModelEngine adapter
- 선택적 Codex·Claude Code AgentHost adapter와 plugin
- native subagent·agent team·goal·thread host capability matrix
- 병렬 쓰기 worktree/ownership isolation
- native schedule export와 drift
- 중립 TaskPacket handoff

### Phase 5 — 대시보드

- 지금 할 일
- 조직·작업·승인·스케줄·실행·비용
- plan diff와 적용 승인
- 검수 artifact
- 접근성·반응형 검증

### Phase 6 — 번인과 공개

- 소프트웨어 개발 pack
- 리서치 pack
- 단일 사용자 실사용
- 두 외부 사용자의 독립 설치
- crash/resume·절체·승인 회귀
- 문서·데모·릴리스

거친 범위는 단일사용자 OSS 알파 6~10 개발자-주, 여러 외부 AgentHost에서
안정적인 cross-platform 베타는 누적 3~5개월이다. 이는 고정 일정이 아니라
범위 통제용 추정이다.

## 17. MVP 완료 기준

다음을 모두 통과해야 첫 OSS 알파로 본다.

1. 빈 Windows·macOS·Linux 테스트 환경 중 지원한다고 선언한 환경에서
   문서대로 설치된다.
2. 비공개 고유명사·내부 경로·운영 데이터가 core와 배포물에 0건이다.
3. C레벨이 합성 프로젝트를 인터뷰하고 세 조직안을 생성한다.
4. 생성된 OrgSpec이 schema와 안전 검사를 통과한다.
5. 사용자가 승인하기 전 파일 적용·schedule 활성화·권한 확대가 0건이다.
6. plan 화면에서 생성·수정·삭제·수동 작업을 구분해 볼 수 있다.
7. generic ModelEngine과 built-in ManagedRunner에서 end-to-end 실행이
   된다. Codex나 Claude Code 설치·계정은 필요하지 않다.
8. 두 번째 ModelEngine 또는 AgentHost는 adapter compatibility test를
   통과한다. 모든 기본 테스트는 simulated engine/runner로 네트워크·유료
   API 없이 실행된다.
9. 작업 요청이 대시보드에 등록되고 worker가 claim해 artifact를 제출한다.
10. 승인 필요 stage에서 실행이 중단되고 승인 후 동일 Run이 안전하게
    재개된다.
11. 외부 부작용은 결과 승인과 별도의 실행 승인을 요구한다.
12. 기본 `controller` schedule은 빈 queue에서 모델 호출 0회다.
    `provider_native` direct mode는 `empty_model_start`를 명시 계측한다.
13. 동일 작업의 중복 claim·중복 완료가 회귀 테스트에서 0건이다.
14. worker crash 뒤 lease 만료·재시도·dead-letter가 재현된다.
15. 알파에서는 실제 주 execution target과 simulated fallback의 절체
    카나리에서 중복 실행과 권한 확대가 없다. 외부 host 베타는 각 지원
    대상으로 같은 시험을 통과한다.
16. 작업별 token·cost·retry·handoff·elapsed와
    `measurement_status`가 기록된다. 미지원 수치는 조용히 0으로 만들지
    않고 `unknown`으로 표시한다.
17. global pause와 adapter pause가 즉시 신규 claim을 막는다.
18. 삭제·업그레이드·DB migration·rollback 절차가 문서화된다.
    uninstall과 rollback은 기존 사용자 파일을 보존한다.
19. 합성 example pack만으로 신규 사용자가 실제 workflow 하나를 완주한다.
20. daemon·프런트·adapter contract·E2E·security test가 CI에서 통과한다.

## 18. 첫 버전의 명시적 비목표

- 멀티테넌트 SaaS
- 모바일 네이티브 앱
- 범용 ERP·CRM·Jira 대체
- 팀 채팅과 Slack 대체
- 범용 시각 flow builder
- 자체 기초모델 호스팅
- 프롬프트 마켓플레이스
- 무제한 자율 조직 생성
- 사용자 승인 없는 외부 게시·배포
- 모든 LLM에서 동일 기능 보장
- Claude와 Codex 내부 대화의 직접 상호 재개

범용 runner와 시각 flow builder를 전부 새로 만들면 CrewAI, Flowise,
Dify, Microsoft Agent Framework와 불필요하게 경쟁한다. 이 제품은 그 위의
조직 설계·컴파일·거버넌스 계층에 집중한다.

## 19. 기존 비공개 자산의 활용 경계

재사용 가능한 것은 일반화된 동작 지식이다.

- 사용자 행동 우선 UI
- 증거자료 기반 승인
- 단일 현재 책임자
- 선후행 차단
- 승인 후보와 실행 후보의 일치
- 후속 작업과 idempotency
- 감사 이벤트와 인수인계
- 실제 번인에서 발견한 실패 유형

재사용하면 안 되는 것은 다음이다.

- 실제 Team Console DB·로그·review asset
- 비공개 팀명·프로젝트 경로·메시지 번호
- 비공개 운영 프롬프트와 사업 규칙
- 사용자 계정·자격증명·실제 비용 기록
- 기존 비공개 운영 콘솔 폴더의 통째 복사

필요한 코드를 옮기려면 먼저 출처·라이선스·비밀·데이터 검사를 하고, 작은
일반 모듈 단위로 명시적 이관한다.

## 20. 주요 경쟁·참고 대상

- Codex plugin packaging:
  https://developers.openai.com/plugins/build/plugins
- Codex scheduled tasks:
  https://learn.chatgpt.com/docs/automations
- Codex app-server:
  https://learn.chatgpt.com/docs/app-server
- Claude Code plugins:
  https://code.claude.com/docs/en/plugins
- Claude Code Desktop scheduled tasks:
  https://code.claude.com/docs/en/desktop-scheduled-tasks
- Claude Agent SDK:
  https://code.claude.com/docs/en/agent-sdk
- GitHub Agentic Workflows:
  https://github.github.com/gh-aw/
- MetaGPT:
  https://github.com/FoundationAgents/MetaGPT
- CrewAI:
  https://docs.crewai.com/
- Flowise AgentFlow:
  https://docs.flowiseai.com/using-flowise/agentflowv2
- Microsoft Agent Framework:
  https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/
- Dify:
  https://github.com/langgenius/dify

## 21. 최종 제품 판정

이 프로젝트의 핵심 자산은 대시보드가 아니라 다음 폐루프다.

```text
업무 목표 진단
→ AI 조직 제안
→ 사용자 승인
→ 공급자별 설치
→ 작업·승인·비용 운영
→ 실측 기반 조직개편 제안
```

비공개 레거시 시스템은 이 폐루프의 첫 dogfooding 사례였다. CharterMesh는
그 시스템의 복제품이 아니라 누구나 자기 업무에 맞는 AI 조직을 생성할 수
있는 범용 Organization-as-Code 제품으로 설계한다.
# 0.0.2 authoritative implementation amendment — 2026-07-29

This amendment supersedes earlier implementation-status statements without
changing the core architecture:

- Bootstrap begins with a deterministic, metadata-only target assessment and a
  hash-bound `lean`, `balanced`, or `controlled` organization proposal.
- Agent-facing CLI commands use the versioned
  `chartermesh.dev/cli/v1alpha1` envelope.
- OrgSpec JSON is checked against the machine-readable schema before semantic
  capability and reference validation.
- The built-in ManagedRunner requires a versioned structured artifact, permits
  one bounded repair turn, and propagates cancellation to the engine.
- The Control Plane transactionally records outbox entries, heartbeats active
  leases, recovers expired leases to visible failure, retries with a new
  generation, and enforces installed run/start/cost budgets.
- The dashboard executes the reviewed-work lifecycle through Control Plane
  commands and requires a process-session token for every API response.
- Synthetic model evaluation is the compatibility harness for local and small
  engines; it never makes the model the ledger or human approval authority.

The general tool-execution loop, process-death recovery during filesystem
apply, scheduler/dead-letter/kill-switch behavior, and package publication are
not complete and must not be represented as complete.

# 0.0.3 authoritative implementation amendment — 2026-07-29

This amendment supersedes the 0.0.2 implementation-status paragraph above:

- The built-in ManagedRunner now owns a provider-neutral Tool Runtime. OrgSpec
  roles declare exact allowed tools, approval-required tools, relative
  workspace roots, and a hard iteration bound.
- Tool call approval binds the WorkItem, tool name, and canonical arguments
  hash. Only a human Control Plane actor can approve it. Workspace writes
  always require approval.
- Tool execution evidence is Control Plane state linked to Run and Attempt. It
  records hashes, status, bounded paths, and timing without storing raw
  arguments or results.
- Bootstrap and engine configuration use an immutable pre-mutation journal,
  durable commit marker, atomic per-target lock, and hash-directed automatic
  rollback or finalization after process termination.
- Multi-process stress suites cover claim fencing, idempotent replay, WAL
  initialization, and writer-lock waits.
- A dependency-free JavaScript build makes the repository installable as an
  npm/Git package and is verified in a clean temporary consumer. Actual npm
  registry or GitHub release publication still requires separate approval.
- Local installation/CLI version matching is automatic and offline.
  `version --check` is the explicit network latest-release check.

Scheduler/dead-letter/kill-switch behavior, command/network/deployment tools,
registry publication, and a broad clean-OS compatibility matrix remain
incomplete and must not be represented as complete.

# 0.0.4 authoritative implementation amendment — 2026-07-29

This amendment supersedes the 0.0.3 implementation-status paragraph above:

- Cost is an operator-owned policy. OrgSpec declares `warn`, `block`, or
  `estimate`; runtime configuration may contain operator-supplied per-million
  token prices. Unknown values remain null and are never treated as zero.
- OrgSpec also bounds one artifact and cumulative WorkItem artifact bytes.
- Dashboard APIs have per-process general, mutation, and model-run rate limits
  in addition to loopback, Host, Origin, session, media-type, and body limits.
- Audit events export as redacted JSONL without raw prompt/content/argument or
  secret-like fields.
- The Control Plane creates hashed, integrity-checked SQLite snapshots before
  known-schema migration and on demand. Restore requires an exact current-state
  plan hash and creates a pre-restore safety backup.
- `command-process` is a provider-neutral ModelEngine adapter for any absolute
  local executable implementing the versioned stdin/stdout JSON contract. It
  uses no shell, inherits only a minimal/allowed environment, and bounds time
  and output.
- The dashboard now has explicit keyboard focus/escape return, filter pressed
  state, skip navigation, semantic table headers, and mobile inspector hidden
  state validated in the in-app Browser.

The backup covers CharterMesh SQLite state, not the user's project or hosted
disaster recovery. The command process is trusted local code, not a sandbox.
Scheduler/dead-letter/global kill-switch behavior, external AgentHost adapters,
registry publication, signed releases/SBOM, and a broad clean-OS matrix remain
incomplete.

# 0.0.5 authoritative implementation amendment — 2026-07-29

This amendment supersedes the 0.0.4 implementation-status paragraph above:

- A command-process engine is bound to the executable SHA-256 included in the
  approved runtime plan. The digest is reverified before and after every spawn.
  Its cwd is a dedicated ignored `.chartermesh/engine-work/ENGINE_ID`
  directory, not the target project.
- Control Plane backups are consistent DB+artifact sets. Referenced artifacts
  are length/hash checked, deduplicated by content address, and bound into the
  manifest through an artifact-set hash. Legacy DB-only manifests remain
  readable.
- Approved restore acquires a persistent maintenance lock, blocks new and
  already-open Control Plane writers, makes a full pre-restore safety backup,
  and replaces the DB and required artifacts through one journaled file
  transaction.
- A human-only pause flag, off by default, can block new claims without
  canceling active work or changing WorkItem state.
- OpenAI-compatible requests do not follow redirects and read responses
  through an 8 MiB default, configurable 1 KiB–64 MiB bound.
- Audit export is now a positive, flat evidence-field allowlist. Unknown and
  nested fields are omitted, and invalid actor labels are normalized.

These controls use no paid API, cloud resource, or new runtime dependency.
Executable pinning is not an OS sandbox. Backups still exclude the user's
project/Git files and hosted disaster recovery. Dead-letter policy, active-run
termination, OS sandboxing, signed releases/SBOM, registry publication, and a
broad clean-OS matrix remain incomplete.

# 0.0.6 authoritative implementation amendment — 2026-07-30

This amendment supersedes the 0.0.5 implementation-status paragraph above:

- `runtime.json` is validated against its complete checked-in JSON Schema
  before adapter construction. Semantic checks additionally reject duplicate
  engine/runner ids and dangling runner engine references.
- A model invocation is persisted as `running` before inference starts.
  Success, failure, cancellation, and expired-lease recovery close it
  explicitly; unknown usage and cost remain unknown.
- Ctrl+C/SIGTERM, dashboard cancellation, and a second CLI use the same
  durable Control Plane cancellation command and engine `AbortSignal`.
- WorkItem reads support stable cursor pages. Human archive hides terminal
  items without deleting their Runs, artifacts, or audit evidence. Audit JSONL
  export pages and appends rather than loading the complete ledger in memory.
- Outbox consumers claim bounded batches, acknowledge success, retry with
  backoff, dead-letter exhausted delivery, and permit explicit human replay.
  No network dispatcher is enabled by default.
- The first local controller scheduler supports bounded interval RRULEs,
  durable idempotent ticks, and overlap prevention. Default proposals contain
  no schedules. Each due tick checks for claimable work before model inference,
  and an empty queue records `skipped_no_work` with zero model starts.

These controls add no paid provider call, cloud resource, runtime dependency,
or automatic background service. Broader recurrence/missed-tick semantics,
service installation, provider-native schedule reconciliation, external
AgentHost adapters, OS sandboxing, signed releases/SBOM, and registry
publication remain separate work.

# 0.0.7 authoritative implementation amendment — 2026-07-30

This amendment supersedes the 0.0.6 implementation-status paragraph above:

- Exact bootstrap plans now install four provider-neutral Apache-2.0 Agent
  Skills under `.chartermesh/skills/` and one common agent entrypoint. They
  follow the portable `SKILL.md` format and grant no execution permission.
- A versioned, agent-readable catalog distinguishes built-ins, opt-in
  integrations, host-native preferences, and items that are unsafe as global
  defaults. It records canonical source, license, prerequisites, network and
  credential needs, and risk notes.
- External MCP packages are not downloaded, executed, or connected by
  default. The Filesystem and Git reference servers overlap existing host or
  Tool Runtime capabilities; Fetch and browser automation require their own
  egress/session threat models.
- The optional provider-neutral `web.search` executor uses an
  operator-supplied SearXNG JSON endpoint. It requires HTTPS or loopback HTTP,
  rejects credentials and redirects, bounds time/results/response bytes, does
  not fetch result pages, and starts disabled.
- A role must allow `web.search`, the selected engine must support tool calls,
  and the exact query call must receive human Control Plane approval before
  network egress.
- ManagedRunner instructions now define artifact checks as actions actually
  performed with current-invocation evidence. Proposed verification belongs
  in next actions. This rule is provider-neutral and specifically improves
  constrained local-model reliability.

These additions require no paid API, provider account, runtime npm dependency,
or background daemon. CharterMesh does not bundle SearXNG itself and does not
yet act as a generic MCP client. External package installation, browser
profiles, credentials, and public search-instance policy remain user-owned,
explicitly approved integrations.
