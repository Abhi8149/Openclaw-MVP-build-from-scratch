import { getDb } from "./db";
import { randomUUID } from "crypto";

export interface Task {
    id: string;
    session_id: string;
    agent_role: string;
    status: string;
    validation_criteria: string;
    payload: string;
    created_at: string;
    updated_at: string;
}

/**
 * Add a new task to the SQLite queue.
 */
export function addTask(
    sessionId: string,
    agentRole: string,
    validationCriteria: string,
    payload: string
): Task {
    const db = getDb();
    const id = randomUUID();
    const status = "pending";

    db.prepare(`
        INSERT INTO tasks_queue (id, session_id, agent_role, status, validation_criteria, payload)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, agentRole, status, validationCriteria, payload);

    return {
        id,
        session_id: sessionId,
        agent_role: agentRole,
        status,
        validation_criteria: validationCriteria,
        payload,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
}

/**
 * Atomic Task Claiming (Fixes Race Conditions)
 * 
 * HOW IT WORKS:
 * 1. Single Statement Atomic Query: By using an UPDATE ... WHERE id = (SELECT ...) RETURNING * statement,
 *    SQLite executes the select and write within a single atomic lock phase. SQLite blocks other connections
 *    briefly (due to WAL and busy_timeout), updates the status to 'processing' instantly, and returns the row.
 * 2. RETURNING clause: Allows retrieving the exact task fields that were claimed, avoiding a secondary SELECT
 *    statement that could suffer from race conditions where another thread claimed the task in between.
 * 3. WAL Mode: Ensures that multiple concurrent reader threads can poll, while the writer thread is writing, 
 *    preventing database locks.
 */
export function claimNextTask(agentRole: string): Task | null {
    const db = getDb();
    let stmt;

    if (agentRole === "verifier") {
        // Verifier polls for any tasks currently pending_review
        stmt = db.prepare(`
            UPDATE tasks_queue
            SET status = 'processing', updated_at = CURRENT_TIMESTAMP
            WHERE id = (
                SELECT id FROM tasks_queue
                WHERE status = 'pending_review'
                ORDER BY created_at ASC
                LIMIT 1
            )
            RETURNING *;
        `);
        return stmt.get() as Task | null;
    } else if (agentRole === "tester") {
        // Tester polls for tasks approved by the verifier
        stmt = db.prepare(`
            UPDATE tasks_queue
            SET status = 'processing', updated_at = CURRENT_TIMESTAMP
            WHERE id = (
                SELECT id FROM tasks_queue
                WHERE status = 'approved_by_verifier'
                ORDER BY created_at ASC
                LIMIT 1
            )
            RETURNING *;
        `);
        return stmt.get() as Task | null;
    } else {
        // Generator roles claim tasks matching their role that are pending or need revisions
        stmt = db.prepare(`
            UPDATE tasks_queue
            SET status = 'processing', updated_at = CURRENT_TIMESTAMP
            WHERE id = (
                SELECT id FROM tasks_queue
                WHERE agent_role = ?
                  AND status IN ('pending', 'revision_requested')
                ORDER BY created_at ASC
                LIMIT 1
            )
            RETURNING *;
        `);
        return stmt.get(agentRole) as Task | null;
    }
}

/**
 * Update the status and payload of a task.
 */
export function updateTask(id: string, status: string, payload: string) {
    const db = getDb();
    db.prepare(`
        UPDATE tasks_queue
        SET status = ?, payload = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(status, payload, id);
}
