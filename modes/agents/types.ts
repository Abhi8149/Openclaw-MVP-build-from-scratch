export type ActionType =
  | 'file_create'
  | 'file_modify'
  | 'file_delete'
  | 'folder_create'
  | 'code_analysis'
  | 'tool_execute';

export type ActionStatus = 'pending' | 'executed' | 'approved' | 'rejected';

// safe: read-only, already auto-executes and never reaches approval.
// low: reversible, low-blast-radius mutations (new file, small edit, empty folder).
// high: destructive or hard-to-predict (deletes, sensitive files, large edits, shell commands).
export type RiskTier = 'safe' | 'low' | 'high';

export interface ActionLog {
  id: string;
  timestamp: Date;
  type: ActionType;
  path: string;
  details: {
    before?: string;
    after?: string;
    toolName?: string;
    toolResult?: string;
    error?: string;
    command?: string;
  };
  status: ActionStatus;
  userApproved?: boolean;
  riskTier?: RiskTier;
  riskReason?: string;
  // Set for the small set of high-risk shell commands dangerous enough that
  // the approval UI should require typing "yes" rather than a menu pick.
  requiresTypedConfirmation?: boolean;
}

export interface AgentConfig {
  codebasePath: string;
  maxFileSizeToRead: number;
  excludePatterns: string[];
  tools: {
    allowShellExecution: boolean;
    allowFileModification: boolean;
    allowFileCreation: boolean;
    allowFolderCreation: boolean;
  };
  maxBudget: number; // Max budget in USD
  maxSelfHealingAttempts: number; // Max attempts to self-heal compiler/test errors
}

export const defaultAgentConfig = (): AgentConfig => ({
  codebasePath: process.cwd(),
  maxFileSizeToRead: 1024 * 1024 ,
  excludePatterns: [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    '*.log',
    '.env*',
  ],
  tools: {
    allowShellExecution: true,
    allowFileModification: true,
    allowFileCreation: true,
    allowFolderCreation: true,
  },
  maxBudget: 1.00, // Default budget $1.00 USD
  maxSelfHealingAttempts: 3,
});

export function isMutationType(t: ActionType): boolean {
  return (
    t === 'file_create' ||
    t === 'file_modify' ||
    t === 'file_delete' ||
    t === 'folder_create' ||
    t === 'tool_execute'
  );
}