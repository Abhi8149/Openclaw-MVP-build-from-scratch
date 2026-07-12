import {select, isCancel} from "@clack/prompts";
import chalk from "chalk";
import figlet from "figlet";
import { exec } from "node:child_process";
import { runCliMode } from "../modes/cli";
import { GuiServer } from "../modes/agents/gui-server";
import { runAgentMode } from "../modes/agents/orchestrator";

const BANNER_FONT = 'ANSI Shadow';
const SHADOW = chalk.hex('#5b4d9e');
const FACE = chalk.hex('#e8dcf8').bold;

function printBannerWithShadow(ascii: string) {
  const bannerLines = ascii.replace(/\s+$/, '').split('\n');
  const maxLen = Math.max(...bannerLines.map((l) => l.length), 0);
  const rowWidth = maxLen + 2;

  for (const line of bannerLines) {
    console.log(SHADOW(('  ' + line).padEnd(rowWidth)));
  }
  process.stdout.write(`\x1b[${bannerLines.length}A`);
  for (const line of bannerLines) {
    console.log(FACE(line.padEnd(rowWidth)));
  }
  console.log();
}

function openUrl(url: string) {
  const start = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${start} ${url}`);
}

async function runWebUiMode(options?: { budget?: number }) {
  const guiServer = new GuiServer();
  const url = await guiServer.start(8000);
  console.log(chalk.bold.green(`\n🖥️  Visual Web Companion active at: ${url}\n`));
  
  // Auto-open browser
  openUrl(url);

  while (true) {
    // Wait for the next prompt from the browser
    const goal = await guiServer.waitForGoal();

    try {
      // Execute agent run with the goal in browser mode using the active server
      await runAgentMode({ gui: true, budget: options?.budget, goal, guiServer });
    } catch (err) {
      console.error("Web UI execution error:", err);
      guiServer.updateState((s) => {
        s.status = "failed";
        s.logs.push(`❌ Execution error: ${err}`);
      });
    }

    // Return to idle state for next prompt
    guiServer.updateState((s) => {
      s.status = "idle";
    });
  }
}

export async function runWakeup(options?: { gui?: boolean; budget?: number }){
    let ascii: string;
    try{
        ascii=figlet.textSync("AbhiClaw", {font: BANNER_FONT});
    }catch(error){
        ascii=figlet.textSync("AbhiClaw", {font:"Standard"})
    }

    printBannerWithShadow(ascii);

    const mode= await select({
        message:"Which mode do you want to proceed with?",
        options:[
            {value:"cli", label:"CLI (Terminal UI)"},
            {value:"web", label:"Web UI (Browser Chat Dashboard)"},
            {value:"telegram", label:"Telegram"},
            {value:"exit", label:"Exit"}
        ]
    });

    if (isCancel(mode) || mode === 'exit') {
        console.log(chalk.dim('\n Goodbye. \n'));
        return;
    }

    if(mode==='cli'){
      await runCliMode(options);
    }
    else if(mode==='web'){
      await runWebUiMode(options);
    }
    else if(mode==='telegram'){

    }
}