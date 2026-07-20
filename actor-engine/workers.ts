import { claimNextTask, updateTask, type Task} from "./queue";
import chalk from "chalk";

/**
 * Reusable Agent Worker class.
 * Polls the SQLite task queue using the atomic claimNextTask function.
 */
export class Worker {
    role: string;
    pollIntervalMs: number;
    private isRunning: boolean = false;
    private handler: (task: Task) => Promise<{ status: string; payload: string }>;

    constructor(
        role: string,
        handler: (task: Task) => Promise<{ status: string; payload: string }>,
        pollIntervalMs = 1000
    ) {
        this.role = role;
        this.handler = handler;
        this.pollIntervalMs = pollIntervalMs;
    }

    /**
     * Start the polling loop.
     */
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(chalk.bold.green(`⚙️  Worker for [${this.role}] is now active and polling SQLite queue.`));
        this.pollLoop();
    }

    /**
     * Stop the polling loop.
     */
    stop() {
        this.isRunning = false;
        console.log(chalk.bold.red(`🛑 Worker for [${this.role}] has stopped.`));
    }

    private async pollLoop() {
        while (this.isRunning) {
            try {
                const task = claimNextTask(this.role);
                if (task) {
                    console.log(chalk.blue(`\n📥 [${this.role}] Worker claimed task ${task.id} (Session: ${task.session_id})`));
                    console.log(chalk.dim(`   Current status: processing`));

                    // Execute worker task handler logic
                    const result = await this.handler(task);
                    
                    // Update state in SQLite database
                    updateTask(task.id, result.status, result.payload);
                    console.log(chalk.green(`   Status updated to: ${result.status}`));
                }
            } catch (error) {
                console.error(chalk.red(`❌ [${this.role}] Worker execution error:`, error));
            }

            // Sleep interval before next poll
            await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        }
    }
}
