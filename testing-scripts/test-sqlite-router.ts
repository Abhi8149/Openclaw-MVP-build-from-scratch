import { initSqlite, classifyTask, routeTask } from "../ai/sqlite-router";
import chalk from "chalk";

async function runTests() {
    console.log(chalk.bold.blue("=== Running SQLite Model Router Integration Tests ==="));

    // Test 1: Task Classification
    console.log("\n--- Test 1: Task Classification ---");
    const complexGoal = "Please refactor the database schema and migrate user profiles.";
    const simpleGoal = "Fix a syntax typo in the index page readme file.";

    const category1 = classifyTask(complexGoal);
    const category2 = classifyTask(simpleGoal);

    console.log(`Goal: "${complexGoal}"`);
    console.log(`-> Classified as: ${chalk.green(category1)} (Expected: ComplexRefactor)`);

    console.log(`Goal: "${simpleGoal}"`);
    console.log(`-> Classified as: ${chalk.green(category2)} (Expected: SyntaxFix)`);

    // Test 2: Database Initialization and Dynamic Routing
    console.log("\n--- Test 2: Database Initialization and Routing ---");
    try {
        console.log("Initializing SQLite Database...");
        initSqlite();

        console.log("Routing ComplexRefactor...");
        const modelForComplex = routeTask(category1);
        console.log(`-> Routed ComplexRefactor to: ${chalk.bold.magenta(modelForComplex)} (Expected: nemotron-3-ultra-550b-free)`);

        console.log("Routing SyntaxFix...");
        const modelForSimple = routeTask(category2);
        console.log(`-> Routed SyntaxFix to: ${chalk.bold.magenta(modelForSimple)} (Expected: llama-3.2-3b-instruct-free)`);

        console.log(chalk.bold.green("\n✓ All SQLite Model Router integration tests passed successfully!"));
    } catch (error) {
        console.error(chalk.bold.red("\n❌ SQLite Model Router integration tests failed:"), error);
        process.exit(1);
    }
}

runTests();
