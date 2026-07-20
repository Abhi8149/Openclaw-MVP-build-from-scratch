import { addTask, type Task } from "../actor-engine/queue";
import { getDb } from "../actor-engine/db";
import { Worker } from "../actor-engine/workers";
import chalk from "chalk";

async function runParallelTest() {
    console.log(chalk.bold.cyan("=== Concurrent Multi-Agent Queue Test ==="));

    // Reset task queue
    const db = getDb();
    db.run("DELETE FROM tasks_queue");

    // -------------------------------------------------------------
    // 1. GENERATOR AGENT A: Frontend Specialist
    // -------------------------------------------------------------
    const frontendAgent = new Worker("frontend", async (task: Task) => {
        console.log(chalk.yellow(`   [Frontend Agent] Generating UI components...`));
        const payload = { code: "<h1>Admin Dashboard</h1><button>Save</button>" };
        return {
            status: "pending_review",
            payload: JSON.stringify(payload)
        };
    });

    // -------------------------------------------------------------
    // 2. GENERATOR AGENT B: Database Specialist
    // -------------------------------------------------------------
    const databaseAgent = new Worker("database", async (task: Task) => {
        console.log(chalk.yellow(`   [Database Agent] Designing schema queries...`));
        const payload = { code: "CREATE TABLE users (id INTEGER PRIMARY KEY);" };
        return {
            status: "pending_review",
            payload: JSON.stringify(payload)
        };
    });

    // -------------------------------------------------------------
    // 3. SHARED AGENT C: Verifier (Code Reviewer)
    // -------------------------------------------------------------
    const verifierAgent = new Worker("verifier", async (task: Task) => {
        console.log(chalk.blue(`   [Verifier Agent] Reviewing task '${task.id}' for role '${task.agent_role}'...`));
        const data = JSON.parse(task.payload);
        
        let approved = false;
        if (task.agent_role === "frontend") {
            approved = data.code.includes("<h1>Admin Dashboard</h1>");
        } else if (task.agent_role === "database") {
            approved = data.code.includes("CREATE TABLE");
        }

        if (approved) {
            console.log(chalk.green(`   [Verifier Agent] Task '${task.id}' APPROVED.`));
            return { status: "approved_by_verifier", payload: task.payload };
        } else {
            console.log(chalk.red(`   [Verifier Agent] Task '${task.id}' REJECTED.`));
            return { status: "revision_requested", payload: JSON.stringify({ ...data, feedback: "Incorrect syntax." }) };
        }
    });

    // -------------------------------------------------------------
    // 4. SHARED AGENT D: Tester (Integration Builder)
    // -------------------------------------------------------------
    const testerAgent = new Worker("tester", async (task: Task) => {
        console.log(chalk.magenta(`   [Tester Agent] Testing task '${task.id}'...`));
        return { status: "completed", payload: task.payload };
    });

    // Start all concurrent workers
    frontendAgent.start();
    databaseAgent.start();
    verifierAgent.start();
    testerAgent.start();

    // -------------------------------------------------------------
    // 5. Enqueue tasks for different agents
    // -------------------------------------------------------------
    console.log(chalk.bold.green("\n[System] Enqueueing Frontend Task..."));
    const taskUI = addTask(
        "session-parallel-1",
        "frontend",
        "Must contain an h1 tag with 'Admin Dashboard'",
        JSON.stringify({ code: "" })
    );

    console.log(chalk.bold.green("[System] Enqueueing Database Task..."));
    const taskDB = addTask(
        "session-parallel-1",
        "database",
        "Must contain a CREATE TABLE sql statement",
        JSON.stringify({ code: "" })
    );

    // Monitor both tasks
    console.log(chalk.bold.cyan("\n[System] Monitoring concurrent tasks..."));
    let finished = false;
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const rowUI = db.query("SELECT status FROM tasks_queue WHERE id = ?").get(taskUI.id) as { status: string };
        const rowDB = db.query("SELECT status FROM tasks_queue WHERE id = ?").get(taskDB.id) as { status: string };

        console.log(chalk.gray(`[Queue Monitor] Time: ${i + 1}s | UI Task: ${rowUI.status} | DB Task: ${rowDB.status}`));

        if (rowUI.status === "completed" && rowDB.status === "completed") {
            console.log(chalk.bold.green("\n🎉 SUCCESS: Both specialized agents completed their tasks concurrently!"));
            finished = true;
            break;
        }
    }

    // Stop all workers
    frontendAgent.stop();
    databaseAgent.stop();
    verifierAgent.stop();
    testerAgent.stop();

    if (!finished) {
        process.exit(1);
    }
}

runParallelTest();
