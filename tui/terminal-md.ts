import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";

// Flag to track marked initialization
let ready = false;

/**
 * Initializes the marked parser with custom premium theme settings for the CLI terminal.
 * Uses chalk hex colors for high-contrast, premium, and readable layouts.
 */
function ensureMarked(): void {
  if (ready) return;
  const w = Math.max(40, Math.min(process.stdout.columns || 80, 120));
  
  // Custom color tokens matching modern dark themes
  const purple = chalk.hex("#a855f7");
  const cyan = chalk.hex("#22d3ee");
  const indigo = chalk.hex("#818cf8");
  const gray = chalk.hex("#64748b");
  const boldWhite = chalk.bold.hex("#f8fafc");

  // Configure marked-terminal with the custom layout mapping
  //   @ts-ignore
  marked.use(markedTerminal({
    width: w,
    reflowText: true,
    heading: purple.bold,
    firstHeading: purple.underline.bold,
    blockquote: gray.italic,
    code: cyan,
    codespan: cyan.bgHex("#1e1b4b"),
    link: indigo.underline,
    href: indigo.italic,
    strong: boldWhite,
    em: chalk.italic,
    listitem: chalk.reset,
    hr: gray,
  }, {}));
  ready = true;
}

/**
 * Renders raw markdown text into fully formatted, colored terminal text.
 * @param source Raw markdown string.
 * @returns Fully formatted ANSI escape colored string.
 */
export function renderTerminalMarkdown(source: string): string {
  ensureMarked();
  return marked.parse(source.trimEnd(), { async: false }) as string;
}