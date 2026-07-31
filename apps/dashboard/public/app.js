const sessionToken = document
  .querySelector('meta[name="chartermesh-session"]')
  ?.getAttribute("content");

const state = {
  projection: null,
  filter: "actionable",
  selectedId: null,
  artifact: null,
  toolEvidence: null,
  reviewDecision: null,
  busy: false,
  inspectorReturnFocus: null,
};

const inspector = document.querySelector("#inspector");
const compactInspector = window.matchMedia("(max-width: 1100px)");

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
    waiting: item.wait?.reason ?? "대기 조건 해소",
  };
  return labels[action.category] ?? action.reason ?? item.nextAction;
}

function filteredItems() {
  const items = state.projection?.workItems ?? [];
  if (state.filter === "actionable") {
    return items.filter((item) => actionFor(item.id)?.actionable);
  }
  if (state.filter === "approvals") {
    return items.filter(
      (item) => actionFor(item.id)?.category === "human_review",
    );
  }
  if (state.filter === "user-input") {
    return items.filter(
      (item) => actionFor(item.id)?.category === "user_input",
    );
  }
  if (state.filter === "failed") {
    return items.filter((item) => item.status === "failed");
  }
  if (state.filter === "waiting") {
    return items.filter(
      (item) => item.wait && !["done", "canceled"].includes(item.status),
    );
  }
  if (state.filter === "completed") {
    return items.filter((item) =>
      ["done", "canceled"].includes(item.status),
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
  document.querySelector("#summary-actionable").textContent =
    summary.actionable;
  document.querySelector("#summary-approvals").textContent =
    summary.approvals;
  document.querySelector("#summary-input").textContent = summary.userInput;
  document.querySelector("#summary-failed").textContent = summary.failed;
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

function structuredArtifact() {
  if (!state.artifact?.content) return null;
  try {
    const value = JSON.parse(state.artifact.content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
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
  const pending = activePendingTool(item);
  if (pending) {
    const args = objectValue(pending.arguments);
    const path = typeof args.path === "string" ? args.path : "대상 파일";
    const replacements = Array.isArray(args.replacements)
      ? args.replacements.length
      : null;
    return replacements === null
      ? `"${path}" 변경을 실행해도 되는지 묻는 결재 요청입니다. 영향과 미확인 항목을 먼저 확인하세요.`
      : `"${path}" 한 파일의 코드 ${replacements.toLocaleString("ko-KR")}곳을 바꿔도 되는지 묻는 결재 요청입니다. 영향과 안전장치를 먼저 확인하세요.`;
  }
  if (state.artifact) {
    const artifact = structuredArtifact();
    const deliverable =
      typeof artifact?.deliverable === "string"
        ? artifact.deliverable
        : "제출된 산출물";
    const checkCount = Array.isArray(artifact?.checks)
      ? artifact.checks.length
      : 0;
    const riskCount = Array.isArray(artifact?.risks)
      ? artifact.risks.length
      : 0;
    return `"${deliverable}" 산출물 결재 요청입니다. 보고된 검증 ${checkCount.toLocaleString("ko-KR")}건과 위험 ${riskCount.toLocaleString("ko-KR")}건을 확인한 뒤 결정하세요.`;
  }
  return item.summary;
}

function inspectorTitle(item) {
  const pending = activePendingTool(item);
  if (pending) {
    const args = objectValue(pending.arguments);
    const path = typeof args.path === "string" ? args.path : "도구 변경";
    return `${path} 변경 결재`;
  }
  if (state.artifact) {
    const artifact = structuredArtifact();
    const deliverable =
      typeof artifact?.deliverable === "string"
        ? artifact.deliverable
        : "제출된 산출물";
    return `${deliverable} 산출물 결재`;
  }
  return item.title;
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
  if (item.status === "requested") {
    actions.innerHTML = `<button class="primary-button" data-action="triage" ${disabled}>담당 지정</button>`;
  } else if (["ready", "changes_requested"].includes(item.status)) {
    actions.innerHTML = `<button class="primary-button" data-action="run" ${disabled}>모델 실행</button>`;
  } else if (item.status === "in_progress") {
    actions.innerHTML = `<button class="secondary-button danger" data-action="cancel" ${disabled}>실행 취소</button>`;
  } else if (item.status === "failed") {
    actions.innerHTML = `<button class="secondary-button" data-action="retry" ${disabled}>재시도 준비</button>`;
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
  block.hidden = !state.artifact;
  if (!state.artifact) return;
  const artifact = structuredArtifact();
  const deliverable =
    typeof artifact?.deliverable === "string"
      ? artifact.deliverable
      : "구조화되지 않은 산출물";
  const confidence = {
    high: "신뢰도 높음",
    medium: "신뢰도 보통",
    low: "신뢰도 낮음",
  }[artifact?.confidence] ?? "직접 확인 필요";
  const checkCount = Array.isArray(artifact?.checks)
    ? artifact.checks.length
    : 0;
  const riskCount = Array.isArray(artifact?.risks)
    ? artifact.risks.length
    : 0;

  document.querySelector("#artifact-deliverable").textContent = deliverable;
  const confidenceBadge = document.querySelector("#artifact-confidence");
  confidenceBadge.textContent = confidence;
  confidenceBadge.className = `review-badge ${
    artifact?.confidence === "high"
      ? "approved"
      : artifact?.confidence === "low"
        ? "invalid"
        : ""
  }`;
  document.querySelector("#artifact-summary").textContent = artifact
    ? `"${deliverable}"이 제출되었습니다. 자동 검증 ${checkCount.toLocaleString("ko-KR")}건, 확인된 위험 ${riskCount.toLocaleString("ko-KR")}건입니다.`
    : "구조화된 결재 요약이 없어 원문을 직접 확인해야 합니다.";
  renderReviewList(
    "#artifact-checks",
    artifact?.checks,
    "보고된 자동 검증이 없습니다.",
  );
  renderReviewList(
    "#artifact-risks",
    artifact?.risks,
    "보고된 위험이 없습니다.",
  );
  renderReviewList(
    "#artifact-next-actions",
    artifact?.nextActions,
    "보고된 후속 조치가 없습니다.",
  );
  document.querySelector("#artifact-hash").textContent =
    state.artifact.sha256;
  document.querySelector("#artifact-content").textContent =
    state.artifact.content;
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
  const unparsed = typeof args.unparsed === "string";
  const replacements = Array.isArray(args.replacements)
    ? args.replacements
    : null;
  const content =
    typeof args.content === "string"
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
    typeof args.path === "string"
      ? args.path
      : unparsed
        ? "파싱되지 않은 도구 인자"
        : "경로 없음";
  const byteSize = new TextEncoder().encode(content).byteLength;

  document.querySelector("#tool-change-title").textContent =
    `${path} 변경 승인`;
  document.querySelector("#tool-name").textContent = pending.toolName;
  document.querySelector("#tool-size").textContent =
    replacements
      ? `${replacements.length.toLocaleString("ko-KR")}개 정확한 치환 · SHA 고정`
      : `${byteSize.toLocaleString("ko-KR")}바이트 · ${content.split(/\r?\n/).length.toLocaleString("ko-KR")}줄`;
  document.querySelector("#tool-call-hash").textContent = pending.callHash;
  document.querySelector("#tool-content").textContent = content;
  document.querySelector("#tool-impact").textContent = replacements
    ? `프로젝트 내부의 "${path}" 파일에서 기존 코드 ${replacements.length.toLocaleString("ko-KR")}곳만 정확히 찾아 교체합니다. 파일 전체를 덮어쓰지 않으며 다른 파일은 변경하지 않습니다.`
    : `프로젝트 내부의 "${path}" 파일 내용을 ${byteSize.toLocaleString("ko-KR")}바이트 규모로 변경합니다. 정확한 원문은 아래 기술 상세에서 확인할 수 있습니다.`;
  const safeguards = replacements
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
    ? "정확한 변경 승인됨"
    : "위 내용을 확인하고 변경 승인";
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
  const isReview = Boolean(activePendingTool(item) || state.artifact);
  reviewSource.hidden = !isReview;
  document.querySelector("#task-instructions").textContent = item.summary;
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
  renderToolApproval(item);
  renderArtifact();
  renderActions(item);
  content.hidden = false;
}

async function selectWork(id, focusInspector = true) {
  const source = document.activeElement?.closest?.("[data-select-id]");
  const sourceSelector = source?.classList.contains("mobile-card")
    ? `.mobile-card[data-select-id="${CSS.escape(id)}"]`
    : `.work-title[data-select-id="${CSS.escape(id)}"]`;
  state.selectedId = id;
  state.artifact = null;
  state.toolEvidence = null;
  state.reviewDecision = null;
  document.querySelectorAll(".technical-details").forEach((details) => {
    details.open = false;
  });
  if (!id) {
    renderWork();
    renderInspector();
    return;
  }
  const item = state.projection?.workItems.find((entry) => entry.id === id);
  const requests = [
    api(`/api/work-items/${encodeURIComponent(id)}/tool-evidence`)
      .then((result) => {
        state.toolEvidence = result;
      })
      .catch((error) => {
        toast(
          error instanceof Error
            ? error.message
            : "도구 증거를 읽지 못했습니다.",
        );
      }),
  ];
  if (item?.status === "review_pending") {
    requests.push(
      api(`/api/work-items/${encodeURIComponent(id)}/artifact`)
        .then((result) => {
          state.artifact = result;
        })
        .catch((error) => {
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
          state.reviewDecision = result;
        })
        .catch((error) => {
          toast(
            error instanceof Error
              ? error.message
              : "수정 요청 사유를 읽지 못했습니다.",
          );
        }),
    );
  }
  await Promise.all(requests);
  renderWork();
  state.inspectorReturnFocus = document.querySelector(sourceSelector);
  renderInspector();
  inspector.classList.add("open");
  syncInspectorAccessibility();
  if (focusInspector) {
    document.querySelector("#inspector-heading").focus();
  }
}

async function loadDashboard() {
  state.projection = await api("/api/dashboard");
  if (
    !state.selectedId ||
    !state.projection.workItems.some(({ id }) => id === state.selectedId)
  ) {
    state.selectedId =
      state.projection.userActions.find(({ actionable }) => actionable)
        ?.workItemId ??
      state.projection.workItems[0]?.id ??
      null;
  }
  renderSummary();
  renderWork();
  renderInspector();
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
  state.busy = true;
  renderInspector();
  try {
    let path =
      `/api/work-items/${encodeURIComponent(state.selectedId)}/${action}`;
    let body = {};
    if (["approve", "changes_requested", "reject"].includes(action)) {
      path =
        `/api/work-items/${encodeURIComponent(state.selectedId)}/decision`;
      if (!state.artifact) throw new Error("검토할 산출물이 없습니다.");
      body = {
        decision: action,
        artifactHash: state.artifact.sha256,
        note: "로컬 대시보드에서 정확한 해시를 확인하고 결정했습니다.",
      };
    }
    await api(path, { method: "POST", body: JSON.stringify(body) });
    const messages = {
      retry: "작업을 다시 실행할 수 있도록 준비했습니다.",
      run: "모델 실행을 시작했습니다.",
      cancel: "실행 취소를 요청했습니다.",
      archive: "완료 작업을 보관했습니다.",
    };
    toast(messages[action] ?? "작업 상태를 업데이트했습니다.");
    await loadDashboard();
    if (state.selectedId) await selectWork(state.selectedId, false);
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

async function approvePendingTool() {
  if (!state.selectedId || state.busy) return;
  const item = state.projection?.workItems.find(
    ({ id }) => id === state.selectedId,
  );
  const pending = activePendingTool(item);
  if (!pending || pending.approved) return;
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
          note: "로컬 대시보드 코드 미리보기에서 정확한 변경을 검토했습니다.",
        }),
      },
    );
    state.toolEvidence = await api(
      `/api/work-items/${encodeURIComponent(state.selectedId)}/tool-evidence`,
    );
    await loadDashboard();
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
  if (action) void mutateSelected(action.dataset.action);
  if (event.target.closest("[data-tool-approve]")) {
    void approvePendingTool();
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

function closeInspector() {
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
