import type { ProposalProfile, TeamDesign } from "./proposal.ts";

export interface RenderTeamCharterInput {
  projectTitle: string;
  briefHash: string;
  profile: ProposalProfile;
  teamDesign: TeamDesign;
  approvalRequiredTools: string[];
}

const REDACTED_EMAIL = "[redacted-email]";
const REDACTED_PATH = "[redacted-path]";
const REDACTED_SECRET = "[redacted-secret]";

const WINDOWS_ABSOLUTE_PATH = /(?:^|\s)[A-Z]:[\\/]/iu;
const UNIX_USER_PATH = /(?:^|\s)\/(?:Users|home|root|var|etc|tmp|opt|mnt|private)\//iu;
const SECRET_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu;
const SECRET_JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/u;

function safeText(value: string, fallback = "not specified"): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return fallback;

  if (WINDOWS_ABSOLUTE_PATH.test(normalized) || UNIX_USER_PATH.test(normalized)) {
    return REDACTED_PATH;
  }
  if (SECRET_BEARER.test(normalized) || SECRET_JWT.test(normalized)) {
    return REDACTED_SECRET;
  }

  return normalized
    .replace(/[A-Z]:[\\/][^\s|`]+/giu, REDACTED_PATH)
    .replace(
      /\/(?:Users|home|root|var|etc|tmp|opt|mnt|private)\/[^\s|`]+/giu,
      REDACTED_PATH,
    )
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, REDACTED_EMAIL)
    .replace(
      /\b(?:sk|ghp|github_pat|AIza)[-_][A-Za-z0-9_-]{12,}\b/gu,
      REDACTED_SECRET,
    )
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+/giu,
      REDACTED_SECRET,
    )
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("`", "'")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeHash(value: string): string {
  return /^[a-f0-9]{64}$/iu.test(value) ? value.toLowerCase() : "unavailable";
}

function safeProjectTitle(value: string): string {
  const redacted = safeText(value, "Untitled project");
  if (redacted.startsWith("[redacted-")) return redacted;
  const allowlisted = redacted
    .replace(/[^\p{L}\p{M}\p{N} .,_+()\-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (allowlisted || "Untitled project").slice(0, 160);
}

function list(values: string[]): string {
  return values.length > 0 ? values.map((value) => safeText(value)).join(", ") : "none";
}

function stageTransitions(teamDesign: TeamDesign): Array<{
  from: string;
  to: string;
  afterStage: string;
  nextStage: string;
}> {
  const stages = new Map(teamDesign.stages.map((stage) => [stage.id, stage]));
  const seen = new Set<string>();
  const transitions: Array<{
    from: string;
    to: string;
    afterStage: string;
    nextStage: string;
  }> = [];

  for (const stage of teamDesign.stages) {
    if (stage.type !== "agent" || stage.owner === "human") continue;
    for (const dependencyId of stage.dependsOn) {
      const dependency = stages.get(dependencyId);
      if (
        !dependency ||
        dependency.type !== "agent" ||
        dependency.owner === "human" ||
        dependency.owner === stage.owner
      ) {
        continue;
      }
      const key = `${dependency.owner}:${stage.owner}:${dependency.id}:${stage.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      transitions.push({
        from: dependency.owner,
        to: stage.owner,
        afterStage: dependency.id,
        nextStage: stage.id,
      });
    }
  }
  return transitions;
}

function handoffPacket(
  briefHash: string,
  from: string,
  to: string,
  afterStage: string,
  nextStage: string,
): string[] {
  return [
    "```text",
    "[CHARTERMESH HANDOFF]",
    `PROJECT_REF: sha256:${briefHash}`,
    `FROM_ROLE: ${safeText(from)}`,
    `TO_ROLE: ${safeText(to)}`,
    `COMPLETED_STAGE: ${safeText(afterStage)}`,
    `REQUESTED_STAGE: ${safeText(nextStage)}`,
    "WORK_ITEM_ID: <Control Plane WorkItem ID>",
    "DECISION_CONTRACT: <decision question and acceptance criteria>",
    "COMPLETED_SCOPE: <what was completed; do not paste private prompt history>",
    "ARTIFACT_REFS: <immutable artifact hashes or project-relative paths>",
    "EVIDENCE: <tests, citations, or review evidence>",
    "OPEN_RISKS: <known gaps, assumptions, and blockers>",
    "REQUESTED_NEXT_ACTION: <one bounded action for the receiving role>",
    "APPROVAL_STATUS: <not-required | pending | approved exact hash>",
    "[END CHARTERMESH HANDOFF]",
    "```",
  ];
}

/**
 * Renders a deterministic, human-readable operating charter from sanitized
 * project metadata. The project brief itself is deliberately not accepted.
 */
export function renderTeamCharter(input: RenderTeamCharterInput): string {
  const title = safeProjectTitle(input.projectTitle);
  const briefHash = safeHash(input.briefHash);
  const team = input.teamDesign;
  const transitions = stageTransitions(team);
  const approvalRequiredTools = [...new Set(input.approvalRequiredTools)]
    .map((tool) => safeText(tool))
    .sort((left, right) => left.localeCompare(right));
  const lines: string[] = [
    "# CharterMesh Team Charter",
    "",
    "## Mission and immutable reference",
    "",
    `- Project: ${title}`,
    `- Project brief reference: \`sha256:${briefHash}\``,
    `- Operating profile: \`${safeText(input.profile)}\``,
    `- Team template: \`${safeText(team.template)}\` (source: \`${safeText(team.source)}\`)`,
    `- Initial work owner: \`${safeText(team.entryRole)}\``,
    `- Approval-gated tools: ${approvalRequiredTools.length > 0 ? approvalRequiredTools.map((tool) => `\`${tool}\``).join(", ") : "none declared"}`,
    "- Privacy rule: this charter stores the brief hash and sanitized metadata, not the raw project brief.",
    "",
    "## Roles and responsibilities",
    "",
    "| Role ID | Name | Class | Mission | Capabilities |",
    "| --- | --- | --- | --- | --- |",
    ...team.roles.map(
      (role) =>
        `| \`${safeText(role.id)}\` | ${safeText(role.name)} | \`${safeText(role.class)}\` | ${safeText(role.mission)} | ${list(role.capabilities)} |`,
    ),
    "",
    "Role IDs are the stable routing keys. A display name or provider-native agent name does not change ownership.",
    "",
    "## Work allocation and operating rules",
    "",
    "| Order | Stage | Type | Owner | Depends on |",
    "| ---: | --- | --- | --- | --- |",
    ...team.stages.map(
      (stage, index) =>
        `| ${index + 1} | \`${safeText(stage.id)}\` (${safeText(stage.name)}) | \`${safeText(stage.type)}\` | \`${safeText(stage.owner)}\` | ${stage.dependsOn.length > 0 ? stage.dependsOn.map((id) => `\`${safeText(id)}\``).join(", ") : "none"} |`,
    ),
    "",
    "1. The Control Plane WorkItem and decision contract are the mutable source of truth; chat messages and this charter are not a second task ledger.",
    "2. Every assignment names one owner role, bounded scope, required output, acceptance criteria, and evidence. The receiving role rejects an incomplete handoff instead of guessing.",
    "3. A stage starts only after its dependencies have produced referenced evidence. Parallel work is allowed only for independent scopes with explicit ownership.",
    "4. The sender reports unresolved risks and transfers artifact references, not private prompt history, credentials, or unrelated project data.",
    "5. A verifier may recommend acceptance but cannot replace the human approval required by policy.",
    "6. Organization, role, workflow, or approval-rule changes require a new exact plan hash and human approval.",
    `7. Kickoff creates one initial WorkItem owned by \`${safeText(team.entryRole)}\`, not one WorkItem per declared stage. Other roles use the packets below as bounded read-only consultations unless the Control Plane separately assigns them their own WorkItem. They must not claim or mutate the entry role's WorkItem.`,
    "",
    "## Copy/paste inter-team handoffs",
    "",
    "The default transport is manual copy/paste: copy the complete packet into the receiving agent session and record the resulting evidence in the Control Plane.",
    "",
  ];

  if (transitions.length === 0) {
    lines.push(
      "### Reusable role-to-role packet",
      "",
      ...handoffPacket(
        briefHash,
        "<sending role ID>",
        "<receiving role ID>",
        "<completed stage ID>",
        "<requested stage ID>",
      ),
      "",
    );
  } else {
    for (const transition of transitions) {
      lines.push(
        `### \`${safeText(transition.from)}\` → \`${safeText(transition.to)}\``,
        "",
        ...handoffPacket(
          briefHash,
          transition.from,
          transition.to,
          transition.afterStage,
          transition.nextStage,
        ),
        "",
      );
    }
  }

  lines.push(
    "### Human decision request packet",
    "",
    "By default, every request for human approval starts with a short, plain-language explanation (ELI5: understandable without technical experience), in the user's language. Use everyday words, short sentences, and define any unavoidable technical term. Be respectful, not childish. Respect an explicit concise or technical preference in .chartermesh/PREFERENCES.md while retaining exact scope, evidence, risks, and human approval. The same default applies to plans, tool permissions, final deliverables, and changes to this team.",
    "",
    "Explain what the person is deciding, why it matters, what approval will do, and what happens if they say no or wait. State costs, data sharing, uncertainty, risks, and what can or cannot be undone. If cost, evidence, or recovery is unknown, say so; never turn an unknown into 'free', 'safe', or 'reversible'. Separate the model's claims from checks actually confirmed by recorded evidence. Keep exact hashes, commands, paths, and evidence references unchanged in the technical section below; a simpler explanation does not replace them or grant extra permission.",
    "",
    "```text",
    "[CHARTERMESH APPROVAL REQUEST]",
    "IN EVERYDAY WORDS — write these explanations in the user's language",
    "What you are deciding: <one concrete choice, without jargon>",
    "Why this matters: <how this helps the user's goal>",
    "If you approve: <exact action, affected people or files, and expected result>",
    "What the model says: <recommendation and reason; label unverified claims>",
    "What was checked: <confirmed evidence and what it actually proves; say when nothing was checked>",
    "Cost and data: <known charges or limits and data leaving the project; say unknown when not established>",
    "Risks and missing information: <what may go wrong and what is still unverified>",
    "If you say no or wait: <what stops or stays unchanged and any evidenced deadline>",
    "Can we undo it?: <recovery steps and limits; say unknown if recovery was not established>",
    "Your options: <approve this exact scope, request changes, reject, or wait as applicable>",
    "",
    "TECHNICAL DETAILS — keep exact references unchanged",
    `PROJECT_REF: sha256:${briefHash}`,
    "WORK_ITEM_ID: <Control Plane WorkItem ID>",
    "REQUESTING_ROLE: <role ID>",
    "DECISION_REQUIRED: <one concrete decision>",
    "OPTIONS: <bounded choices, including defer or reject where applicable>",
    "RECOMMENDATION_AND_REASON: <concise recommendation>",
    "USER_VISIBLE_IMPACT: <cost, data, external side effect, or commitment>",
    "EVIDENCE_REFS: <immutable artifact hashes>",
    "KNOWN_RISKS: <remaining risks and rollback limits>",
    "DECISION_PACKET_HASH: <current packet hash when required; binds the explanation and evidence to this decision>",
    "APPROVE_EXACT_HASH: <plan or artifact hash; never a vague approval>",
    "[END CHARTERMESH APPROVAL REQUEST]",
    "```",
    "",
    "## Human approval matrix",
    "",
    "| Decision or action | Human approval | Required request evidence |",
    "| --- | --- | --- |",
    "| Change the organization, roles, workflow, tools, budgets, or approval rules | Required before write | Exact plan hash and human-readable diff |",
    "| Publish, deploy, connect an account, create a cloud resource, spend money, or cause another external side effect | Required before action | Scope, destination, cost/data impact, evidence, and rollback limits |",
    "| Accept a final deliverable | Required | Exact immutable artifact hash and acceptance-criteria evidence |",
    "| Destructive action | Prohibited by this profile; approval alone does not enable it | A separately approved policy change would be required first |",
    `| Invoke a role approval-gated tool (${approvalRequiredTools.length > 0 ? approvalRequiredTools.map((tool) => `\`${tool}\``).join(", ") : "none currently declared"}) | ${approvalRequiredTools.length > 0 ? "Required for the exact tool call" : "Not applicable"} | Exact call hash, arguments, Decision Packet, scope, and expected side effect |`,
    "| Read-only inspection inside the approved project scope | Not required | Record findings and sources in the WorkItem evidence |",
    "| Routine work already bounded by an approved WorkItem and using no approval-gated tool | Not required again | Preserve ownership, limits, and evidence |",
    "",
    "Only the user or another explicitly authorized human can satisfy a human approval gate. Model review, host permission inheritance, or a verifier recommendation cannot do so.",
    "",
    "## Execution boundary",
    "",
    `- Boundary label: \`${safeText(team.executionBoundary)}\`.`,
    "- This charter is a team design, allocation contract, and handoff protocol. Declaring stages in OrgSpec does not by itself execute provider-native agents or automatically move work between them.",
    "- Inter-team stage handoffs remain explicit copy/paste consultations until a future workflow runtime binds each declared stage to governed WorkItem ownership. Host projection alone does not make that transition automatic.",
    "- Host projection may automate supported session or subagent mechanics. A consulting role may read the referenced bounded context and return a packet, but it may claim or mutate only a WorkItem separately assigned to its exact role. The CharterMesh Control Plane remains authoritative and all approval boundaries above remain in force.",
    "",
  );

  return `${lines.join("\n")}\n`;
}
