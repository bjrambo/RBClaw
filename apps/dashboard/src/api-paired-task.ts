export interface DashboardPairedTask {
  id: string;
  title: string | null;
  status: string;
  roundTripCount: number;
  supervisorState?: string;
  episodeNumber?: number;
  episodeRoundTrips?: number;
  totalRoundTrips?: number;
  arbitrationCount?: number;
  stagnationCount?: number;
  lastBlockerClass?: string | null;
  resumeAt?: string | null;
  progressFingerprintPrefix?: string | null;
  supervisorStateChangedAt?: string | null;
  updatedAt: string;
  currentTurn: {
    turnId: string;
    role: string;
    intentKind: string;
    state: string;
    attemptNo: number;
    executorServiceId: string | null;
    executorAgentType: string | null;
    activeRunId: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    lastError: string | null;
    progressText: string | null;
    progressUpdatedAt: string | null;
  } | null;
  outputs: Array<{
    id: number;
    turnNumber: number;
    role: string;
    verdict: string | null;
    createdAt: string;
    outputText: string;
    attachments?: Array<{
      path: string;
      name?: string;
      mime?: string;
    }>;
  }>;
}
