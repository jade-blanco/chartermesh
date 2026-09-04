import type { DecisionPacket } from "./types.ts";

/** Presentation only: never changes packet hashes, authority, or evidence status. */
export function projectApprovalExplanation(
  packet: DecisionPacket,
  language: "en" | "ko" = "en",
  detail: "eli5" | "concise" | "technical" = "eli5",
) {
  const ko = language === "ko";
  const tool = packet.kind === "tool_execution";
  const input = packet.kind === "user_input";
  const executionEvidence = packet.evidence.filter(
    ({ source, status }) =>
      ["tool_runtime", "host_validator"].includes(source) && status === "verified",
  ).length;
  const claimed = packet.evidence.filter(({ status }) => status === "claimed").length;
  const failed = packet.criteria.filter(({ status }) => status === "failed").length;
  const unknown = packet.criteria.filter(({ status }) => status === "unverified").length;
  const blocking = packet.exceptions.filter(({ severity }) => severity === "blocking").length;
  const warnings = packet.exceptions.filter(({ severity }) => severity === "warning").length;
  const pick = (en: string, korean: string) => ko ? korean : en;
  const section = (id: string, en: string, korean: string, text: string) => ({
    id, label: pick(en, korean), text,
  });
  const explanation = {
    mode: detail,
    heading: detail === "concise" ? pick("Decision summary", "결재 핵심 요약")
      : detail === "technical" ? pick("Decision record and technical evidence", "결재 기록 및 기술 근거")
      : pick("Before you decide — plain language", "결재 전, 쉬운 설명"),
    sections: [
      section("decision", "What am I deciding?", "무엇을 결정하나요?",
        input
          ? pick("Give the missing answer so the work can continue.", "작업을 계속하는 데 필요한 답을 알려주는 단계입니다.")
          : tool
            ? pick("Decide whether to allow this one tool action. Check the exact action below.", "아래에 나온 도구 작업 한 건을 실행해도 되는지 결정합니다.")
            : pick("Decide whether to accept the submitted result as meeting your request.", "제출된 결과물이 요청에 맞는지 보고 받아들일지 결정합니다.")),
      section("reason", "Why am I being asked?", "왜 내 결정이 필요한가요?",
        input
          ? pick("The work is waiting for your answer; the agent must not guess it for you.", "에이전트가 임의로 정할 수 없는 내용이라 답을 기다리고 있습니다.")
          : pick("This step requires a human decision. An agent saying it is ready is not your approval.", "사람이 결정해야 하는 단계입니다. 에이전트가 준비됐다고 말한 것만으로 허락된 것은 아닙니다.")),
      section("effect", "What happens if I agree?", "승인하면 어떻게 되나요?",
        input
          ? pick("Your answer is saved locally and passed to the next run. Do not include passwords or API keys.", "답변을 로컬 기록에 저장하고 다음 실행에 전달합니다. 비밀번호나 API 키는 쓰지 마세요.")
          : tool
            ? pick("Only this exact action may run on the next claim. This does not mean it has run or passed tests.", "다음 실행에서 이 작업만 허용됩니다. 이미 실행됐거나 테스트를 통과했다는 뜻은 아닙니다.")
            : pick("The result is recorded as accepted. This does not authorize publishing, spending, or another tool action.", "결과물을 받아들였다고 기록합니다. 게시·금전 지출·다른 도구 실행까지 허락하는 것은 아닙니다.")),
      section("evidence", "What is actually checked?", "어디까지 확인됐나요?",
        pick(
          `${executionEvidence} successful execution/validation records; ${claimed} producer claims. ${failed} completion checks failed; ${unknown} remain unverified. Saving an exact copy is not proof that the result works. Read the records below for their scope.`,
          `실행·검증 성공 기록 ${executionEvidence}건, 제작자가 주장한 확인 ${claimed}건입니다. 완료 기준 중 실패 ${failed}건, 미확인 ${unknown}건입니다. 같은 결과물을 보관했다는 사실만으로 잘 작동함이 증명되지는 않습니다. 아래 근거에서 확인 범위를 보세요.`)),
      section("cautions", "What should I watch for?", "무엇을 조심해야 하나요?",
        pick(
          `${blocking} blocking issues and ${warnings} warnings are recorded. Read all risks below. This packet does not establish the cost, external data exposure, or full impact; unknown is not zero or safe. Ask for clarification before agreeing if these matter.`,
          `승인을 막는 문제 ${blocking}건과 주의사항 ${warnings}건이 있습니다. 아래 위험 항목을 모두 확인하세요. 이 결재 정보만으로 비용·외부로 나가는 데이터·전체 영향을 확정할 수는 없습니다. 모른다는 것은 무료이거나 안전하다는 뜻이 아닙니다. 중요하다면 먼저 설명을 요청하세요.`)),
      section("alternatives", "What if I do not agree?", "승인하지 않으면요?",
        input
          ? pick("Leave it unanswered to keep the work waiting, or ask the agent to clarify the question.", "답하지 않으면 작업은 계속 기다립니다. 질문이 어렵다면 쉬운 설명을 요청하세요.")
          : tool
            ? pick("Leave it pending while you ask questions. Rejecting the tool request cancels this work item.", "질문하는 동안 결정을 보류할 수 있습니다. 도구 요청을 거부하면 이 작업은 취소됩니다.")
            : pick("Ask for changes to send feedback to the worker, defer while you inspect, or reject to cancel this work item.", "수정 요청으로 보완할 점을 전달하거나 검토를 위해 보류할 수 있습니다. 거절하면 이 작업은 취소됩니다.")),
      section("recovery", "Can I undo it?", "되돌릴 수 있나요?",
        pick("Approval is not an undo guarantee. Check the specific recovery steps and limits before an irreversible action. The exact contents and identifiers remain below; a hash is a fingerprint that detects changes, not a quality score.",
          "승인했다고 되돌릴 수 있음이 보장되지는 않습니다. 되돌리기 어려운 작업은 복구 방법과 한계를 먼저 확인하세요. 정확한 내용과 식별값은 아래에 남아 있습니다. 해시는 내용이 바뀌었는지 확인하는 지문이지 품질 점수가 아닙니다.")),
    ],
  };
  if (detail === "concise") {
    explanation.sections = [
      explanation.sections[0]!, explanation.sections[2]!,
      section("evidence", "Evidence", "확인 근거", pick(
        `Verified execution/validation: ${executionEvidence}; producer claims: ${claimed}; failed criteria: ${failed}; unverified: ${unknown}. See exact evidence below.`,
        `실행·검증 성공 ${executionEvidence}건 / 제작자 주장 ${claimed}건 / 기준 실패 ${failed}건 / 미확인 ${unknown}건. 정확한 근거는 아래에서 확인하세요.`)),
      section("cautions", "Limits and alternatives", "주의사항과 선택지", [
        pick(`Blocking issues: ${blocking}; warnings: ${warnings}. Cost, data exposure and reversibility are not established; unknown is not safe or free.`,
          `승인 차단 ${blocking}건, 주의 ${warnings}건. 비용·데이터 노출·복구 가능성은 확정되지 않았습니다. 모른다고 안전하거나 무료인 것은 아닙니다.`),
        explanation.sections[5]!.text,
      ].join(" ")),
    ];
  }
  return explanation;
}
