#!/usr/bin/env bun

import { Command } from "commander";
import { runWakeup } from "./tui/runWakeup";

const program= new Command();

program.name("Abhiclaw").description("Abhiclaw cli tool").version("0.0.1");

program.command("wakeup").description("Show the banner and pick cli or telgram mode").action(async()=>{
    await runWakeup()
});

await program.parseAsync(process.argv);

console.log("App initiated");
