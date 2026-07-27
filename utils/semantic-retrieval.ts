import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Database } from "bun:sqlite";

// Create/get database connection
let db: Database | null = null;
function getDb(codebasePath: string): Database {
    if (db) return db;
    const dbPath = path.join(codebasePath, "agent-index.db");
    db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA busy_timeout = 5000;");
    
    // Create the schema
    db.run(`
        CREATE TABLE IF NOT EXISTS code_index (
            file_path TEXT PRIMARY KEY,
            mtime REAL NOT NULL,
            skeleton_text TEXT NOT NULL,
            embedding TEXT, -- JSON array of floats or null if not embedded
            tokens TEXT NOT NULL -- JSON array of strings for TF-IDF fallback
        );
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS symbol_index (
            symbol_id TEXT PRIMARY KEY,
            file_path TEXT NOT NULL,
            symbol_name TEXT NOT NULL,
            symbol_type TEXT NOT NULL,
            symbol_text TEXT NOT NULL,
            embedding TEXT, -- JSON array of floats or null if not embedded
            tokens TEXT NOT NULL, -- JSON array of strings for TF-IDF fallback
            FOREIGN KEY(file_path) REFERENCES code_index(file_path) ON DELETE CASCADE
        );
    `);
    return db;
}

// Tree-sitter dynamic loading & fallback setup
let Parser: any = null;
let TypeScript: any = null;
let JavaScript: any = null;
let Python: any = null;
let TSX: any = null;
let Go: any = null;
let Rust: any = null;
let Java: any = null;
let Cpp: any = null;
let treeSitterInitialized = false;

function initTreeSitter() {
    if (treeSitterInitialized) return;
    try {
        Parser = require("tree-sitter");
        try { TypeScript = require("tree-sitter-typescript/typescript"); } catch {}
        try { JavaScript = require("tree-sitter-javascript"); } catch {}
        try { Python = require("tree-sitter-python"); } catch {}
        try { TSX = require("tree-sitter-typescript/tsx"); } catch {}
        try { Go = require("tree-sitter-go"); } catch {}
        try { Rust = require("tree-sitter-rust"); } catch {}
        try { Java = require("tree-sitter-java"); } catch {}
        try { Cpp = require("tree-sitter-cpp"); } catch {}
    } catch (err) {
        // Safe to ignore: native bindings are not compileable on Windows
    }
    treeSitterInitialized = true;
}

function extractSkeletonRegex(filePath: string, fileContent: string): string {
    let skeleton = `File: ${filePath}\n`;
    const ext = path.extname(filePath).toLowerCase();
    const lines = fileContent.split(/\r?\n/);
    
    const pyExts = [".py"];
    const jsExts = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
    const goExts = [".go"];
    const rsExts = [".rs"];
    const jvmExts = [".java", ".cs", ".kt", ".scala"];
    const cppExts = [".c", ".cpp", ".h", ".hpp", ".cc", ".cxx", ".hxx"];
    const phpExts = [".php"];
    const rbExts = [".rb"];
    const mdExts = [".md"];
    const cssExts = [".css", ".scss", ".sass", ".less"];
    const htmlExts = [".html", ".htm", ".xml"];
    
    let inMultiLineImport = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        if (pyExts.includes(ext)) {
            if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.startsWith("class ")) {
                const match = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
                if (match) skeleton += `- class.name: ${match[1]}\n`;
            } else if (trimmed.startsWith("def ")) {
                const match = trimmed.match(/^def\s+([A-Za-z0-9_]+)/);
                if (match) skeleton += `- function.name: ${match[1]}\n`;
            }
        } else if (jsExts.includes(ext)) {
            if (trimmed.startsWith("import ") || trimmed.startsWith("import{") || trimmed.includes("= require(")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.match(/\bclass\s+(\w+)/)) {
                const match = trimmed.match(/\bclass\s+(\w+)/);
                if (match) skeleton += `- class.name: ${match[1]}\n`;
            } else if (trimmed.match(/\bfunction\s+(\w+)/)) {
                const match = trimmed.match(/\bfunction\s+(\w+)/);
                if (match) skeleton += `- function.name: ${match[1]}\n`;
            } else if (trimmed.match(/\b(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*{/)) {
                const match = trimmed.match(/\b(?:async\s+)?(\w+)\s*\(/);
                if (match && match[1] && !["if", "for", "while", "switch", "catch"].includes(match[1])) {
                    skeleton += `- method.name: ${match[1]}\n`;
                }
            }
        } else if (goExts.includes(ext)) {
            if (trimmed.startsWith("import ") && trimmed.endsWith("(")) {
                inMultiLineImport = true;
                skeleton += `- import: ${trimmed}\n`;
            } else if (inMultiLineImport) {
                if (trimmed === ")") {
                    inMultiLineImport = false;
                } else {
                    skeleton += `- import: ${trimmed}\n`;
                }
            } else if (trimmed.startsWith("import ")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.startsWith("type ") && (trimmed.includes(" struct") || trimmed.includes(" interface"))) {
                const match = trimmed.match(/^type\s+(\w+)/);
                if (match) skeleton += `- type.name: ${match[1]}\n`;
            } else if (trimmed.startsWith("func ")) {
                const match = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)/);
                if (match) skeleton += `- function.name: ${match[1]}\n`;
            }
        } else if (rsExts.includes(ext)) {
            if (trimmed.startsWith("use ")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.match(/\b(?:struct|enum|trait|union)\s+(\w+)/)) {
                const match = trimmed.match(/\b(?:struct|enum|trait|union)\s+(\w+)/);
                if (match) skeleton += `- type.name: ${match[1]}\n`;
            } else if (trimmed.match(/\bfn\s+(\w+)/)) {
                const match = trimmed.match(/\bfn\s+(\w+)/);
                if (match) skeleton += `- function.name: ${match[1]}\n`;
            }
        } else if (jvmExts.includes(ext)) {
            if (trimmed.startsWith("import ") || trimmed.startsWith("using ")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.match(/\b(?:class|interface|enum)\s+(\w+)/)) {
                const match = trimmed.match(/\b(?:class|interface|enum)\s+(\w+)/);
                if (match) skeleton += `- class.name: ${match[1]}\n`;
            } else if (trimmed.match(/\b(?:public|private|protected|internal|static|\s)+\w+\s+(\w+)\s*\([^)]*\)/)) {
                const match = trimmed.match(/\b(?:public|private|protected|internal|static|\s)+\w+\s+(\w+)\s*\(/);
                if (match && match[1] && !["if", "for", "while", "switch", "catch"].includes(match[1])) {
                    skeleton += `- method.name: ${match[1]}\n`;
                }
            }
        } else if (cppExts.includes(ext)) {
            if (trimmed.startsWith("#include ")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.match(/\b(?:class|struct)\s+(\w+)/)) {
                const match = trimmed.match(/\b(?:class|struct)\s+(\w+)/);
                if (match) skeleton += `- class.name: ${match[1]}\n`;
            } else if (trimmed.match(/\b(\w+)\s*\([^)]*\)\s*(?:const)?\s*[{;]/)) {
                const match = trimmed.match(/\b(\w+)\s*\(/);
                if (match && match[1] && !["if", "for", "while", "switch", "catch"].includes(match[1])) {
                    skeleton += `- function.name: ${match[1]}\n`;
                }
            }
        } else if (phpExts.includes(ext)) {
            if (trimmed.startsWith("use ") || trimmed.startsWith("require") || trimmed.startsWith("include")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.match(/\b(?:class|interface|trait)\s+(\w+)/)) {
                const match = trimmed.match(/\b(?:class|interface|trait)\s+(\w+)/);
                if (match) skeleton += `- class.name: ${match[1]}\n`;
            } else if (trimmed.match(/\bfunction\s+(\w+)/)) {
                const match = trimmed.match(/\bfunction\s+(\w+)/);
                if (match) skeleton += `- function.name: ${match[1]}\n`;
            }
        } else if (rbExts.includes(ext)) {
            if (trimmed.startsWith("require ") || trimmed.startsWith("load ")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.match(/\b(?:class|module)\s+(\w+)/)) {
                const match = trimmed.match(/\b(?:class|module)\s+(\w+)/);
                if (match) skeleton += `- class.name: ${match[1]}\n`;
            } else if (trimmed.startsWith("def ")) {
                const match = trimmed.match(/^def\s+(\w+)/);
                if (match) skeleton += `- method.name: ${match[1]}\n`;
            }
        } else if (mdExts.includes(ext)) {
            if (trimmed.startsWith("#")) {
                skeleton += `- heading: ${trimmed}\n`;
            }
        } else if (cssExts.includes(ext)) {
            if (trimmed.startsWith("@import ")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.match(/^([.#][\w-]+)/)) {
                const match = trimmed.match(/^([.#][\w-]+)/);
                if (match) skeleton += `- selector: ${match[1]}\n`;
            }
        } else if (htmlExts.includes(ext)) {
            if (trimmed.includes("<title>")) {
                const match = trimmed.match(/<title>([^<]+)<\/title>/i);
                if (match) skeleton += `- title: ${match[1]}\n`;
            } else if (trimmed.includes("id=")) {
                const match = trimmed.match(/id=["']([^"']+)["']/);
                if (match) skeleton += `- element-id: ${match[1]}\n`;
            }
        } else {
            if (trimmed.startsWith("import ") || trimmed.startsWith("use ") || trimmed.startsWith("require ")) {
                skeleton += `- import: ${trimmed}\n`;
            } else if (trimmed.match(/\bclass\s+(\w+)/)) {
                const match = trimmed.match(/\bclass\s+(\w+)/);
                if (match) skeleton += `- class.name: ${match[1]}\n`;
            } else if (trimmed.match(/\bfunction\s+(\w+)/)) {
                const match = trimmed.match(/\bfunction\s+(\w+)/);
                if (match) skeleton += `- function.name: ${match[1]}\n`;
            }
        }
    }
    return skeleton;
}

export function extractSkeleton(filePath: string, fileContent: string): string {
    initTreeSitter();
    
    const ext = path.extname(filePath).toLowerCase();
    let lang: any = null;
    if (Parser) {
        if (ext === ".ts") lang = TypeScript;
        else if (ext === ".tsx") lang = TSX || TypeScript;
        else if (ext === ".js" || ext === ".jsx") lang = JavaScript;
        else if (ext === ".py") lang = Python;
        else if (ext === ".go") lang = Go;
        else if (ext === ".rs") lang = Rust;
        else if (ext === ".java") lang = Java;
        else if (ext === ".cpp" || ext === ".cc" || ext === ".h") lang = Cpp;
    }
    
    if (Parser && lang) {
        try {
            const parser = new Parser();
            parser.setLanguage(lang);
            const tree = parser.parse(fileContent);
            let skeleton = `File: ${filePath}\n`;
            
            let queryStr = "";
            if (lang === Python) {
                queryStr = `
                    (class_definition name: (identifier) @class.name)
                    (function_definition name: (identifier) @function.name)
                    (import_statement) @import
                    (import_from_statement) @import
                `;
            } else if (lang === Go) {
                queryStr = `
                    (function_declaration name: (identifier) @function.name)
                    (method_declaration name: (field_identifier) @method.name)
                    (type_declaration (type_spec name: (type_identifier) @class.name))
                    (import_declaration) @import
                `;
            } else if (lang === Rust) {
                queryStr = `
                    (function_item name: (identifier) @function.name)
                    (struct_item name: (type_identifier) @class.name)
                    (enum_item name: (type_identifier) @class.name)
                    (trait_item name: (type_identifier) @class.name)
                    (use_declaration) @import
                `;
            } else if (lang === Java) {
                queryStr = `
                    (class_declaration name: (identifier) @class.name)
                    (interface_declaration name: (identifier) @class.name)
                    (method_declaration name: (identifier) @method.name)
                    (import_declaration) @import
                `;
            } else if (lang === Cpp) {
                queryStr = `
                    (class_specifier name: (type_identifier) @class.name)
                    (struct_specifier name: (type_identifier) @class.name)
                    (function_definition declarator: (function_declarator declarator: (field_identifier) @method.name))
                    (function_definition declarator: (function_declarator declarator: (identifier) @function.name))
                    (preproc_include) @import
                `;
            } else {
                queryStr = `
                    (class_declaration name: [(type_identifier) (identifier)] @class.name)
                    (function_declaration name: (identifier) @function.name)
                    (method_definition name: [(property_identifier) (identifier)] @method.name)
                    (import_statement) @import
                `;
            }
            
            const query = new Parser.Query(lang, queryStr);
            const matches = query.matches(tree.rootNode);
            
            for (const match of matches) {
                for (const capture of match.captures) {
                    skeleton += `- ${capture.name}: ${capture.node.text}\n`;
                }
            }
            return skeleton;
        } catch (err) {
            // fallback if query/parser fails
        }
    }
    
    return extractSkeletonRegex(filePath, fileContent);
}

export interface SymbolDefinition {
    name: string;
    type: string;
    text: string;
}

export function extractSymbols(filePath: string, fileContent: string): SymbolDefinition[] {
    initTreeSitter();
    const ext = path.extname(filePath).toLowerCase();
    let lang: any = null;
    if (Parser) {
        if (ext === ".ts") lang = TypeScript;
        else if (ext === ".tsx") lang = TSX || TypeScript;
        else if (ext === ".js" || ext === ".jsx") lang = JavaScript;
        else if (ext === ".py") lang = Python;
        else if (ext === ".go") lang = Go;
        else if (ext === ".rs") lang = Rust;
        else if (ext === ".java") lang = Java;
        else if (ext === ".cpp" || ext === ".cc" || ext === ".h") lang = Cpp;
    }

    const symbols: SymbolDefinition[] = [];

    if (Parser && lang) {
        try {
            const parser = new Parser();
            parser.setLanguage(lang);
            const tree = parser.parse(fileContent);

            let queryStr = "";
            if (lang === Python) {
                queryStr = `
                    (class_definition name: (identifier) @class.name) @class
                    (function_definition name: (identifier) @function.name) @function
                `;
            } else if (lang === Go) {
                queryStr = `
                    (function_declaration name: (identifier) @function.name) @function
                    (method_declaration name: (field_identifier) @method.name) @method
                    (type_declaration (type_spec name: (type_identifier) @class.name)) @class
                `;
            } else if (lang === Rust) {
                queryStr = `
                    (function_item name: (identifier) @function.name) @function
                    (struct_item name: (type_identifier) @class.name) @class
                    (enum_item name: (type_identifier) @class.name) @class
                    (trait_item name: (type_identifier) @class.name) @class
                `;
            } else if (lang === Java) {
                queryStr = `
                    (class_declaration name: (identifier) @class.name) @class
                    (interface_declaration name: (identifier) @class.name) @class
                    (method_declaration name: (identifier) @method.name) @method
                `;
            } else if (lang === Cpp) {
                queryStr = `
                    (class_specifier name: (type_identifier) @class.name) @class
                    (struct_specifier name: (type_identifier) @class.name) @class
                    (function_definition declarator: (function_declarator declarator: (field_identifier) @method.name)) @method
                    (function_definition declarator: (function_declarator declarator: (identifier) @function.name)) @function
                `;
            } else {
                queryStr = `
                    (class_declaration name: [(type_identifier) (identifier)] @class.name) @class
                    (function_declaration name: (identifier) @function.name) @function
                    (method_definition name: [(property_identifier) (identifier)] @method.name) @method
                `;
            }

            const query = new Parser.Query(lang, queryStr);
            const matches = query.matches(tree.rootNode);

            for (const match of matches) {
                let nameNode: any = null;
                let defNode: any = null;
                let typeStr = "symbol";

                for (const capture of match.captures) {
                    if (capture.name.endsWith(".name")) {
                        nameNode = capture.node;
                    } else {
                        defNode = capture.node;
                        typeStr = capture.name;
                    }
                }

                if (nameNode && defNode) {
                    symbols.push({
                        name: nameNode.text,
                        type: typeStr,
                        text: defNode.text
                    });
                }
            }
            return symbols;
        } catch (err) {
            // fallback to regex
        }
    }

    // Regex Fallback
    const lines = fileContent.split(/\r?\n/);
    const pyExts = [".py"];
    const jsExts = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
    const goExts = [".go"];
    const rsExts = [".rs"];
    const jvmExts = [".java", ".cs", ".kt", ".scala"];
    const cppExts = [".c", ".cpp", ".h", ".hpp", ".cc", ".cxx", ".hxx"];
    const phpExts = [".php"];
    const rbExts = [".rb"];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            if (pyExts.includes(ext)) {
                if (trimmed.startsWith("class ")) {
                    const match = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
                    if (match?.[1]) {
                        const block = extractBlockByIndent(lines, i);
                        symbols.push({ name: match[1], type: "class", text: block });
                    }
                } else if (trimmed.startsWith("def ")) {
                    const match = trimmed.match(/^def\s+([A-Za-z0-9_]+)/);
                    if (match?.[1]) {
                        const block = extractBlockByIndent(lines, i);
                        symbols.push({ name: match[1], type: "function", text: block });
                    }
                }
            } else if (jsExts.includes(ext)) {
                if (trimmed.match(/\bclass\s+(\w+)/)) {
                    const match = trimmed.match(/\bclass\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "class", text: block });
                    }
                } else if (trimmed.match(/\bfunction\s+(\w+)/)) {
                    const match = trimmed.match(/\bfunction\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "function", text: block });
                    }
                } else {
                    const match = trimmed.match(/(?:export\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*{/);
                    if (match?.[1] && !["if", "for", "while", "switch", "catch"].includes(match[1])) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "method", text: block });
                    }
                }
            } else if (goExts.includes(ext)) {
                if (trimmed.startsWith("type ") && (trimmed.includes(" struct") || trimmed.includes(" interface"))) {
                    const match = trimmed.match(/^type\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "class", text: block });
                    }
                } else if (trimmed.startsWith("func ")) {
                    const match = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "function", text: block });
                    }
                }
            } else if (rsExts.includes(ext)) {
                if (trimmed.match(/\b(?:struct|enum|trait|union)\s+(\w+)/)) {
                    const match = trimmed.match(/\b(?:struct|enum|trait|union)\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "class", text: block });
                    }
                } else if (trimmed.match(/\bfn\s+(\w+)/)) {
                    const match = trimmed.match(/\bfn\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "function", text: block });
                    }
                }
            } else if (jvmExts.includes(ext)) {
                if (trimmed.match(/\b(?:class|interface|enum)\s+(\w+)/)) {
                    const match = trimmed.match(/\b(?:class|interface|enum)\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "class", text: block });
                    }
                } else if (trimmed.match(/\b(?:public|private|protected|internal|static|\s)+\w+\s+(\w+)\s*\([^)]*\)/)) {
                    const match = trimmed.match(/\b(?:public|private|protected|internal|static|\s)+\w+\s+(\w+)\s*\(/);
                    if (match?.[1] && !["if", "for", "while", "switch", "catch"].includes(match[1])) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "method", text: block });
                    }
                }
            } else if (cppExts.includes(ext)) {
                if (trimmed.match(/\b(?:class|struct)\s+(\w+)/)) {
                    const match = trimmed.match(/\b(?:class|struct)\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "class", text: block });
                    }
                } else if (trimmed.match(/\b(\w+)\s*\([^)]*\)\s*(?:const)?\s*[{;]/)) {
                    const match = trimmed.match(/\b(\w+)\s*\(/);
                    if (match?.[1] && !["if", "for", "while", "switch", "catch"].includes(match[1])) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "function", text: block });
                    }
                }
            } else if (phpExts.includes(ext)) {
                if (trimmed.match(/\b(?:class|interface|trait)\s+(\w+)/)) {
                    const match = trimmed.match(/\b(?:class|interface|trait)\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "class", text: block });
                    }
                } else if (trimmed.match(/\bfunction\s+(\w+)/)) {
                    const match = trimmed.match(/\bfunction\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByBrace(lines, i);
                        symbols.push({ name: match[1], type: "function", text: block });
                    }
                }
            } else if (rbExts.includes(ext)) {
                if (trimmed.match(/\b(?:class|module)\s+(\w+)/)) {
                    const match = trimmed.match(/\b(?:class|module)\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByEnd(lines, i);
                        symbols.push({ name: match[1], type: "class", text: block });
                    }
                } else if (trimmed.startsWith("def ")) {
                    const match = trimmed.match(/^def\s+(\w+)/);
                    if (match?.[1]) {
                        const block = extractBlockByEnd(lines, i);
                        symbols.push({ name: match[1], type: "method", text: block });
                    }
                }
            }
        } catch {
            // Ignored, proceed to next line
        }
    }

    return symbols;
}

function extractBlockByIndent(lines: string[], startIdx: number): string {
    const startLine = lines[startIdx]!;
    const startIndent = startLine.match(/^[ \t]*/)?.[0].length ?? 0;
    const block: string[] = [startLine];

    for (let j = startIdx + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (!line.trim()) {
            block.push(line);
            continue;
        }
        const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
        if (indent <= startIndent) break;
        block.push(line);
    }
    return block.join("\n");
}

function extractBlockByBrace(lines: string[], startIdx: number): string {
    const block: string[] = [];
    let braceCount = 0;
    let foundBrace = false;

    for (let j = startIdx; j < lines.length; j++) {
        const line = lines[j]!;
        block.push(line);

        for (let c = 0; c < line.length; c++) {
            if (line[c] === "{") {
                braceCount++;
                foundBrace = true;
            } else if (line[c] === "}") {
                braceCount--;
            }
            if (foundBrace && braceCount === 0) {
                return block.join("\n");
            }
        }
    }
    return block.join("\n");
}

function extractBlockByEnd(lines: string[], startIdx: number): string {
    const block: string[] = [];
    let indentLevel = 0;

    for (let j = startIdx; j < lines.length; j++) {
        const line = lines[j]!;
        block.push(line);
        const trimmed = line.trim();

        if (trimmed.startsWith("class ") || trimmed.startsWith("def ") || trimmed.startsWith("module ") || trimmed.startsWith("if ") || trimmed.startsWith("unless ") || trimmed.startsWith("do ")) {
            indentLevel++;
        }
        if (trimmed === "end") {
            indentLevel--;
            if (indentLevel <= 0) return block.join("\n");
        }
    }
    return block.join("\n");
}

const STOP_WORDS = new Set([
    // English stop words
    "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "while",
    "in", "on", "at", "by", "with", "from", "to", "of", "about", "for", "of",
    "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "how", "what", "where", "why", "who", "which", "this",
    "that", "these", "those", "you", "your", "he", "she", "it", "they", "we",
    "i", "me", "my", "us", "our", "them", "their", "him", "her",
    // Common programming keywords to prevent matching generic syntax
    "import", "export", "from", "const", "let", "var", "function", "class",
    "return", "await", "async", "public", "private", "protected", "default",
    "string", "number", "boolean", "any", "void", "true", "false", "null", "undefined",
    "typeof", "instanceof", "new", "this", "super", "extends", "implements"
]);

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function computeLocalSimilarity(
    queryTokens: string[],
    docTokens: string[],
    idfFn: (term: string) => number
): number {
    const freqQ: Record<string, number> = {};
    const freqD: Record<string, number> = {};
    for (const t of queryTokens) freqQ[t] = (freqQ[t] || 0) + 1;
    for (const t of docTokens) freqD[t] = (freqD[t] || 0) + 1;
    console.log("TF-IDF is starting working !");
    const allTerms = new Set([...Object.keys(freqQ), ...Object.keys(freqD)]);
    let dotProduct = 0;
    let normQ = 0;
    let normD = 0;

    for (const term of allTerms) {
        const weight = idfFn(term);
        const valQ = (freqQ[term] || 0) * weight;
        const valD = (freqD[term] || 0) * weight;
        dotProduct += valQ * valD;
        normQ += valQ * valQ;
        normD += valD * valD;
    }
    if (normQ === 0 || normD === 0) return 0;
    return dotProduct / (Math.sqrt(normQ) * Math.sqrt(normD));
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        const a = vecA[i] ?? 0;
        const b = vecB[i] ?? 0;
        dotProduct += a * b;
        normA += a * a;
        normB += b * b;
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function fetchEmbeddingFromAPI(text: string, apiKey: string): Promise<number[]> {
    const modelsToTry = [
        "nvidia/llama-nemotron-embed-vl-1b-v2:free",
        "openai/text-embedding-3-small"
    ];

    let lastError: any = null;

    for (const model of modelsToTry) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 8000);

        try {
            const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: model,
                    input: text.slice(0, 8000)
                }),
                signal: controller.signal
            });

            clearTimeout(id);

            if (!res.ok) {
                const bodyText = await res.text().catch(() => "");
                throw new Error(`Embedding API for ${model} returned status ${res.status}: ${bodyText}`);
            }

            const data = (await res.json()) as any;
            if (!data.data?.[0]?.embedding) {
                throw new Error(`Invalid response shape from Embeddings API for ${model}`);
            }

            return data.data[0].embedding;
        } catch (err) {
            clearTimeout(id);
            lastError = err;
        }
    }

    throw lastError || new Error("Failed to fetch embedding from all attempted models");
}

function scanFiles(dir: string, baseDir: string, exclude: string[]): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

        const shouldExclude = exclude.some((p) => {
            if (p.includes("*")) {
                const regex = new RegExp("^" + p.replace(/\*/g, ".*") + "$");
                return regex.test(entry.name);
            }
            return relativePath.startsWith(p) || entry.name === p;
        });

        if (shouldExclude) continue;

        if (entry.isDirectory()) {
            results.push(...scanFiles(fullPath, baseDir, exclude));
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            const allowed = [".ts", ".js", ".tsx", ".jsx", ".md", ".json", ".css", ".html", ".txt"];
            if (allowed.includes(ext)) {
                results.push(fullPath);
            }
        }
    }
    return results;
}

function extractFilePaths(goal: string, codebasePath: string): string[] {
    const pathRegex = /(?:\.\/)?(?:[\w-]+\/)*[\w-]+\.\w{1,6}/g;
    const matches = goal.match(pathRegex) || [];
    
    const found: string[] = [];
    for (const match of matches) {
        const normalized = match.replace(/^\.\//, "");
        const fullPath = path.join(codebasePath, normalized);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            found.push(normalized);
        }
    }
    return found;
}

const MIN_SIMILARITY_SCORE = 0.15;

export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

let latestMatchedSymbolsText = "";

export function getLatestMatchedSymbols(): string {
    return latestMatchedSymbolsText;
}

export async function semanticSearch(
    goal: string,
    codebasePath: string,
    excludePatterns: string[]
): Promise<Array<{ path: string; content: string }>> {
    console.log(chalk.dim("🔍 Scanning codebase for intent-driven retrieval..."));
    
    const filePaths = scanFiles(codebasePath, codebasePath, excludePatterns);
    const database = getDb(codebasePath);
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    
    let useVectors = apiKey.length > 0;

    try {
        // Load current DB cache into memory
        const selectAll = database.query("SELECT file_path, mtime, skeleton_text, embedding, tokens FROM code_index");
        let dbRows: Array<{
            file_path: string;
            mtime: number;
            skeleton_text: string;
            embedding: string | null;
            tokens: string;
        }> = [];
        try {
            dbRows = selectAll.all() as any;
        } finally {
            selectAll.finalize();
        }

        const cache: Record<string, {
            mtime: number;
            skeleton_text: string;
            vector?: number[];
            tokens: string[];
        }> = {};

        for (const row of dbRows) {
            cache[row.file_path] = {
                mtime: row.mtime,
                skeleton_text: row.skeleton_text,
                vector: row.embedding ? JSON.parse(row.embedding) : undefined,
                tokens: JSON.parse(row.tokens)
            };
        }

        // Clean up old JSON cache if exists
        try {
            const oldJsonCache = path.join(codebasePath, ".openclaw-embeddings.json");
            if (fs.existsSync(oldJsonCache)) {
                fs.unlinkSync(oldJsonCache);
            }
        } catch {}

        // Phase 1: Update SQLite index with new/modified files
        const insert = database.prepare(`
            INSERT OR REPLACE INTO code_index (file_path, mtime, skeleton_text, embedding, tokens)
            VALUES (?, ?, ?, ?, ?)
        `);
        const deleteSymbols = database.prepare("DELETE FROM symbol_index WHERE file_path = ?");
        const insertSymbol = database.prepare(`
            INSERT OR REPLACE INTO symbol_index (symbol_id, file_path, symbol_name, symbol_type, symbol_text, embedding, tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        try {
            for (const file of filePaths) {
                const relPath = path.relative(codebasePath, file).replace(/\\/g, "/");
                const stat = fs.statSync(file);
                const mtime = stat.mtimeMs;

                const cached = cache[relPath];
                // Skip re-indexing only if the file hasn't changed AND we either don't need vectors or already have one.
                if (cached && cached.mtime === mtime && (!useVectors || cached.vector !== undefined)) {
                    continue;
                }

                const content = fs.readFileSync(file, "utf8").trim();
                if (!content) {
                    continue;
                }
                const skeleton = extractSkeleton(relPath, content);
                const tokens = tokenize(content); // Use full content tokens for local TF-IDF overlap fallback compatibility
                let vector: number[] | undefined;

                if (useVectors) {
                    try {
                        vector = await fetchEmbeddingFromAPI(skeleton, apiKey);
                    } catch (err) {
                        console.log(chalk.yellow(`⚠️ Embeddings API failed for ${relPath}: ${String(err)}. Switching to local fallback.`));
                        useVectors = false;
                    }
                }

                insert.run(
                    relPath,
                    mtime,
                    skeleton,
                    vector ? JSON.stringify(vector) : null,
                    JSON.stringify(tokens)
                );

                deleteSymbols.run(relPath);
                const symbols = extractSymbols(relPath, content);
                for (const sym of symbols) {
                    const symbolId = `${relPath}::${sym.type}::${sym.name}`;
                    const symTokens = tokenize(sym.text);
                    let symVector: number[] | undefined;
                    if (useVectors) {
                        try {
                            symVector = await fetchEmbeddingFromAPI(`${sym.type} ${sym.name}: ${sym.text}`, apiKey);
                        } catch {}
                    }
                    insertSymbol.run(
                        symbolId,
                        relPath,
                        sym.name,
                        sym.type,
                        sym.text,
                        symVector ? JSON.stringify(symVector) : null,
                        JSON.stringify(symTokens)
                    );
                }

                cache[relPath] = {
                    mtime,
                    skeleton_text: skeleton,
                    vector,
                    tokens
                };
            }
        } finally {
            insert.finalize();
            deleteSymbols.finalize();
            insertSymbol.finalize();
        }

        // Phase 2: Vectorize goal/intent or tokenize for term-frequency overlap
        let goalVector: number[] | undefined;
        const goalTokens = tokenize(goal);

        if (useVectors) {
            try {
                // Get vector of user query
                goalVector = await fetchEmbeddingFromAPI(goal, apiKey);
            } catch {
                useVectors = false;
            }
        }

        // Load symbols from DB first to calculate IDF frequency across both files and symbols
        const selectSymbols = database.query("SELECT symbol_id, file_path, symbol_name, symbol_type, symbol_text, embedding, tokens FROM symbol_index");
        let symRows: Array<{
            symbol_id: string;
            file_path: string;
            symbol_name: string;
            symbol_type: string;
            symbol_text: string;
            embedding: string | null;
            tokens: string;
        }> = [];
        try {
            symRows = selectSymbols.all() as any;
        } finally {
            selectSymbols.finalize();
        }

        // Calculate IDF weighting
        const docFreq: Record<string, number> = {};
        let docCount = 0;

        for (const item of Object.values(cache)) {
            docCount++;
            const unique = new Set(item.tokens);
            for (const term of unique) {
                docFreq[term] = (docFreq[term] || 0) + 1;
            }
        }

        for (const row of symRows) {
            docCount++;
            const unique = new Set(JSON.parse(row.tokens) as string[]);
            for (const term of unique) {
                docFreq[term] = (docFreq[term] || 0) + 1;
            }
        }

        const idf = (term: string): number => {
            const df = docFreq[term] || 0;
            if (df === 0) return 0;
            return Math.log(1 + docCount / df);
        };

        // Phase 3: Score files and symbols
        const scoredFiles: Array<{ relPath: string; score: number }> = [];

        for (const relPath of Object.keys(cache)) {
            const item = cache[relPath]!;
            const fullPath = path.join(codebasePath, relPath);
            if (!fs.existsSync(fullPath)) continue;

            let score = 0;
            if (useVectors && goalVector && item.vector) {
                score = cosineSimilarity(goalVector, item.vector);
            } else {
                score = computeLocalSimilarity(goalTokens, item.tokens, idf);
            }

            scoredFiles.push({ relPath, score });
        }

        scoredFiles.sort((a, b) => b.score - a.score);

        // Score symbols
        const scoredSymbols: Array<{
            symbolId: string;
            filePath: string;
            name: string;
            type: string;
            text: string;
            score: number;
        }> = [];

        for (const row of symRows) {
            const fullPath = path.join(codebasePath, row.file_path);
            if (!fs.existsSync(fullPath)) continue;

            const symVector = row.embedding ? JSON.parse(row.embedding) as number[] : undefined;
            const symTokens = JSON.parse(row.tokens) as string[];

            let score = 0;
            if (useVectors && goalVector && symVector) {
                score = cosineSimilarity(goalVector, symVector);
            } else {
                score = computeLocalSimilarity(goalTokens, symTokens, idf);
            }
            scoredSymbols.push({
                symbolId: row.symbol_id,
                filePath: row.file_path,
                name: row.symbol_name,
                type: row.symbol_type,
                text: row.symbol_text,
                score
            });
        }

        scoredSymbols.sort((a, b) => b.score - a.score);

        // Phase 4: Extract explicitly mentioned file paths from the goal
        const explicitPaths = extractFilePaths(goal, codebasePath);

        // Phase 5: Build final results
        const resultPaths = new Set<string>();
        const results: Array<{ path: string; content: string }> = [];

        // Always include explicitly mentioned files
        for (const ep of explicitPaths) {
            if (resultPaths.has(ep)) continue;
            resultPaths.add(ep);
            const fullPath = path.join(codebasePath, ep);
            results.push({
                path: ep,
                content: fs.readFileSync(fullPath, "utf8")
            });
            console.log(chalk.green(`   📌 Explicitly mentioned: ${ep}`));
        }

        // Add top matching symbols and their containing files
        const topSymbols = scoredSymbols.filter(s => s.score >= MIN_SIMILARITY_SCORE).slice(0, 3);
        if (topSymbols.length > 0) {
            latestMatchedSymbolsText = topSymbols.map(s => {
                return `--- Relevant Code Symbol: ${s.name} (${s.type}) in ${s.filePath} ---\n${s.text}`;
            }).join("\n\n");
            console.log(chalk.green(`   🎯 Found ${topSymbols.length} highly relevant code symbols!`));

            for (const sym of topSymbols) {
                if (resultPaths.has(sym.filePath)) continue;
                if (results.length >= 3) break;
                resultPaths.add(sym.filePath);
                const fullPath = path.join(codebasePath, sym.filePath);
                results.push({
                    path: sym.filePath,
                    content: fs.readFileSync(fullPath, "utf8")
                });
                console.log(chalk.green(`   📌 Added containing file for symbol: ${sym.filePath}`));
            }
        } else {
            latestMatchedSymbolsText = "";
        }

        // Add scored files that pass the minimum threshold (up to 3 total)
        const filteredBeforeThreshold = scoredFiles.slice(0, 3);
        const filteredAfterThreshold = filteredBeforeThreshold.filter(f => f.score >= MIN_SIMILARITY_SCORE);
        
        if (filteredAfterThreshold.length < filteredBeforeThreshold.length) {
            const droppedCount = filteredBeforeThreshold.length - filteredAfterThreshold.length;
            console.log(chalk.dim(`   ⏭️  Skipped ${droppedCount} file(s) below similarity threshold (${MIN_SIMILARITY_SCORE})`));
        }

        for (const f of filteredAfterThreshold) {
            if (resultPaths.has(f.relPath)) continue;
            if (results.length >= 3) break;
            resultPaths.add(f.relPath);
            const fullPath = path.join(codebasePath, f.relPath);
            results.push({
                path: f.relPath,
                content: fs.readFileSync(fullPath, "utf8")
            });
        }

        console.log(chalk.cyan(`🎯 Intent-driven retrieval found ${results.length} semantically related files:`));
        for (const f of results) {
            const scoreEntry = scoredFiles.find(s => s.relPath === f.path);
            const scoreStr = scoreEntry ? ` (score: ${scoreEntry.score.toFixed(3)})` : " (explicit/symbol match)";
            console.log(chalk.cyan(`   • ${f.path}${scoreStr}`));
        }

        if (results.length === 0) {
            console.log(chalk.dim("   (No files matched above threshold. The agent will use its tools to find relevant files.)"));
        }

        return results;
    } finally {
        closeDb();
    }
}
