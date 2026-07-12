import { diffLines } from "diff";
import type { ActionType, RiskTier } from "./types";

export const RISK_RANK: Record<RiskTier, number> = { safe: 0, low: 1, high: 2 };

export function maxRiskTier(tiers: RiskTier[]): RiskTier {
    let max: RiskTier = "safe";
    for (const t of tiers) if (RISK_RANK[t] > RISK_RANK[max]) max = t;
    return max;
}

export interface RiskClassification {
    tier: RiskTier;
    reason: string;
    requiresTypedConfirmation: boolean;
}

// Paths whose changes are risky even when the diff itself is tiny, because
// they control how the whole project builds, runs, ships, or authenticates.
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
    /(^|\/)\.env(\..*)?$/i,
    /(^|\/)package\.json$/i,
    /(^|\/)(package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml)$/i,
    /(^|\/)tsconfig.*\.json$/i,
    /(^|\/)\.github\/workflows\//i,
    /(^|\/)docker(file|-compose.*)?$/i,
    /(^|\/)\.git\//i,
];

// Substrings that make a shell command dangerous enough to always be "high"
// risk and require a typed confirmation, no matter what else it's chained
// with. Checked per-segment (see splitShellSegments) so a dangerous command
// can't hide behind a harmless one it's piped or `&&`-chained together with.
const DANGEROUS_SHELL_PATTERNS: RegExp[] = [
    /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\b/i,
    /\brimraf\b/i,
    /\bdel\s+\/[a-z]*[sf]/i,
    /\brd\s+\/s/i,
    /\bformat\s+[a-z]:/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bgit\s+push\b.*(--force|-f\b)/i,
    /\bgit\s+reset\s+--hard/i,
    /\bgit\s+clean\b[^\n]*-[a-z]*f/i,
    /\bsudo\b/i,
    /\bchmod\s+777\b/i,
    /\bcurl\b[^\n]*\|\s*(sh|bash)\b/i,
    /\bwget\b[^\n]*\|\s*(sh|bash)\b/i,
    />\s*\/dev\/(sd|nvme|disk)/i,
    /\bshutdown\b/i,
    /\breg\s+delete\b/i,
    /\bdrop\s+(table|database)\b/i,
    /\btruncate\s+table\b/i,
];

// Commands read-only / side-effect-free enough to fast-track as low risk
// instead of forcing the same scrutiny as an arbitrary shell invocation.
const SAFE_SHELL_PATTERNS: RegExp[] = [
    /^(ls|dir|pwd|echo|cat|type|which|where)\b/i,
    /^git\s+(status|diff|log|branch|show|remote)\b/i,
    /^(node|bun|npm|deno)\s+(-v|--version)\b/i,
    /^(bunx\s+)?tsc\s+--noEmit\b/i,
    /^bun\s+test\b/i,
];

const LARGE_DIFF_LINE_THRESHOLD = 40;

function isSensitivePath(relPath: string): boolean {
    const norm = relPath.replace(/\\/g, "/");
    return SENSITIVE_PATH_PATTERNS.some((p) => p.test(norm));
}

function countChangedLines(before: string, after: string): number {
    const parts = diffLines(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"));
    let changed = 0;
    for (const part of parts) {
        if (part.added || part.removed) changed += part.count ?? 0;
    }
    return changed;
}

function splitShellSegments(command: string): string[] {
    return command
        .split(/&&|\|\||[;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

export function classifyShellCommand(command: string): RiskClassification {
    const segments = splitShellSegments(command);

    for (const seg of segments) {
        for (const pattern of DANGEROUS_SHELL_PATTERNS) {
            if (pattern.test(seg)) {
                return {
                    tier: "high",
                    reason: `Command segment "${seg}" matches a known-dangerous pattern`,
                    requiresTypedConfirmation: true,
                };
            }
        }
    }

    const allSafe =
        segments.length > 0 && segments.every((seg) => SAFE_SHELL_PATTERNS.some((p) => p.test(seg)));
    if (allSafe) {
        return {
            tier: "low",
            reason: "Read-only / informational command",
            requiresTypedConfirmation: false,
        };
    }

    return {
        tier: "high",
        reason: "Shell commands can do anything, so they default to high risk unless explicitly known-safe",
        requiresTypedConfirmation: false,
    };
}

export function classifyFileMutation(
    type: ActionType,
    relPath: string,
    before: string | undefined,
    after: string | undefined,
): RiskClassification {
    if (type === "file_delete") {
        return {
            tier: "high",
            reason: "Deletion is destructive and only recoverable via git history",
            requiresTypedConfirmation: false,
        };
    }
    if (type === "folder_create") {
        return {
            tier: "low",
            reason: "Creating an empty folder has no destructive effect",
            requiresTypedConfirmation: false,
        };
    }
    if (isSensitivePath(relPath)) {
        return {
            tier: "high",
            reason: `${relPath} affects how the project builds, runs, or deploys`,
            requiresTypedConfirmation: false,
        };
    }
    if (type === "file_create") {
        return {
            tier: "low",
            reason: "New file — nothing existing is overwritten",
            requiresTypedConfirmation: false,
        };
    }

    // file_modify (includes edit_file)
    const changed = countChangedLines(before ?? "", after ?? "");
    if (changed > LARGE_DIFF_LINE_THRESHOLD) {
        return {
            tier: "high",
            reason: `Large change (${changed} lines touched, threshold is ${LARGE_DIFF_LINE_THRESHOLD})`,
            requiresTypedConfirmation: false,
        };
    }
    return {
        tier: "low",
        reason: `Small, reversible edit (${changed} line${changed === 1 ? "" : "s"} touched)`,
        requiresTypedConfirmation: false,
    };
}
