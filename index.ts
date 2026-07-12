#!/usr/bin/env bun

import { Command } from "commander";
import { runWakeup } from "./tui/runWakeup";

const program= new Command();

program.name("Abhiclaw").description("Abhiclaw cli tool").version("0.0.1");

program.command("wakeup")
    .description("Show the banner and pick cli or telegram mode")
    .option("-g, --gui", "Run in visual GUI companion mode")
    .option("-b, --budget <budget>", "Max LLM API budget in USD", parseFloat)
    .action(async(opts)=>{
        await runWakeup(opts)
    });

await program.parseAsync(process.argv);

console.log("App initiated");

