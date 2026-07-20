import { Database } from "bun:sqlite";

let db: Database | null = null;

/**
 * Initialize and return the database instance with WAL mode enabled.
 * WAL (Write-Ahead Logging) is critical for allowing background workers
 * to concurrently read and write to the SQLite file without locks.
 */
export function getDb(): Database {
    if (db) return db;

    db = new Database("./agent-tasks.sqlite");
    
    // Enable Write-Ahead Logging (WAL) for high concurrency
    db.run("PRAGMA journal_mode = WAL;");
    
    // Set busy timeout to 5000ms so concurrent writes wait/retry instead of throwing lock errors immediately
    db.run("PRAGMA busy_timeout = 5000;");

    // Initialize the task queue table
    db.run(`
        CREATE TABLE IF NOT EXISTS tasks_queue (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            agent_role TEXT NOT NULL,
            status TEXT NOT NULL, -- pending, processing, pending_review, revision_requested, approved_by_verifier, completed
            validation_criteria TEXT NOT NULL,
            payload TEXT NOT NULL, -- JSON stringified input or code output
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    return db;
}
