const sessionToken = document
  .querySelector('meta[name="chartermesh-session"]')
  ?.getAttribute("content");

const state = {
  projection: null,
  filter: "all",
  selectedId: null,
};

const statusLabels = {
  requested: ["요청됨", "amber"],
  ready: ["준비", "teal"],
  in_progress: ["진행 중", "blue"],
  review_pending: ["검토 필요", "amber"],
  changes_requested: ["수정 필요", "red"],
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

const relativeTime = (value) => {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "알 수 없음";
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
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
  return state.projection?.userActions.find((action) => action.workItemId === id);
}

function filteredItems() {
  const items = state.projection?.workItems ?? [];
  if (state.filter === "actionable") {
    return items.filter((item) => actionFor(item.id)?.actionable);
  }
  if (state.filter === "waiting") {
    return items.filter((item) => item.wait && !["done", "canceled"].includes(item.status));
  }
  if (state.filter === "completed") {
    return items.filter((item) => ["done", "canceled"].includes(item.status));
  }
  return items;
}

function renderSummary() {
  const summary = state.projection?.summary;
  if (!summary) return;
  document.querySelector("#summary-actionable").textContent = summary.actionable;
  document.querySelector("#summary-approvals").textContent = summary.approvals;
  document.querySelector("#summary-input").textContent = summary.userInput;
  document.querySelector("#summary-failed").textContent = summary.failed;
}

function renderWork() {
  const items = filteredItems();
  const table = document.querySelector("#work-table-body");
  const mobile = document.querySelector("#mobile-work-list");
  const empty = document.querySelector("#empty-state");
  empty.hidden = items.length > 0;
  table.innerHTML = items
    .map(
      (item) => `
        <tr data-row-id="${escapeHtml(item.id)}" class="${item.id === state.selectedId ? "selected" : ""}">
          <td>${statusPill(item)}</td>
          <td>
            <button class="work-title" type="button" data-select-id="${escapeHtml(item.id)}">
              ${escapeHtml(item.title)}
            </button>
            <span class="work-id">${escapeHtml(item.id)}</span>
          </td>
          <td class="owner-cell">${escapeHtml(item.ownerRole)}</td>
          <td class="next-cell">${escapeHtml(item.nextAction)}</td>
          <td class="updated-cell">${escapeHtml(relativeTime(item.updatedAt))}</td>
        </tr>`,
    )
    .join("");
  mobile.innerHTML = items
    .map(
      (item) => `
        <button class="mobile-card" type="button" data-select-id="${escapeHtml(item.id)}">
          <span class="mobile-card-top">${statusPill(item)}<span class="work-id">${escapeHtml(item.id)}</span></span>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.nextAction)}</p>
        </button>`,
    )
    .join("");
}

function renderInspector() {
  const item = state.projection?.workItems.find(({ id }) => id === state.selectedId);
  const content = document.querySelector("#inspector-content");
  if (!item) {
    content.hidden = true;
    return;
  }
  document.querySelector("#inspector-heading").textContent = item.title;
  document.querySelector("#inspector-summary").textContent = item.summary;
  document.querySelector("#inspector-status").innerHTML = statusPill(item);
  document.querySelector("#inspector-action").textContent = item.nextAction;
  document.querySelector("#inspector-owner").textContent = item.ownerRole;
  document.querySelector("#inspector-target").textContent = item.executionTarget;
  document.querySelector("#inspector-lineage").textContent =
    `root ${item.rootId}${item.parentId ? ` · parent ${item.parentId}` : " · root intake"}`;
  const waitBlock = document.querySelector("#inspector-wait-block");
  waitBlock.hidden = !item.wait;
  if (item.wait) {
    const resume = item.wait.resumeAt ? ` · ${new Date(item.wait.resumeAt).toLocaleString("ko-KR")}` : "";
    document.querySelector("#inspector-wait").textContent =
      `${waitLabels[item.wait.type] ?? item.wait.type}: ${item.wait.reason}${resume}`;
  }
  content.hidden = false;
}

function selectWork(id) {
  state.selectedId = id;
  renderWork();
  renderInspector();
  document.querySelector("#inspector").classList.add("open");
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("대시보드를 읽지 못했습니다.");
  state.projection = await response.json();
  if (!state.selectedId && state.projection.workItems.length > 0) {
    state.selectedId = state.projection.workItems[0].id;
  }
  renderSummary();
  renderWork();
  renderInspector();
}

async function loadRuntime() {
  const response = await fetch("/api/runtime", { headers: { accept: "application/json" } });
  if (!response.ok) return;
  const entries = await response.json();
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
  }, 2500);
}

document.addEventListener("click", (event) => {
  const selection = event.target.closest("[data-select-id]");
  if (selection) selectWork(selection.dataset.selectId);
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    state.filter = filter.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.classList.toggle("active", button === filter);
    });
    renderWork();
  }
});

const dialog = document.querySelector("#request-dialog");
document.querySelector("#new-request-button").addEventListener("click", () => {
  document.querySelector("#form-error").textContent = "";
  dialog.showModal();
  document.querySelector("#request-title").focus();
});
for (const id of ["#dialog-close", "#dialog-cancel"]) {
  document.querySelector(id).addEventListener("click", () => dialog.close());
}
document.querySelector("#inspector-close").addEventListener("click", () => {
  document.querySelector("#inspector").classList.remove("open");
});

document.querySelector("#request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const error = document.querySelector("#form-error");
  error.textContent = "";
  try {
    const response = await fetch("/api/work-items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chartermesh-session": sessionToken,
        "x-idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        title: form.get("title"),
        summary: form.get("summary"),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "요청을 만들지 못했습니다.");
    dialog.close();
    formElement.reset();
    state.selectedId = result.id;
    await loadDashboard();
    toast("새 요청을 만들었습니다.");
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : "요청을 만들지 못했습니다.";
  }
});

Promise.all([loadDashboard(), loadRuntime()]).catch((error) => {
  document.querySelector("#work-table-body").innerHTML =
    `<tr><td class="loading-cell" colspan="5">${escapeHtml(error.message)}</td></tr>`;
});
