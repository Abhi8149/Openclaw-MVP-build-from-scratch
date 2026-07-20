import { Database } from "bun:sqlite";
import chalk from "chalk";

let db: Database | null = null;

/**
 * Initialize SQLite connection and set up schema if needed.
 */
export function initSqlite(): Database {
    if (db) return db;

    // Open/create database file
    db = new Database("./agent-tasks.sqlite");
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA busy_timeout = 5000;");

    // Define registry schema
    db.run(`
        CREATE TABLE IF NOT EXISTS model_registry (
            id TEXT PRIMARY KEY,
            capability_score INTEGER NOT NULL,
            cost_per_1k REAL NOT NULL
        );
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS task_categories (
            name TEXT PRIMARY KEY,
            min_capability INTEGER NOT NULL
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS model_excels_at (
            model_id TEXT,
            category_name TEXT,
            PRIMARY KEY (model_id, category_name),
            FOREIGN KEY(model_id) REFERENCES model_registry(id),
            FOREIGN KEY(category_name) REFERENCES task_categories(name)
        );
    `);

    // Seed registry data if empty
    const modelCount = db.query("SELECT COUNT(*) as count FROM model_registry").get() as { count: number };
    if (modelCount.count === 0) {
        console.log(chalk.yellow("⚠️  Model registry is empty in SQLite. Seeding models..."));
        
        // Insert models
        const insertModel = db.prepare("INSERT INTO model_registry (id, capability_score, cost_per_1k) VALUES (?, ?, ?)");
        insertModel.run("nemotron-3-ultra-550b-free", 95, 0.0);
        insertModel.run("llama-3.2-3b-instruct-free", 55, 0.0);
        insertModel.run("hy3-free", 90, 0.0);
        insertModel.run("laguna-m1-free", 70, 0.0);
        insertModel.run("north-mini-code-free", 75, 0.0);

        // Insert task categories
        const insertTask = db.prepare("INSERT INTO task_categories (name, min_capability) VALUES (?, ?)");
        insertTask.run("ComplexRefactor", 90);
        insertTask.run("SyntaxFix", 50);

        // Connect models to their ideal task categories
        const insertExcels = db.prepare("INSERT INTO model_excels_at (model_id, category_name) VALUES (?, ?)");
        insertExcels.run("nemotron-3-ultra-550b-free", "ComplexRefactor");
        insertExcels.run("hy3-free", "ComplexRefactor");
        insertExcels.run("north-mini-code-free", "SyntaxFix");
        
        console.log(chalk.green("✓ Model registry seeded successfully in SQLite."));
    }

    return db;
}

/**
 * Classify task complexity based on instructions/keywords.
 */
export function classifyTask(goal: string): string {
    const lowercase = goal.toLowerCase();
    
    // Keywords demanding high reasoning capabilities
    const criticalKeywords = [
        "refactor", "database", "schema", "rewrite", "migration", "architecture", 
        "compiler", "loop", "healing", "thread", "concurrency", "performance",
        "checkpoint", "rewind", "bug", "fix", "issue"
    ];
    
    // Keywords signifying simple operations
    const simpleKeywords = [
        "readme", "documentation", "doc", "comment", "style", "css", "color", 
        "hello", "print", "todo", "ignore"
    ];
    
    let score = 5.0; // Default baseline score (higher = simpler)
    
    // Adjust based on prompt length
    if (lowercase.length > 250) {
        score -= 2.0;
    } else if (lowercase.length < 50) {
        score += 2.0;
    }
    
    // Adjust based on critical keywords
    for (const cw of criticalKeywords) {
        if (lowercase.includes(cw)) {
            score -= 3.0;
        }
    }
    
    // Adjust based on simple keywords
    for (const sw of simpleKeywords) {
        if (lowercase.includes(sw)) {
            score += 3.0;
        }
    }
    
    return score <= 5.0 ? "ComplexRefactor" : "SyntaxFix";
}

/**
 * Execute dynamic routing query via relational SQL query.
 */
export function routeTask(taskName: string): string {
    const database = initSqlite();
    
    const query = `
        SELECT mr.id AS selected_model, mr.cost_per_1k AS cost
        FROM model_registry mr
        JOIN model_excels_at mea ON mr.id = mea.model_id
        JOIN task_categories tc ON mea.category_name = tc.name
        WHERE tc.name = ? AND mr.capability_score >= tc.min_capability
        ORDER BY mr.cost_per_1k ASC
        LIMIT 1;
    `;
    
    const result = database.query(query).get(taskName) as { selected_model: string; cost: number } | null;
    
    if (result) {
        return result.selected_model;
    }
    
    // Fallback model
    return "nvidia/nemotron-3-ultra-550b-free";
}
