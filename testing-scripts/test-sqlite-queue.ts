import { addTask, type Task } from "../actor-engine/queue";
import { getDb } from "../actor-engine/db";
import { Worker } from "../actor-engine/workers";
import chalk from "chalk";

async function runTest() {
    console.log(chalk.bold.cyan("=== SQLite Task Queue & Actor Engine Integration Test ==="));

    // Clear any existing tasks in the database for clean testing
    const db = getDb();
    db.run("DELETE FROM tasks_queue");

    let generatorRevisionCount = 0;

    // 1. Generator Worker (frontend role)
    // Listens for 'frontend' role. Handles initial 'pending' tasks AND 'revision_requested' tasks.
    const generatorWorker = new Worker("frontend", async (task: Task) => {
        generatorRevisionCount++;
        console.log(chalk.yellow(`   [Generator] Generating code. Revision count: ${generatorRevisionCount}`));
        
        let code = "";
        if (generatorRevisionCount === 1) {
            // First attempt: deliberately omit the button to trigger a revision loop failure
            code = "<html><header>Welcome</header><body>No button here yet</body></html>";
            console.log(chalk.yellow("   [Generator] Omitted button to test review failure."));
        } else {
            // Second attempt: fix the issue based on verifier feedback
            code = "<html><header>Welcome</header><body><button id='action'>Click Me</button></body></html>";
            console.log(chalk.yellow("   [Generator] Added button to pass verifier check."));
        }

        return {
            status: "pending_review",
            payload: JSON.stringify({ code, revisions: generatorRevisionCount })
        };
    });

    // 2. Verifier Worker (verifier role)
    // Listens for 'pending_review' status on any task.
    const verifierWorker = new Worker("verifier", async (task: Task) => {
        console.log(chalk.yellow(`   [Verifier] Reviewing code against criteria: "${task.validation_criteria}"`));
        const data = JSON.parse(task.payload);
        const code = data.code;

        // Strict verification loop logic
        const hasHeader = code.includes("<header>Welcome");
        const hasButton = code.includes("<button");

        if (hasHeader && hasButton) {
            console.log(chalk.green("   [Verifier] Code approved!"));
            return {
                status: "approved_by_verifier",
                payload: task.payload
            };
        } else {
            const feedback = `Failed validation: missing <button> tag. Current code: ${code}`;
            console.log(chalk.red(`   [Verifier] Rejected. Feedback: ${feedback}`));
            return {
                status: "revision_requested",
                payload: JSON.stringify({ ...data, feedback })
            };
        }
    });

    // 3. Tester Worker (tester role)
    // Listens for 'approved_by_verifier' status.
    const testerWorker = new Worker("tester", async (task: Task) => {
        console.log(chalk.yellow("   [Tester] Executing simulated terminal build 'npm run build'..."));
        
        // Simulate compiler step
        const isSuccessfulBuild = true;

        if (isSuccessfulBuild) {
            console.log(chalk.green("   [Tester] Build successful!"));
            return {
                status: "completed",
                payload: task.payload
            };
        } else {
            console.log(chalk.red("   [Tester] Build failed."));
            return {
                status: "revision_requested",
                payload: JSON.stringify({ ...JSON.parse(task.payload), error: "Compilation error: unexpected token" })
            };
        }
    });

    // Start polling loops for all workers
    generatorWorker.start();
    verifierWorker.start();
    testerWorker.start();

    // Add a sample task to the queue
    console.log(chalk.magenta("\n[System] Enqueueing new task 'Build Welcome Layout' for frontend..."));
    const task = addTask(
        "session-abc-123",
        "frontend",
        "Must contain a <header> tag with 'Welcome' and a <button> tag",
        JSON.stringify({ code: "", request: "Create frontpage header layout" })
    );

    // Monitor task queue lifecycle
    console.log(chalk.magenta("[System] Monitoring task queue execution..."));
    let finished = false;
    for (let i = 0; i < 15; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const row = db.prepare("SELECT * FROM tasks_queue WHERE id = ?").get(task.id) as Task;
        if (row) {
            console.log(chalk.gray(`[Queue Monitor] Time: ${i + 1}s | Status: ${chalk.bold(row.status)}`));
            if (row.status === "completed") {
                console.log(chalk.bold.green("\n🎉 SUCCESS: Task successfully navigated the Generator -> Verifier (rejected/revised) -> Tester state machine!"));
                console.log(chalk.dim("Final Payload:"), row.payload);
                finished = true;
                break;
            }
        }
    }

    // Stop polling loops
    generatorWorker.stop();
    verifierWorker.stop();
    testerWorker.stop();

    if (!finished) {
        console.error(chalk.bold.red("\n❌ Failure: Task failed to complete within the monitor window."));
        process.exit(1);
    }
}

runTest();
