const sessionToken = document
  .querySelector('meta[name="chartermesh-session"]')
  ?.getAttribute("content");

const state = {
  projection: null,
  filter: "human",
  selectedId: null,
  artifact: null,
  toolEvidence: null,
  decisionPacket: null,
  approvalExplanation: null,
  primaryDecisionPacket: null,
  reviewDecision: null,
  busy: false,
  inspectorReturnFocus: null,
  reviewSession: null,
  pendingDecision: null,
  selectionVersion: 0,
};

const inspector = document.querySelector("#inspector");
const compactInspector = window.matchMedia("(max-width: 1100px)");
let dashboardLoadEpoch = 0;
let dashboardLoadInFlight = null;

function syncInspectorAccessibility() {
  const hidden =
    compactInspector.matches && !inspector.classList.contains("open");
  inspector.hidden = hidden;
  inspector.toggleAttribute("inert", hidden);
  if (hidden) inspector.setAttribute("aria-hidden", "true");
  else inspector.removeAttribute("aria-hidden");
}

compactInspector.addEventListener("change", syncInspectorAccessibility);
syncInspectorAccessibility();

const statusLabels = {
  requested: ["요청됨", "amber"],
  ready: ["준비", "teal"],
  in_progress: ["진행 중", "blue"],
  review_pending: ["검토 필요", "amber"],
  changes_requested: ["수정 요청됨", "red"],
  approved: ["승인됨", "teal"],
  done: ["완료", "gray"],
  failed: ["실패", "red"],
  canceled: ["취소", "gray"],
};

const waitLabels = {
  predecessor: "선행 작업",
  not_before: "예약 시각",
  user_input: "사용자 입력",
  manual_resume: "수동 재개",
  approval: "사람 승인",
};

const apiHeaders = (mutation = false) => ({
  accept: "application/json",
  "x-chartermesh-session": sessionToken,
  ...(mutation
    ? {
        "content-type": "application/json",
        "x-idempotency-key": crypto.randomUUID(),
      }
    : {}),
});

async function api(path, options = {}) {
  const mutation = options.method && options.method !== "GET";
  const response = await fetch(path, {
    ...options,
    headers: { ...apiHeaders(mutation), ...(options.headers ?? {}) },
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error ?? "요청을 처리하지 못했습니다.");
  }
  return result;
}

const relativeTime = (value) => {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "시간 정보 없음";
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
};

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function statusPill(item) {
  const availabilityLabels = {
    dependency_waiting: ["선행 대기", "amber"],
    user_input_waiting: ["입력 대기", "amber"],
    approval_waiting: ["승인 대기", "amber"],
    not_before: ["예약 대기", "amber"],
    manual_resume: ["재개 대기", "amber"],
    on_hold: ["보류", "gray"],
  };
  const [label, tone] =
    availabilityLabels[item.availability] ??
    statusLabels[item.status] ??
    [item.status, "gray"];
  return `<span class="status-pill ${tone}">${escapeHtml(label)}</span>`;
}

function actionFor(id) {
  return state.projection?.userActions.find(
    (action) => action.workItemId === id,
  );
}

function nextActionFor(item) {
  const action = actionFor(item.id);
  if (!action) return item.nextAction;
  const labels = {
    human_review:
      item.status === "review_pending"
        ? "산출물을 검토하고 승인 여부 결정"
        : "변경 내용을 검토하고 실행 승인 여부 결정",
    user_input: "요청된 사용자 입력 제공",
    retry: action.actionable
      ? "실패 원인을 확인하고 재시도 결정"
      : "실패 기록 · 자동 조치 없음",
    triage: "담당 역할과 실행 대상 지정",
    resume:
      item.status === "changes_requested"
        ? "요청된 수정 사항 반영"
        : "진행 중인 작업 계속",
    start: "준비된 작업 실행",
    complete: "승인된 작업 완료 확정",
    waiting: item.wait?.reason ?? "대기 조건 해소",
  };
  return labels[action.category] ?? action.reason ?? item.nextAction;
}

function filteredItems() {
  const items = state.projection?.workItems ?? [];
  if (state.filter === "human") {
    return items.filter(
      (item) =>
        actionFor(item.id)?.actor === "human" &&
        actionFor(item.id)?.actionable,
    );
  }
  if (state.filter === "agents") {
    return items.filter(
      (item) =>
        actionFor(item.id)?.actor === "role" &&
        actionFor(item.id)?.actionable,
    );
  }
  if (state.filter === "waiting") {
    return items.filter(
      (item) =>
        !["done", "canceled", "failed"].includes(item.status) &&
        !actionFor(item.id)?.actionable,
    );
  }
  if (state.filter === "history") {
    return items.filter((item) =>
      ["done", "canceled", "failed"].includes(item.status),
    );
  }
  return items;
}

async function setFilter(filter, scroll = false) {
  state.filter = filter;
  document.querySelectorAll("[data-filter]").forEach((button) => {
    const active = button.dataset.filter === filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-summary-filter]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.summaryFilter === filter),
    );
  });
  const visibleItems = filteredItems();
  if (
    state.selectedId &&
    !visibleItems.some(({ id }) => id === state.selectedId)
  ) {
    await selectWork(visibleItems[0]?.id ?? null, false);
  } else {
    renderWork();
  }
  if (scroll) {
    document.querySelector("#work-heading").scrollIntoView({
      behavior: "smooth",
    });
  }
}

function renderSummary() {
  const summary = state.projection?.summary;
  if (!summary) return;
  document.querySelector("#summary-human").textContent =
    summary.humanDecisions;
  document.querySelector("#summary-agents").textContent =
    summary.agentActions;
  document.querySelector("#summary-waiting").textContent = summary.waiting;
  document.querySelector("#summary-history").textContent = summary.history;
}

function renderDecisionFocus() {
  const action = state.projection?.attention?.primaryDecision;
  const item = action
    ? state.projection.workItems.find(({ id }) => id === action.workItemId)
    : null;
  const content = document.querySelector("#decision-focus-content");
  const empty = document.querySelector("#decision-focus-empty");
  content.hidden = !item;
  empty.hidden = Boolean(item);
  const total = state.projection?.summary?.humanDecisions ?? 0;
  document.querySelector("#focus-position").textContent = item
    ? `1 / ${total.toLocaleString("ko-KR")}`
    : "0건";
  if (!item) return;

  const packet = state.primaryDecisionPacket;
  const kindLabels = {
    artifact_review: "산출물 결정",
    tool_execution: "도구 실행 결정",
    user_input: "사용자 입력",
  };
  document.querySelector("#focus-kind").textContent =
    kindLabels[packet?.kind] ??
    (action.category === "user_input" ? "사용자 입력" : "사람 결정");
  document.querySelector("#focus-question").textContent =
    packet?.kind === "artifact_review"
      ? `“${item.title}” 결과물을 받아들일까요?`
      : packet?.kind === "tool_execution"
        ? `“${item.title}”의 도구 작업을 허락할까요?`
        : packet?.question ?? `${item.title}에 대해 결정이 필요합니다.`;
  document.querySelector("#focus-result").textContent =
    packet?.producerReport?.summary ?? item.summary;
  const verified = (packet?.evidence ?? []).filter(
    ({ source, status }) =>
      ["tool_runtime", "host_validator"].includes(source) &&
      status === "verified",
  ).length;
  const claimed = (packet?.evidence ?? []).filter(
    ({ source, status }) => source === "model_reported" && status === "claimed",
  ).length;
  document.querySelector("#focus-evidence").textContent = packet
    ? `검증된 실행 ${verified}건 · 작업자 주장 ${claimed}건`
    : "패킷을 불러오는 중";
  const blocking = (packet?.exceptions ?? []).filter(
    ({ severity }) => severity === "blocking",
  ).length;
  const warnings = (packet?.exceptions ?? []).filter(
    ({ severity }) => severity === "warning",
  ).length;
  document.querySelector("#focus-risk").textContent = packet
    ? `승인을 막는 문제 ${blocking}건 · 주의 ${warnings}건`
    : "미확인";
  document.querySelector("#focus-consequence").textContent =
    packet?.kind === "tool_execution"
      ? "승인하면 이 정확한 호출만 실행 가능, 거부하면 실행 없이 작업 종료"
      : packet?.kind === "user_input"
        ? "입력하면 대기 중인 작업을 재개"
        : "승인하면 결과물을 받아들였다고 기록합니다. 수정 요청하면 담당자가 보완합니다. 게시·배포 허락은 별개입니다.";
  const button = document.querySelector("#focus-open-button");
  button.dataset.selectId = item.id;
  button.setAttribute("aria-controls", "inspector");
}

function renderWork() {
  const items = filteredItems();
  const table = document.querySelector("#work-table-body");
  const mobile = document.querySelector("#mobile-work-list");
  document.querySelector("#empty-state").hidden = items.length > 0;
  table.innerHTML = items
    .map(
      (item) => `
        <tr data-row-id="${escapeHtml(item.id)}" class="${item.id === state.selectedId ? "selected" : ""}">
          <td>${statusPill(item)}</td>
          <td>
            <button class="work-title" type="button" aria-controls="inspector" aria-current="${item.id === state.selectedId ? "true" : "false"}" data-select-id="${escapeHtml(item.id)}">
              ${escapeHtml(item.title)}
            </button>
            <span class="work-id">${escapeHtml(item.id)}</span>
          </td>
          <td class="owner-cell">${escapeHtml(item.ownerRole)}</td>
          <td class="next-cell">${escapeHtml(nextActionFor(item))}</td>
          <td class="updated-cell">${escapeHtml(relativeTime(item.updatedAt))}</td>
        </tr>`,
    )
    .join("");
  mobile.innerHTML = items
    .map(
      (item) => `
        <button class="mobile-card" type="button" aria-controls="inspector" aria-current="${item.id === state.selectedId ? "true" : "false"}" data-select-id="${escapeHtml(item.id)}">
          <span class="mobile-card-top">${statusPill(item)}<span class="work-id">${escapeHtml(item.id)}</span></span>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(nextActionFor(item))}</p>
        </button>`,
    )
    .join("");
}

function latestPendingTool() {
  const newestFirst = [...(state.toolEvidence?.pendingToolCalls ?? [])].reverse();
  return (
    newestFirst.find(
      ({ arguments: args, status }) =>
        status === "approval_required" &&
        args &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        typeof args.unparsed !== "string",
    ) ??
    newestFirst.find(({ status }) => status === "executed") ??
    newestFirst.find(({ status }) => status === "approval_required")
  );
}

function activePendingTool(item) {
  const pending = latestPendingTool();
  return item?.status === "in_progress" &&
    item.availability === "approval_waiting" &&
    item.wait?.type === "approval" &&
    pending?.status === "approval_required" &&
    item.wait.reference === pending.callHash
    ? pending
    : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function humanReviewText(value) {
  const exact = {
    "Missing evidence of file inspection or test execution":
      "파일을 확인했거나 테스트를 실행했다는 증거가 없습니다.",
    "No filesystem evidence was supplied.":
      "파일 시스템을 확인했다는 증거가 없습니다.",
    "Inspect the requested files in a future run.":
      "다음 실행에서 요청된 파일을 직접 확인해야 합니다.",
    "Schema validated.": "구조화된 산출물 형식 검사를 통과했습니다.",
    "Human review.": "사람의 검토가 필요합니다.",
    "Human approved the recommended changes request: preserve the useful nine-package draft but fix compatibility coverage, priorities, evidence quality, and core-versus-operator ownership.":
      "기존 9개 패키지 초안의 유용한 부분은 유지하되, 호환성 범위·우선순위·검증 근거의 품질·코어와 운영자 책임 구분을 보완하라는 요청입니다.",
  };
  if (exact[value]) return exact[value];
  const verify = value.match(
    /^Verify the implementation of (.+) against the acceptance criteria\.$/u,
  );
  if (verify) {
    return `${verify[1]} 구현이 완료 기준을 충족하는지 확인해야 합니다.`;
  }
  const runAcceptance = value.match(
    /^Run the acceptance tests defined in (.+)\.$/u,
  );
  if (runAcceptance) {
    return `${runAcceptance[1]}에 정의된 승인 테스트를 실행해야 합니다.`;
  }
  return value;
}

function criterionText(result) {
  const status = {
    satisfied: "충족",
    failed: "실패",
    unverified: "미확인",
  }[result.status] ?? "미확인";
  const explanation = {
    satisfied: "선언된 결정적 근거 요구사항을 모두 확인했습니다.",
    failed: "필수 실행 또는 검증 중 하나 이상이 실패했습니다.",
    unverified: "결정적 근거로 확인되지 않았으므로 사람이 근거와 원문을 확인해야 합니다.",
  }[result.status] ?? "사람의 확인이 필요합니다.";
  return `${status} · ${result.criterionId} — ${explanation}`;
}

function exceptionText(exception) {
  const subject = String(exception.message ?? "").split(":")[0].trim();
  const messages = {
    CONTRACT_INCOMPLETE: "명시적인 완료 기준이 없어 원래 목표를 직접 판단해야 합니다.",
    ARTIFACT_UNSTRUCTURED: "산출물이 정해진 구조화 형식을 충족하지 않아 요약을 신뢰할 수 없습니다.",
    EVIDENCE_MISSING: subject
      ? `${subject}: 확인 가능한 근거가 부족합니다.`
      : "필수 완료 기준의 확인 가능한 근거가 부족합니다.",
    EVIDENCE_FAILED: subject
      ? `${subject}: 필수 실행 또는 검증이 실패했습니다.`
      : "필수 실행 또는 검증이 실패했습니다.",
    MODEL_REPORTED_ONLY: "작업자가 보고한 확인 사항은 개별 실행 근거와 연결되지 않은 주장입니다.",
    LOW_CONFIDENCE: "작업자가 자신의 결과 신뢰도를 낮음으로 평가했습니다.",
    UNRESOLVED_RISK: "작업자가 보고한 위험이 남아 있습니다.",
  };
  const label = exception.severity === "blocking" ? "차단" : "주의";
  return `[${label}] ${messages[exception.code] ?? humanReviewText(exception.message)}`;
}

function renderReviewList(selector, values, emptyText) {
  const list = document.querySelector(selector);
  const entries = Array.isArray(values)
    ? values.filter((value) => typeof value === "string" && value.trim())
    : [];
  list.classList.toggle("empty", entries.length === 0);
  list.innerHTML = (entries.length > 0 ? entries : [emptyText])
    .map((value) => `<li>${escapeHtml(humanReviewText(value))}</li>`)
    .join("");
}

function reviewSummary(item) {
  if (state.decisionPacket && state.approvalExplanation) {
    return state.approvalExplanation.sections.find(({ id }) => id === "decision")?.text ?? item.summary;
  }
  const pending = activePendingTool(item);
  if (pending) {
    if (pending.toolName !== "workspace.write_file") return "도구 실행을 허락할지 결정하는 요청입니다. 정확한 입력과 외부 영향을 확인하세요.";
    const args = objectValue(pending.arguments);
    const path = typeof args.path === "string" ? args.path : "대상 파일";
    const replacements = Array.isArray(args.replacements)
      ? args.replacements.length
      : null;
    return replacements === null
      ? `"${path}" 변경을 실행해도 되는지 묻는 결재 요청입니다. 영향과 미확인 항목을 먼저 확인하세요.`
      : `"${path}" 한 파일의 코드 ${replacements.toLocaleString("ko-KR")}곳을 바꿔도 되는지 묻는 결재 요청입니다. 영향과 안전장치를 먼저 확인하세요.`;
  }
  if (state.decisionPacket) {
    const verified = state.decisionPacket.evidence.filter(
      ({ source, status }) =>
        ["tool_runtime", "host_validator"].includes(source) &&
        status === "verified",
    ).length;
    const blocking = state.decisionPacket.exceptions.filter(
      ({ severity }) => severity === "blocking",
    ).length;
    return `${state.decisionPacket.producerReport?.summary ?? item.summary} 검증된 근거 ${verified.toLocaleString("ko-KR")}건, 차단 예외 ${blocking.toLocaleString("ko-KR")}건을 바탕으로 결정하세요.`;
  }
  return item.summary;
}

function inspectorTitle(item) {
  const pending = activePendingTool(item);
  if (pending) {
    if (pending.toolName !== "workspace.write_file") return `${item.title} · 실행 결재`;
    const args = objectValue(pending.arguments);
    const changeCount = Number(pending.summary?.changeCount ?? 0);
    const path =
      changeCount > 0
        ? `${changeCount.toLocaleString("ko-KR")}개 파일`
        : typeof args.path === "string"
          ? args.path
          : "도구 변경";
    return `${path} 변경 결재`;
  }
  return state.decisionPacket?.kind === "artifact_review"
    ? `${item.title} · 산출물 결정`
    : item.title;
}

function renderActions(item) {
  const actions = document.querySelector("#inspector-actions");
  const disabled = state.busy ? "disabled" : "";
  const pending = activePendingTool(item);
  const pendingArgs = objectValue(pending?.arguments);
  const hasApprovableToolChange =
    pending &&
    !pending.approved &&
    typeof pendingArgs.unparsed !== "string";
  if (hasApprovableToolChange) {
    actions.innerHTML = "";
    return;
  }
  if (actionFor(item.id)?.category === "user_input") {
    actions.innerHTML = `<button class="primary-button" data-user-input ${disabled}>요청된 입력 제공</button>`;
  } else if (item.status === "requested") {
    actions.innerHTML = `<button class="primary-button" data-action="triage" ${disabled}>담당 지정</button>`;
  } else if (["ready", "changes_requested"].includes(item.status)) {
    actions.innerHTML = `<button class="primary-button" data-action="run" ${disabled}>모델 실행</button>`;
  } else if (item.status === "in_progress") {
    actions.innerHTML = `<button class="secondary-button danger" data-action="cancel" ${disabled}>실행 취소</button>`;
  } else if (item.status === "failed") {
    actions.innerHTML = `
      <p class="history-note">실패는 현재 사람의 의무가 아닌 보존 이력입니다. 원인을 확인한 뒤에만 선택적으로 다시 준비할 수 있습니다.</p>
      <button class="secondary-button" data-action="retry" ${disabled}>원인 확인 후 재시도 준비</button>`;
  } else if (item.status === "review_pending") {
    actions.innerHTML = `
      <button class="primary-button" data-action="approve" ${disabled}>산출물 승인</button>
      <button class="secondary-button" data-action="changes_requested" ${disabled}>수정 요청</button>
      <button class="secondary-button danger" data-action="reject" ${disabled}>거절</button>`;
  } else if (item.status === "approved") {
    actions.innerHTML = `<button class="primary-button" data-action="complete" ${disabled}>완료 확정</button>`;
  } else if (["done", "canceled"].includes(item.status)) {
    actions.innerHTML = `<button class="secondary-button" data-action="archive" ${disabled}>보관</button>`;
  } else {
    actions.innerHTML = "";
  }
}

function renderArtifact() {
  const block = document.querySelector("#artifact-block");
  const packet = state.decisionPacket;
  const producer = packet?.producerReport;
  block.hidden = !state.artifact || packet?.kind !== "artifact_review";
  if (block.hidden) return;
  const summary =
    producer?.summary ?? "제작자 요약이 없어 원문을 직접 확인해야 합니다.";
  const confidence = {
    high: "모델 자체평가: 높음",
    medium: "모델 자체평가: 보통",
    low: "모델 자체평가: 낮음",
  }[producer?.confidence] ?? "모델 자체평가: 알 수 없음";

  document.querySelector("#artifact-deliverable").textContent =
    summary.length > 120 ? `${summary.slice(0, 117)}…` : summary;
  const confidenceBadge = document.querySelector("#artifact-confidence");
  confidenceBadge.textContent = confidence;
  confidenceBadge.className = "review-badge neutral";
  document.querySelector("#artifact-summary").textContent = summary;
  renderReviewList(
    "#artifact-criteria",
    (packet?.criteria ?? []).map(criterionText),
    "명시적으로 투영된 완료 기준이 없습니다.",
  );
  renderReviewList(
    "#artifact-verified-evidence",
    (packet?.evidence ?? [])
      .filter(
        ({ source, status }) =>
          ["tool_runtime", "host_validator"].includes(source) &&
          status === "verified",
      )
      .map(({ description }) => description),
    "제어면이 확인한 실행 또는 검증 증거가 없습니다.",
  );
  renderReviewList(
    "#artifact-checks",
    producer?.reportedChecks,
    "작업자가 보고한 수행 근거가 없습니다.",
  );
  renderReviewList(
    "#artifact-risks",
    [
      ...(producer?.reportedRisks ?? []),
      ...(packet?.exceptions ?? []).map(exceptionText),
    ],
    "보고된 위험은 없지만 위험이 없다는 뜻은 아닙니다.",
  );
  renderReviewList(
    "#artifact-next-actions",
    producer?.nextActions,
    "보고된 후속 조치가 없습니다.",
  );
  document.querySelector("#artifact-hash").textContent =
    state.artifact.sha256;
  document.querySelector("#artifact-packet-hash").textContent =
    packet?.binding?.packetHash ?? "패킷 없음";
  document.querySelector("#artifact-content").textContent =
    state.artifact.content;
}

function renderApprovalExplanation() {
  const block = document.querySelector("#approval-explanation");
  const explanation = state.approvalExplanation;
  block.hidden = !state.decisionPacket || !explanation;
  block.replaceChildren();
  if (block.hidden) return;
  const heading = document.createElement("h3");
  heading.textContent = explanation.heading;
  block.append(heading);
  for (const item of explanation.sections) {
    const section = document.createElement("section");
    section.className = "review-section";
    section.dataset.explanationSection = item.id;
    const label = document.createElement("h4");
    label.textContent = item.label;
    const text = document.createElement("p");
    text.textContent = item.text;
    section.append(label, text);
    block.append(section);
  }
}

function renderToolApproval(item) {
  const block = document.querySelector("#tool-approval-block");
  const pending = activePendingTool(item);
  block.hidden = !pending;
  if (!pending) return;

  const args =
    pending.arguments &&
    typeof pending.arguments === "object" &&
    !Array.isArray(pending.arguments)
      ? pending.arguments
      : {};
  const isFileWrite = pending.toolName === "workspace.write_file";
  const unparsed = typeof args.unparsed === "string";
  const replacements = Array.isArray(args.replacements)
    ? args.replacements
    : null;
  const changeSet = objectValue(args.changeSet);
  const changes = Array.isArray(changeSet.changes)
    ? changeSet.changes.filter(
        (change) =>
          change &&
          typeof change === "object" &&
          !Array.isArray(change) &&
          typeof change.path === "string" &&
          typeof change.content === "string",
      )
    : [];
  const summaryChanges = Array.isArray(pending.summary?.changes)
    ? pending.summary.changes
    : [];
  const isChangeSet = changes.length > 0;
  const content =
    !isFileWrite
      ? JSON.stringify(args, null, 2)
      : isChangeSet
      ? changes
          .map((change, index) => {
            const summary = summaryChanges.find(
              (entry) => entry.path === change.path,
            );
            return [
              `===== 파일 ${index + 1}/${changes.length}: ${change.path} =====`,
              `승인 전 SHA-256: ${change.beforeSha256 ?? "없음(새 파일)"}`,
              `승인 후 SHA-256: ${summary?.afterSha256 ?? "요약 없음"}`,
              `UTF-8 크기: ${(summary?.byteSize ?? new TextEncoder().encode(change.content).byteLength).toLocaleString("ko-KR")}바이트`,
              "",
              change.content,
            ].join("\n");
          })
          .join("\n\n")
      : typeof args.content === "string"
      ? args.content
      : replacements
        ? [
            `expected SHA-256: ${args.expectedSha256 ?? "없음"}`,
            "",
            ...replacements.flatMap((replacement, index) => [
              `@@ 정확한 치환 ${index + 1} · 예상 ${replacement.expectedOccurrences ?? 1}회 @@`,
              "--- 기존 원문",
              String(replacement.oldText ?? ""),
              "+++ 변경 원문",
              String(replacement.newText ?? ""),
              "",
            ]),
          ].join("\n")
      : unparsed
        ? args.unparsed
        : JSON.stringify(args, null, 2);
  const path =
    isChangeSet
      ? `${changes.length.toLocaleString("ko-KR")}개 파일`
      : typeof args.path === "string"
      ? args.path
      : unparsed
        ? "파싱되지 않은 도구 인자"
        : "경로 없음";
  const byteSize = new TextEncoder().encode(content).byteLength;

  document.querySelector("#tool-change-title").textContent =
    isFileWrite ? `${path} 변경 승인` : `${pending.toolName} 실행 승인`;
  document.querySelector("#tool-name").textContent = pending.toolName;
  document.querySelector("#tool-size").textContent =
    isChangeSet
      ? `${changes.length.toLocaleString("ko-KR")}개 파일 · ${(pending.summary?.totalBytes ?? byteSize).toLocaleString("ko-KR")}바이트 · 원자적 적용`
      : replacements
      ? `${replacements.length.toLocaleString("ko-KR")}개 정확한 치환 · SHA 고정`
      : `${byteSize.toLocaleString("ko-KR")}바이트 · ${content.split(/\r?\n/).length.toLocaleString("ko-KR")}줄`;
  document.querySelector("#tool-call-hash").textContent = pending.callHash;
  document.querySelector("#tool-packet-hash").textContent =
    state.decisionPacket?.binding?.packetHash ?? "패킷 없음";
  document.querySelector("#tool-content").textContent = content;
  document.querySelector("#tool-impact").textContent = !isFileWrite
    ? pending.toolName === "web.search"
      ? "검색어를 설정된 검색 서버로 보냅니다. 검색어에 비밀정보가 없는지 확인하세요. 비용과 서버의 데이터 보관 방식은 별도로 확인해야 합니다."
      : "이 도구를 아래의 정확한 입력 내용으로 실행하도록 허락합니다. 파일 변경·외부 전송·비용이 생기는지는 도구의 설명과 입력을 확인하세요."
    : isChangeSet
    ? `프로젝트 내부 ${changes.length.toLocaleString("ko-KR")}개 파일을 하나의 승인 단위로 변경합니다. 모든 경로·승인 전 해시·승인 후 전체 바이트는 아래 기술 상세에 함께 표시됩니다.`
    : replacements
      ? `프로젝트 내부의 "${path}" 파일에서 기존 코드 ${replacements.length.toLocaleString("ko-KR")}곳만 정확히 찾아 교체합니다. 파일 전체를 덮어쓰지 않으며 다른 파일은 변경하지 않습니다.`
      : `프로젝트 내부의 "${path}" 파일 내용을 ${byteSize.toLocaleString("ko-KR")}바이트 규모로 변경합니다. 정확한 원문은 아래 기술 상세에서 확인할 수 있습니다.`;
  const safeguards = !isFileWrite
    ? ["표시된 정확한 도구 호출만 승인합니다. 다음 작업까지 허락하는 것은 아닙니다.", "영향이나 복구 방법을 모르면 먼저 설명을 요청하세요."]
    : isChangeSet
    ? [
        "표시된 모든 파일의 현재 SHA-256 또는 부재 상태가 승인 시점과 같을 때만 실행합니다.",
        "한 파일이라도 달라졌으면 변경 묶음 전체를 적용하지 않습니다.",
        "승인된 전체 바이트를 복구 가능한 파일 트랜잭션으로 원자적으로 적용합니다.",
        "CharterMesh 제어 파일과 프로젝트 밖 경로는 변경 묶음에 포함할 수 없습니다.",
      ]
    : replacements
      ? [
        typeof args.expectedSha256 === "string"
          ? "검토한 파일과 현재 파일의 SHA-256이 같을 때만 실행합니다."
          : "현재 파일의 SHA-256 고정 정보가 없습니다.",
        "각 교체 대상이 지정된 횟수만큼 정확히 존재할 때만 실행합니다.",
        "하나라도 일치하지 않으면 파일을 전혀 변경하지 않습니다.",
        ]
      : [
        "사람이 이 정확한 호출 해시를 승인하기 전에는 실행되지 않습니다.",
        "프로젝트 경로 밖의 파일에는 접근할 수 없습니다.",
      ];
  renderReviewList("#tool-safeguards", safeguards, "표시할 안전장치가 없습니다.");
  document.querySelector("#tool-verification").textContent =
    "이 결재는 변경 실행만 허용합니다. 테스트 통과나 기능 완성을 뜻하지 않으며, 실행 후 별도의 검증 결과를 확인해야 합니다.";

  const badge = document.querySelector("#tool-change-state");
  badge.textContent = pending.approved
    ? "승인됨"
    : unparsed
      ? "실행 불가"
      : "검토 필요";
  badge.className = `review-badge ${
    pending.approved ? "approved" : unparsed ? "invalid" : ""
  }`;

  const warning = document.querySelector("#tool-warning");
  warning.hidden = !unparsed;
  warning.textContent = unparsed
    ? "도구 인자가 완전한 JSON이 아니므로 승인할 수 없습니다. 재생성을 요청하세요."
    : "";

  const button = document.querySelector("#tool-approve-button");
  button.hidden = unparsed;
  button.disabled = pending.approved || state.busy;
  button.textContent = pending.approved
    ? "정확한 도구 실행 승인됨"
    : isFileWrite ? "위 내용을 확인하고 변경 승인" : "위 내용을 확인하고 도구 실행 승인";
  const denyButton = document.querySelector("#tool-deny-button");
  denyButton.disabled = pending.approved || state.busy;
  denyButton.hidden = pending.approved;
}

function renderReviewFeedback(item) {
  const block = document.querySelector("#review-feedback-block");
  const decision =
    item.status === "changes_requested" ? state.reviewDecision : null;
  block.hidden = !decision;
  if (!decision) return;
  document.querySelector("#review-feedback-note").textContent =
    humanReviewText(decision.note) ||
    "구체적인 수정 사유가 기록되지 않았습니다.";
  const actor = String(decision.actor).startsWith("human:")
    ? "사람 검토자"
    : decision.actor;
  document.querySelector("#review-feedback-meta").textContent =
    `${actor} · ${new Date(decision.createdAt).toLocaleString("ko-KR")}`;
}

function renderInspector() {
  const item = state.projection?.workItems.find(
    ({ id }) => id === state.selectedId,
  );
  const content = document.querySelector("#inspector-content");
  if (!item) {
    const inspectorHadFocus = inspector.contains(document.activeElement);
    document.querySelector("#inspector-heading").textContent =
      "작업을 선택하세요";
    document.querySelector("#inspector-summary").textContent =
      "표에서 작업을 선택하면 현재 상태, 다음 조치, 승인 대기 변경과 계보를 볼 수 있습니다.";
    content.hidden = true;
    inspector.classList.remove("open");
    syncInspectorAccessibility();
    if (inspectorHadFocus) {
      document.querySelector("#new-request-button").focus();
    }
    return;
  }
  document.querySelector("#inspector-heading").textContent =
    inspectorTitle(item);
  document.querySelector("#inspector-summary").textContent =
    reviewSummary(item);
  const reviewSource = document.querySelector("#task-instructions-block");
  const isReview = Boolean(state.decisionPacket);
  reviewSource.hidden = !isReview;
  document.querySelector("#task-instructions").textContent = item.summary;
  document.querySelector("#original-decision-question").textContent = state.decisionPacket?.question ?? "";
  document.querySelector("#inspector-status").innerHTML = statusPill(item);
  document.querySelector("#inspector-action").textContent =
    nextActionFor(item);
  document.querySelector("#inspector-owner").textContent = item.ownerRole;
  document.querySelector("#inspector-target").textContent =
    item.executionTarget;
  document.querySelector("#inspector-lineage").textContent =
    `root ${item.rootId}${item.parentId ? ` · parent ${item.parentId}` : " · root intake"}`;
  const waitBlock = document.querySelector("#inspector-wait-block");
  waitBlock.hidden = !item.wait;
  if (item.wait) {
    const resume = item.wait.resumeAt
      ? ` · ${new Date(item.wait.resumeAt).toLocaleString("ko-KR")}`
      : "";
    const waitReason =
      item.wait.reason === "Human review required."
        ? "사람의 산출물 검토가 필요합니다."
        : item.wait.reason;
    document.querySelector("#inspector-wait").textContent =
      `${waitLabels[item.wait.type] ?? item.wait.type}: ${waitReason}${resume}`;
  }
  renderReviewFeedback(item);
  renderApprovalExplanation();
  renderToolApproval(item);
  renderArtifact();
  renderActions(item);
  content.hidden = false;
}

function reviewIsActive() {
  const action = actionFor(state.selectedId);
  return (
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    inspector.classList.contains("open") &&
    state.reviewSession?.workItemId === state.selectedId &&
    action?.actor === "human" &&
    action.actionable
  );
}

function flushReviewClock() {
  const session = state.reviewSession;
  if (!session?.activeStartedAt) return;
  session.activeMs += Math.max(0, performance.now() - session.activeStartedAt);
  session.activeStartedAt = null;
}

function syncReviewClock() {
  flushReviewClock();
  if (state.reviewSession && reviewIsActive()) {
    state.reviewSession.activeStartedAt = performance.now();
  }
}

function beginReviewSession(id) {
  const action = actionFor(id);
  if (action?.actor !== "human" || !action.actionable) {
    flushReviewClock();
    state.reviewSession = null;
    return;
  }
  if (state.reviewSession?.workItemId === id) {
    syncReviewClock();
    return;
  }
  flushReviewClock();
  state.reviewSession = {
    workItemId: id,
    activeMs: 0,
    activeStartedAt: reviewIsActive() ? performance.now() : null,
    detailsOpenCount: 0,
  };
}

function reviewMetrics() {
  flushReviewClock();
  const session = state.reviewSession;
  const metrics =
    session?.workItemId === state.selectedId
      ? {
          activeReviewMs: Math.round(session.activeMs),
          detailsOpenCount: session.detailsOpenCount,
        }
      : {};
  syncReviewClock();
  return metrics;
}

async function selectWork(
  id,
  focusInspector = true,
  preserveDetails = false,
  preserveInspectorState = false,
) {
  const selectionVersion = ++state.selectionVersion;
  const inspectorWasOpen = inspector.classList.contains("open");
  const source = document.activeElement?.closest?.("[data-select-id]");
  const sourceSelector = source?.classList.contains("mobile-card")
    ? `.mobile-card[data-select-id="${CSS.escape(id)}"]`
    : `.work-title[data-select-id="${CSS.escape(id)}"]`;
  flushReviewClock();
  state.selectedId = id;
  const action = actionFor(id);
  if (
    !id ||
    action?.actor !== "human" ||
    !action.actionable ||
    state.reviewSession?.workItemId !== id
  ) {
    state.reviewSession = null;
  }
  state.artifact = null;
  state.toolEvidence = null;
  state.decisionPacket = null;
  state.approvalExplanation = null;
  state.reviewDecision = null;
  if (!preserveDetails) {
    document.querySelectorAll(".technical-details").forEach((details) => {
      details.open = false;
    });
  }
  if (!id) {
    renderWork();
    renderInspector();
    return;
  }
  const item = state.projection?.workItems.find((entry) => entry.id === id);
  const requests = [
    api(`/api/work-items/${encodeURIComponent(id)}/tool-evidence`)
      .then((result) => {
        if (selectionVersion !== state.selectionVersion || state.selectedId !== id) return;
        state.toolEvidence = result;
      })
      .catch((error) => {
        if (selectionVersion !== state.selectionVersion || state.selectedId !== id) return;
        toast(
          error instanceof Error
            ? error.message
            : "도구 증거를 읽지 못했습니다.",
        );
      }),
    api(`/api/work-items/${encodeURIComponent(id)}/decision-packet?explain=project`)
      .then((result) => {
        if (selectionVersion !== state.selectionVersion || state.selectedId !== id) return;
        state.decisionPacket = result.packet;
        state.approvalExplanation = result.explanation;
      })
      .catch(() => {
        if (selectionVersion !== state.selectionVersion || state.selectedId !== id) return;
        state.decisionPacket = null;
        state.approvalExplanation = null;
      }),
  ];
  if (item?.status === "review_pending") {
    requests.push(
      api(`/api/work-items/${encodeURIComponent(id)}/artifact`)
        .then((result) => {
          if (selectionVersion !== state.selectionVersion || state.selectedId !== id) return;
          state.artifact = result;
        })
        .catch((error) => {
          if (selectionVersion !== state.selectionVersion || state.selectedId !== id) return;
          toast(
            error instanceof Error
              ? error.message
              : "산출물을 읽지 못했습니다.",
          );
        }),
    );
  }
  if (item?.status === "changes_requested") {
    requests.push(
      api(`/api/work-items/${encodeURIComponent(id)}/review-decision`)
        .then((result) => {
          if (selectionVersion !== state.selectionVersion || state.selectedId !== id) return;
          state.reviewDecision = result;
        })
        .catch((error) => {
          if (selectionVersion !== state.selectionVersion || state.selectedId !== id) return;
          toast(
            error instanceof Error
              ? error.message
              : "수정 요청 사유를 읽지 못했습니다.",
          );
        }),
    );
  }
  await Promise.all(requests);
  if (selectionVersion !== state.selectionVersion || state.selectedId !== id) return;
  renderWork();
  state.inspectorReturnFocus = document.querySelector(sourceSelector);
  renderInspector();
  if (!preserveDetails && state.approvalExplanation?.mode === "technical") {
    document.querySelectorAll(".technical-details").forEach((details) => { details.open = true; });
  }
  if (!preserveInspectorState || inspectorWasOpen) {
    inspector.classList.add("open");
  }
  syncInspectorAccessibility();
  beginReviewSession(id);
  if (focusInspector) {
    document.querySelector("#inspector-heading").focus();
  }
}

async function loadDashboard({ skipIfInFlight = false } = {}) {
  if (skipIfInFlight && dashboardLoadInFlight) return false;

  const epoch = ++dashboardLoadEpoch;
  const operation = (async () => {
    let projection;
    try {
      projection = await api("/api/dashboard");
    } catch (error) {
      if (epoch !== dashboardLoadEpoch) return false;
      throw error;
    }

    const primaryId =
      projection.attention?.primaryDecision?.workItemId ?? null;
    const primaryVersion = projection.workItems.find(
      ({ id }) => id === primaryId,
    )?.version;
    let primaryDecisionPacket = null;
    if (primaryId) {
      await api(`/api/work-items/${encodeURIComponent(primaryId)}/decision-packet`)
        .then((result) => {
          if (
            result?.workItemId === primaryId &&
            result.binding?.workItemVersion === primaryVersion
          ) {
            primaryDecisionPacket = result;
          }
        })
        .catch(() => {});
    }
    if (epoch !== dashboardLoadEpoch) return false;

    state.projection = projection;
    state.primaryDecisionPacket = primaryDecisionPacket;
    if (
      !state.selectedId ||
      !projection.workItems.some(({ id }) => id === state.selectedId)
    ) {
      state.selectedId =
        state.filter === "human"
          ? primaryId
          : filteredItems()[0]?.id ?? null;
    }
    syncReviewClock();
    renderSummary();
    renderDecisionFocus();
    renderWork();
    renderInspector();
    return true;
  })();

  dashboardLoadInFlight = operation;
  try {
    return await operation;
  } finally {
    if (dashboardLoadInFlight === operation) {
      dashboardLoadInFlight = null;
    }
  }
}

async function loadRuntime() {
  const entries = await api("/api/runtime");
  document.querySelector("#runtime-items").innerHTML = entries
    .map(
      (entry) => `
        <span class="runtime-item ${entry.status === "ready" ? "" : "needs-config"}" title="${escapeHtml(entry.detail)}">
          <i></i>${escapeHtml(entry.id)} · ${entry.status === "ready" ? "준비" : "설정 필요"}
        </span>`,
    )
    .join("");
}

function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    element.hidden = true;
  }, 3_000);
}

async function mutateSelected(action) {
  if (!state.selectedId || state.busy) return;
  const body = {};
  if (action === "retry") {
    const acknowledged = window.confirm(
      "재시도 전에 작업공간을 확인했나요? 이전 실행의 도구 결과가 불명확한 경우, 재시도하면 변경이 중복될 수 있습니다.",
    );
    if (!acknowledged) return;
    body.acknowledgeUnknownToolOutcome = true;
  }
  state.busy = true;
  renderInspector();
  try {
    let path =
      `/api/work-items/${encodeURIComponent(state.selectedId)}/${action}`;
    await api(path, { method: "POST", body: JSON.stringify(body) });
    const messages = {
      retry: "작업을 다시 실행할 수 있도록 준비했습니다.",
      run: "모델 실행을 시작했습니다.",
      cancel: "실행 취소를 요청했습니다.",
      archive: "완료 작업을 보관했습니다.",
    };
    toast(messages[action] ?? "작업 상태를 업데이트했습니다.");
    await loadDashboard();
    if (state.selectedId) await selectWork(state.selectedId, false, true);
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : "작업을 처리하지 못했습니다.",
    );
    await loadDashboard().catch(() => {});
  } finally {
    state.busy = false;
    renderInspector();
  }
}

function openDecisionDialog(action) {
  if (!state.artifact || state.decisionPacket?.kind !== "artifact_review") {
    toast("현재 결정 패킷과 산출물을 먼저 불러와야 합니다.");
    return;
  }
  state.pendingDecision = action;
  const labels = {
    approve: [
      "산출물 승인하고 완료",
      "표시된 결과·근거 강도·위험과 정확한 패킷 해시를 검토했다는 결정이 기록됩니다.",
    ],
    changes_requested: [
      "수정 요청",
      "입력한 사유가 정확한 이전 산출물 해시와 함께 다음 실행팀에 전달됩니다.",
    ],
    reject: [
      "산출물 거절",
      "작업을 종료하되 산출물·근거·결정 기록은 감사 이력으로 보존됩니다.",
    ],
  };
  const [title, copy] = labels[action];
  document.querySelector("#decision-dialog-heading").textContent = title;
  document.querySelector("#decision-dialog-copy").textContent = copy;
  document.querySelector("#decision-submit-button").textContent = title;
  document.querySelector("#decision-note-requirement").textContent =
    action === "approve" ? "(선택)" : "(필수)";
  document.querySelector("#decision-note").value = "";
  document.querySelector("#decision-form-error").textContent = "";
  document.querySelector("#decision-dialog").showModal();
  document.querySelector("#decision-note").focus();
}

async function submitArtifactDecision(event) {
  event.preventDefault();
  if (!state.pendingDecision || !state.selectedId || state.busy) return;
  const noteElement = document.querySelector("#decision-note");
  const errorElement = document.querySelector("#decision-form-error");
  const note = noteElement.value.trim();
  if (state.pendingDecision !== "approve" && note.length < 12) {
    errorElement.textContent =
      "다음 실행자가 바로 행동할 수 있도록 12자 이상의 구체적인 사유를 적어주세요.";
    noteElement.focus();
    return;
  }
  if (!state.artifact || state.decisionPacket?.kind !== "artifact_review") {
    errorElement.textContent = "결정 패킷이 바뀌었습니다. 화면을 새로 불러오세요.";
    return;
  }
  state.busy = true;
  const decision = state.pendingDecision;
  try {
    await api(`/api/work-items/${encodeURIComponent(state.selectedId)}/decision`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        artifactHash: state.artifact.sha256,
        packetHash: state.decisionPacket.binding.packetHash,
        note:
          note ||
          "결과 요약, 근거의 출처와 강도, 위험, 정확한 산출물 및 결정 패킷 해시를 검토했습니다.",
        completeOnApprove: decision === "approve",
        ...reviewMetrics(),
      }),
    });
    document.querySelector("#decision-dialog").close();
    state.reviewSession = null;
    state.selectedId = null;
    await loadDashboard();
    if (state.selectedId) await selectWork(state.selectedId, false);
    toast(
      decision === "approve"
        ? "산출물을 승인하고 작업을 완료했습니다."
        : decision === "changes_requested"
          ? "구체적인 사유와 함께 수정 요청을 전달했습니다."
          : "산출물을 거절하고 기록을 보존했습니다.",
    );
  } catch (error) {
    errorElement.textContent =
      error instanceof Error ? error.message : "결정을 기록하지 못했습니다.";
    await loadDashboard().catch(() => {});
  } finally {
    state.busy = false;
    renderInspector();
  }
}

function openUserInputDialog() {
  if (state.decisionPacket?.kind !== "user_input") {
    toast("현재 사용자 입력 패킷을 먼저 불러와야 합니다.");
    return;
  }
  document.querySelector("#input-dialog-question").textContent =
    state.decisionPacket.question;
  document.querySelector("#input-response").value = "";
  document.querySelector("#input-form-error").textContent = "";
  document.querySelector("#input-dialog").showModal();
  document.querySelector("#input-response").focus();
}

async function submitUserInput(event) {
  event.preventDefault();
  if (!state.selectedId || state.busy) return;
  const response = document.querySelector("#input-response").value.trim();
  const errorElement = document.querySelector("#input-form-error");
  if (!response) {
    errorElement.textContent = "작업을 재개할 수 있도록 응답을 입력하세요.";
    return;
  }
  if (state.decisionPacket?.kind !== "user_input") {
    errorElement.textContent = "입력 요청 패킷이 바뀌었습니다. 다시 불러오세요.";
    return;
  }
  state.busy = true;
  try {
    await api(`/api/work-items/${encodeURIComponent(state.selectedId)}/provide-input`, {
      method: "POST",
      body: JSON.stringify({
        response,
        packetHash: state.decisionPacket.binding.packetHash,
        ...reviewMetrics(),
      }),
    });
    document.querySelector("#input-dialog").close();
    state.reviewSession = null;
    state.selectedId = null;
    await loadDashboard();
    if (state.selectedId) await selectWork(state.selectedId, false);
    toast("입력을 정확한 요청 패킷에 결박해 전달했습니다.");
  } catch (error) {
    errorElement.textContent =
      error instanceof Error ? error.message : "입력을 전달하지 못했습니다.";
  } finally {
    state.busy = false;
    renderInspector();
  }
}

async function approvePendingTool() {
  if (!state.selectedId || state.busy) return;
  const item = state.projection?.workItems.find(
    ({ id }) => id === state.selectedId,
  );
  const pending = activePendingTool(item);
  if (!pending || pending.approved) return;
  if (
    state.decisionPacket?.kind !== "tool_execution" ||
    state.decisionPacket.subject?.callHash !== pending.callHash
  ) {
    toast("도구 결정 패킷이 바뀌었습니다. 작업을 다시 선택하세요.");
    return;
  }
  state.busy = true;
  renderToolApproval(item);
  try {
    await api(
      `/api/work-items/${encodeURIComponent(state.selectedId)}/approve-tool`,
      {
        method: "POST",
        body: JSON.stringify({
          callHash: pending.callHash,
          toolName: pending.toolName,
          packetHash: state.decisionPacket?.binding?.packetHash ?? "",
          note: "로컬 대시보드 코드 미리보기에서 정확한 변경을 검토했습니다.",
          ...reviewMetrics(),
        }),
      },
    );
    state.reviewSession = null;
    state.selectedId = null;
    await loadDashboard();
    if (state.selectedId) await selectWork(state.selectedId, false);
    toast("정확한 도구 변경을 승인했습니다.");
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : "도구 변경을 승인하지 못했습니다.",
    );
  } finally {
    state.busy = false;
    renderInspector();
  }
}

async function denyPendingTool() {
  if (!state.selectedId || state.busy) return;
  const item = state.projection?.workItems.find(
    ({ id }) => id === state.selectedId,
  );
  const pending = activePendingTool(item);
  if (!pending || pending.approved) return;
  if (
    state.decisionPacket?.kind !== "tool_execution" ||
    state.decisionPacket.subject?.callHash !== pending.callHash
  ) {
    toast("도구 결정 패킷이 바뀌었습니다. 작업을 다시 선택하세요.");
    return;
  }
  if (!window.confirm("이 도구 호출을 거부하고 현재 작업을 종료할까요? 실행은 일어나지 않습니다.")) {
    return;
  }
  state.busy = true;
  renderToolApproval(item);
  try {
    await api(
      `/api/work-items/${encodeURIComponent(state.selectedId)}/deny-tool`,
      {
        method: "POST",
        body: JSON.stringify({
          callHash: pending.callHash,
          toolName: pending.toolName,
          packetHash: state.decisionPacket.binding.packetHash,
          note: "사람이 로컬 대시보드에서 정확한 도구 호출을 거부했습니다.",
          ...reviewMetrics(),
        }),
      },
    );
    state.reviewSession = null;
    state.selectedId = null;
    await loadDashboard();
    if (state.selectedId) await selectWork(state.selectedId, false);
    toast("도구 호출을 거부했고 작업을 안전하게 종료했습니다.");
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : "도구 호출을 거부하지 못했습니다.",
    );
  } finally {
    state.busy = false;
    renderInspector();
  }
}

document.addEventListener("click", (event) => {
  const selection = event.target.closest("[data-select-id]");
  if (selection) void selectWork(selection.dataset.selectId);
  const filter = event.target.closest("[data-filter]");
  if (filter) void setFilter(filter.dataset.filter);
  const summaryFilter = event.target.closest("[data-summary-filter]");
  if (summaryFilter) {
    void setFilter(summaryFilter.dataset.summaryFilter, true);
  }
  const filterNavigation = event.target.closest("[data-filter-nav]");
  if (filterNavigation) {
    void setFilter(filterNavigation.dataset.filterNav, true);
  }
  const action = event.target.closest("[data-action]");
  if (action) {
    if (["approve", "changes_requested", "reject"].includes(action.dataset.action)) {
      openDecisionDialog(action.dataset.action);
    } else {
      void mutateSelected(action.dataset.action);
    }
  }
  if (event.target.closest("[data-tool-approve]")) {
    void approvePendingTool();
  }
  if (event.target.closest("[data-tool-deny]")) {
    void denyPendingTool();
  }
  if (event.target.closest("[data-user-input]")) {
    openUserInputDialog();
  }
});

const dialog = document.querySelector("#request-dialog");
const newRequestButton = document.querySelector("#new-request-button");
newRequestButton.addEventListener("click", () => {
  document.querySelector("#form-error").textContent = "";
  dialog.showModal();
  document.querySelector("#request-title").focus();
});
for (const id of ["#dialog-close", "#dialog-cancel"]) {
  document.querySelector(id).addEventListener("click", () => dialog.close());
}
dialog.addEventListener("close", () => newRequestButton.focus());
dialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    dialog.close();
  }
});

const decisionDialog = document.querySelector("#decision-dialog");
for (const id of ["#decision-dialog-close", "#decision-dialog-cancel"]) {
  document.querySelector(id).addEventListener("click", () => decisionDialog.close());
}
document
  .querySelector("#decision-form")
  .addEventListener("submit", submitArtifactDecision);
decisionDialog.addEventListener("close", () => {
  state.pendingDecision = null;
});
const inputDialog = document.querySelector("#input-dialog");
for (const id of ["#input-dialog-close", "#input-dialog-cancel"]) {
  document.querySelector(id).addEventListener("click", () => inputDialog.close());
}
document.querySelector("#input-form").addEventListener("submit", submitUserInput);

function closeInspector() {
  flushReviewClock();
  inspector.classList.remove("open");
  syncInspectorAccessibility();
  if (state.inspectorReturnFocus?.isConnected) {
    state.inspectorReturnFocus.focus();
  }
}

document
  .querySelector("#inspector-close")
  .addEventListener("click", closeInspector);
inspector.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeInspector();
  }
});

window.addEventListener("focus", syncReviewClock);
window.addEventListener("blur", flushReviewClock);
document.addEventListener("visibilitychange", syncReviewClock);
document.addEventListener(
  "toggle",
  (event) => {
    if (
      event.target instanceof HTMLDetailsElement &&
      event.target.open &&
      event.target.closest("#inspector") &&
      state.reviewSession?.workItemId === state.selectedId
    ) {
      state.reviewSession.detailsOpenCount += 1;
    }
  },
  true,
);

document
  .querySelector("#request-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const error = document.querySelector("#form-error");
    error.textContent = "";
    try {
      const result = await api("/api/work-items", {
        method: "POST",
        body: JSON.stringify({
          title: form.get("title"),
          summary: form.get("summary"),
        }),
      });
      formElement.reset();
      state.selectedId = result.id;
      await loadDashboard();
      dialog.close();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await selectWork(result.id);
      toast("새 요청을 만들었습니다.");
    } catch (caught) {
      error.textContent =
        caught instanceof Error
          ? caught.message
          : "요청을 만들지 못했습니다.";
    }
  });

Promise.all([loadDashboard(), loadRuntime()])
  .then(async () => {
    if (state.selectedId) await selectWork(state.selectedId, false);
  })
  .catch((error) => {
    document.querySelector("#work-table-body").innerHTML =
      `<tr><td class="loading-cell" colspan="5">${escapeHtml(error.message)}</td></tr>`;
  });

window.setInterval(async () => {
  if (state.busy || document.visibilityState !== "visible") return;
  if (dialog.open || decisionDialog.open || inputDialog.open) return;
  if (dashboardLoadInFlight) return;
  const previousPrimary =
    state.projection?.attention?.primaryDecision?.workItemId ?? null;
  const selectedWasPrimary =
    Boolean(previousPrimary) && state.selectedId === previousPrimary;
  try {
    const loaded = await loadDashboard({ skipIfInFlight: true });
    if (!loaded) return;
    const nextPrimary =
      state.projection?.attention?.primaryDecision?.workItemId ?? null;
    if (selectedWasPrimary && nextPrimary !== previousPrimary) {
      await selectWork(nextPrimary, false, true, true);
      return;
    }
    if (state.selectedId) {
      await selectWork(state.selectedId, false, true, true);
    }
  } catch {
    // The visible UI keeps its last known safe projection; the next poll retries.
  }
}, 5_000);
