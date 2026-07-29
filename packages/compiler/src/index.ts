export { diffValues } from "./diff.ts";
export {
  applyFileTransaction,
  recoverFileTransactions,
  type FileTransactionInput,
  type RecoveryResult,
} from "./file-transaction.ts";
export {
  ApprovalRequiredError,
  InvalidOrgSpecError,
  applyInstallPlan,
  createInstallPlan,
  createRollbackPlan,
} from "./plan.ts";
export type {
  AppliedManifest,
  InstallOperation,
  InstallPlan,
  InstallPlanBody,
  PlanApproval,
  PlanInput,
  PlanWriter,
  Risk,
  RollbackPlan,
  RollbackPlanBody,
  SpecChange,
} from "./types.ts";
