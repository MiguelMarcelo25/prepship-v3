import type { BestRateWorkflowDto } from './best-rate-workflow-dto';

export type ShippingWorkflowRateState =
  | 'ready'
  | 'missing_dims'
  | 'missing_weight'
  | 'queued'
  | 'running'
  | 'partial'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'stale'
  | 'proof_mismatch'
  | 'blocked';

export type ShippingWorkflowSelectedRateProofState =
  | 'current'
  | 'missing'
  | 'stale'
  | 'mismatched'
  | 'not_required_for_test';

export type ShippingWorkflowNextAction =
  | 'add_dims'
  | 'queue_rate_refresh'
  | 'retry_rates'
  | 'open_rate_browser'
  | 'send_to_print_queue'
  | null;

export type ShippingWorkflowStateDto = {
  rateState: ShippingWorkflowRateState;
  displayRate: Record<string, unknown> | null;
  selectedRateProofState: ShippingWorkflowSelectedRateProofState;
  canPrintQueue: boolean;
  printQueueBlockedReason: string | null;
  nextAction: ShippingWorkflowNextAction;
  diagnostics: {
    source: 'ps-349-order-shipping-state';
    bestRateState: string | null;
    rowRateState: string | null;
    queueState: string | null;
    hasDisplayRate: boolean;
    canDisplayFinalRate: boolean;
    canUseDisplayedRateForPurchase: boolean;
  };
};

export type BuildOrderShippingWorkflowStateInput = {
  bestRateWorkflow: BestRateWorkflowDto | null | undefined;
  displayRate: Record<string, unknown> | null;
  hasCompleteDims: boolean;
  hasWeight: boolean;
  isTest: boolean;
};

function proofStateFor(input: BuildOrderShippingWorkflowStateInput): ShippingWorkflowSelectedRateProofState {
  const workflow = input.bestRateWorkflow;
  if (input.isTest) return 'not_required_for_test';
  if (!workflow || !input.displayRate) return 'missing';
  if (workflow.canUseDisplayedRateForPurchase === true) return 'current';
  if (workflow.bestRateState === 'mismatched_request') return 'mismatched';
  if (workflow.bestRateState === 'missing' || workflow.bestRateState === 'unknown') return 'missing';
  return 'stale';
}

function rateStateFor(input: BuildOrderShippingWorkflowStateInput): ShippingWorkflowRateState {
  const workflow = input.bestRateWorkflow;
  if (!input.hasCompleteDims) return 'missing_dims';
  if (!input.hasWeight) return 'missing_weight';
  if (!workflow) return 'failed_retryable';
  if (workflow.canDisplayFinalRate === true && input.displayRate) return 'ready';
  if (workflow.activeRateCheckState === 'pending' || workflow.activeRateCheckState === 'rating') return 'running';
  switch (workflow.bestRateState) {
    case 'fresh':
      return input.displayRate ? 'ready' : 'failed_retryable';
    case 'pending':
    case 'rating':
      return 'running';
    case 'stale':
      return 'stale';
    case 'mismatched_request':
      return 'proof_mismatch';
    case 'partial_carrier_failure':
      return 'partial';
    case 'blocked':
      return 'blocked';
    case 'missing':
    case 'unknown':
    default:
      return 'failed_retryable';
  }
}

function nextActionFor(
  state: ShippingWorkflowRateState,
  canPrintQueue: boolean,
): ShippingWorkflowNextAction {
  if (canPrintQueue) return 'send_to_print_queue';
  switch (state) {
    case 'missing_dims':
    case 'missing_weight':
      return 'add_dims';
    case 'running':
      return 'queue_rate_refresh';
    case 'ready':
    case 'stale':
    case 'proof_mismatch':
      return 'retry_rates';
    case 'partial':
    case 'failed_retryable':
    case 'blocked':
      return 'open_rate_browser';
    default:
      return null;
  }
}

function printQueueBlockedReasonFor(input: {
  workflow: BestRateWorkflowDto | null | undefined;
  rateState: ShippingWorkflowRateState;
  canPrintQueue: boolean;
}): string | null {
  if (input.canPrintQueue) return null;
  const blockedReasons = input.workflow?.blockedReasons ?? {};
  const explicit = blockedReasons.printToQueue;
  if (explicit) return explicit;
  switch (input.rateState) {
    case 'missing_dims':
    case 'missing_weight':
      return 'missing_dims';
    case 'stale':
    case 'proof_mismatch':
    case 'running':
      return 'needs_current_rate';
    case 'partial':
    case 'failed_retryable':
    case 'failed_terminal':
      return 'no_rate';
    case 'blocked':
      return 'rate_not_final';
    default:
      return 'needs_current_rate';
  }
}

export function buildOrderShippingWorkflowState(
  input: BuildOrderShippingWorkflowStateInput,
): ShippingWorkflowStateDto {
  const workflow = input.bestRateWorkflow;
  const rateState = rateStateFor(input);
  const canPrintQueue =
    workflow?.allowedActions?.canPrintToQueue === true ||
    workflow?.allowedActions?.canQueueLabel === true;
  return {
    rateState,
    displayRate: input.displayRate,
    selectedRateProofState: proofStateFor(input),
    canPrintQueue,
    printQueueBlockedReason: printQueueBlockedReasonFor({ workflow, rateState, canPrintQueue }),
    nextAction: nextActionFor(rateState, canPrintQueue),
    diagnostics: {
      source: 'ps-349-order-shipping-state',
      bestRateState: workflow?.bestRateState ?? null,
      rowRateState: workflow?.rateState ?? null,
      queueState: workflow?.queueState ?? null,
      hasDisplayRate: Boolean(input.displayRate),
      canDisplayFinalRate: workflow?.canDisplayFinalRate === true,
      canUseDisplayedRateForPurchase: workflow?.canUseDisplayedRateForPurchase === true,
    },
  };
}
